import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execute, authority, token } from './admission-fixture.mjs'
import { enabledReceiver, receiver, worker, workerToken, runId, workerUrl } from './dispatch-fixture.mjs'

const enabled = enabledReceiver()
after(() => enabled.cleanup())
const binary = enabled.binary
const resultHeaders = result => Object.fromEntries(result.response.headers)
function healthy(result, dispatch) {
  assert.equal(result.response.status, 200)
  assert.equal(result.response.body, 'healthy')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['x-tick-dispatch'], dispatch)
  assert.ok(result.captured.length <= 1)
  return result
}

test('shipped receiver keeps unqualified dispatch disabled', () => {
  const result = execute()
  assert.equal(result.headers['x-tick-dispatch'], 'disabled')
  assert.equal(result.headers['x-tick-ack-latency-ms'], undefined)
  assert.deepEqual(result.outboundRequests, [])
  assert.ok(!result.trace.some(call => call.key === 'UPTIME_TICK_TOKEN'))
})

test('enabled Native dispatch uses one named backend and closed protocol headers', () => {
  const result = healthy(receiver(binary, { headers: {
    'x-tick-probe-token': token, authorization: 'caller override',
    'x-tick-invocation-id': 'caller override', 'x-tick-attempt': '999',
    'x-tick-source': 'caller override', 'x-tick-worker-url': 'https://evil.invalid/',
  } }), 'acked')
  assert.equal(result.headers['x-tick-ack-latency-ms'], '0')
  assert.equal(result.captured.length, 1)
  const request = result.captured[0]
  assert.equal(request.backend, 'uptime')
  assert.equal(request.url, workerUrl)
  assert.equal(request.method, 'POST')
  assert.deepEqual(Object.fromEntries(request.headers), {
    authorization: 'Bearer ' + workerToken, 'x-tick-invocation-id': runId,
    'x-tick-attempt': '1', 'x-tick-source': 'fastly-tick', 'content-type': 'application/json',
  })
  assert.deepEqual(JSON.parse(request.body.toString()), { worker: 'uptime', scheduledForMs: 60000 })
  assert.ok(!JSON.stringify(result.logs).includes(workerToken))
})

test('only exact 202 and matching ID ACK; response bodies are never inspected', () => {
  for (const fixture of [
    { status: 200, headers: { 'x-tick-invocation-id': runId } },
    { status: 201, headers: { 'x-tick-invocation-id': runId } },
    { status: 202 },
    { status: 202, headers: { 'x-tick-invocation-id': '' } },
    { status: 202, headers: { 'x-tick-invocation-id': 'uptime:slot:other' } },
    { status: 202, headers: { 'x-tick-invocation-id': runId + ',other' } },
    { status: 401 }, { status: 500 },
  ]) {
    const result = healthy(receiver(binary, { fixture: { ...fixture, body: runId } }), 'unacknowledged')
    assert.equal(result.captured.length, 1)
  }
  const result = healthy(receiver(binary, { fixture: { status: 202,
    headers: { 'x-tick-invocation-id': runId }, body: Buffer.from([0xff, 0x00]), bodyDelayMs: 60000 } }), 'acked')
  const kvBodies = new Set(result.calls.filter(call => call.stage === 'body_read').map(call => call.handle))
  assert.ok(result.trace.filter(call => call.module === 'fastly_http_body' && call.name === 'read').every(call => kvBodies.has(call.handle)), 'Only KV bodies may be read; never the ACK body')
})

test('auth, not-due, conflict and unknown claims cannot reach dispatch', () => {
  const rejected = receiver(binary, { headers: {} })
  assert.equal(rejected.response.status, 401)
  assert.deepEqual(rejected.captured, [])
  for (const options of [
    { state: authority({ version: 1, nextSweepAtMs: 100001 }) },
    { fault: stage => stage === 'insert' ? { kvError: 4 } : undefined },
    { fault: stage => stage === 'insert_wait' ? { status: 1 } : undefined },
  ]) {
    const result = receiver(binary, options)
    assert.equal(result.response.body, 'healthy')
    assert.deepEqual(result.captured, [])
    assert.equal(result.headers['x-tick-dispatch'], undefined)
  }
})

test('missing, short, excessive and injected worker secrets fail before fetch', () => {
  for (const workerSecret of ['', 'short', 'x'.repeat(257), workerToken + '\r\nx: bad', workerToken + ' ', workerToken + '雪']) {
    const result = healthy(receiver(binary, { workerSecret }), 'secret-unavailable')
    assert.deepEqual(result.captured, [])
    assert.equal(result.headers['x-tick-ack-latency-ms'], undefined)
  }
})

test('elapsed preparation leaves ACK, overhead and response reserve before send', () => {
  // Delay only worker credential preparation; slow probe auth now skips before KV.
  let secretsRead = 0
  const result = healthy(receiver(binary, {
    onSecretLookup() { secretsRead++ },
    realtimeClock() { return { nanoseconds: BigInt(100000 + (secretsRead > 1 ? 2500 : 0)) * 1000000n } },
  }), 'budget-exhausted')
  assert.deepEqual(result.captured, [])
  assert.equal(result.headers['x-tick-ack-latency-ms'], undefined)
})

test('deadline or unmeasurable ACK never accepted; no immediate retry', () => {
  for (const delayMs of [1000, 1500]) {
    const result = healthy(receiver(binary, { fixture: { delayMs } }), 'unacknowledged')
    assert.equal(result.headers['x-tick-dispatch-error'], 'timeout')
    assert.equal(result.headers['x-tick-ack-latency-ms'], undefined)
    assert.equal(result.monotonicMs, 1000)
    assert.equal(result.captured.length, 1)
  }
  healthy(receiver(binary, { fixture: { status: 202, headers: { 'x-tick-invocation-id': runId }, delayMs: 999 } }), 'acked')
  let calls = 0
  const result = healthy(receiver(binary, { realtimeClock() {
    calls++
    return calls === 9 ? { status: 1 } : { nanoseconds: 100000000000n }
  } }), 'clock-unavailable')
  assert.equal(result.headers['x-tick-ack-latency-ms'], undefined)
})

test('fetch errors return healthy, retain the claim and emit a closed warning', () => {
  for (const [fixture, reason] of [[{ sendStatus: 1 }, 'transport'],
    [{ transportStatus: 1 }, 'transport'], [{ delayMs: 1500 }, 'timeout']]) {
    const emitted = []
    const result = healthy(receiver(binary, { fixture, logEndpointFailure: false,
      onLogWrite(message) { emitted.push(message) } }), 'unacknowledged')
    assert.equal(result.headers['x-tick-dispatch-error'], reason)
    assert.equal(result.captured.length, 1)
    const warnings = emitted.filter(line => line.includes('fastly_tick.dispatch_error'))
    assert.equal(warnings.length, 1)
    assert.deepEqual(JSON.parse(warnings[0].slice(warnings[0].indexOf('{'))), {
      event: 'fastly_tick.dispatch_error', receiver: 'fastly-tick', reason,
    })
    for (const secret of [token, workerToken]) assert.ok(!emitted.some(line => line.includes(secret)))
  }
})

test('independent worker ACK follows durable receipt; repeat matches existing receipt', () => {
  const state = authority()
  const accepted = worker({ state })
  assert.equal(accepted.response.status, 202)
  assert.equal(resultHeaders(accepted)['x-tick-invocation-id'], runId)
  assert.equal(accepted.response.body, '')
  assert.ok(accepted.calls.some(call => call.stage === 'insert'))
  assert.ok(state.get('worker_state', 'fastly-tick-fixture/' + runId))
  const repeated = worker({ state })
  assert.equal(repeated.response.status, 202)
  assert.ok(repeated.calls.some(call => call.stage === 'lookup'))
  assert.deepEqual(accepted.outboundRequests, [])
})

test('independent worker rejects bad auth, protocol and payload without acceptance', () => {
  const base = { method: 'POST', path: '/__tick/run', headers: {
    authorization: 'Bearer ' + workerToken, 'x-tick-invocation-id': runId,
    'x-tick-attempt': '1', 'content-type': 'application/json',
  }, body: '{"worker":"uptime","scheduledForMs":60000}' }
  for (const [request, status] of [
    [{ ...base, headers: {} }, 401],
    [{ ...base, headers: { ...base.headers, authorization: 'Bearer wrong' } }, 401],
    [{ ...base, headers: { ...base.headers, 'x-tick-invocation-id': 'other' } }, 400],
    [{ ...base, headers: { ...base.headers, 'x-tick-attempt': '4' } }, 400],
    [{ ...base, body: 'not json' }, 400],
    [{ ...base, body: '{"worker":"other","scheduledForMs":60000}' }, 400],
  ]) {
    const result = worker({ request })
    assert.equal(result.response.status, status)
    assert.ok(!result.calls.some(call => call.stage === 'insert'))
  }
})

test('independent worker never ACKs failed or uncertain receipt persistence', () => {
  for (const fault of [
    stage => stage === 'body_new' ? { status: 1 } : undefined,
    stage => stage === 'insert_wait' ? { status: 1 } : undefined,
  ]) {
    const result = worker({ fault })
    assert.equal(result.response.status, 503)
    assert.equal(resultHeaders(result)['x-tick-invocation-id'], undefined)
  }
})
