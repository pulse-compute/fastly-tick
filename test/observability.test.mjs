import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { Readable } from 'node:stream'
import { collect, fromHeaders, normalize, parseEvent, summarize } from '../scripts/observe.mjs'
import { authority, execute, key, store, token } from './admission-fixture.mjs'
import { enabledReceiver, worker, workerToken, workerUrl } from './dispatch-fixture.mjs'
import { deliveryKey, entry, record, registry, registryState, seed } from './registry-fixture.mjs'

const enabled = enabledReceiver()
after(() => enabled.cleanup())
const events = result => result.logs.map(log => parseEvent(log.message)).filter(Boolean)
const outcome = result => fromHeaders(result.response.headers)
const status = (state, options = {}) => execute({ state, path: '/__tick/status', ...options })
const snapshot = (state, options) => {
  const result = status(state, options)
  assert.equal(result.response.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(result.outboundRequests, [])
  assert.ok(!result.calls.some(call => call.stage === 'insert'))
  assert.ok(!result.trace.some(call => call.module === 'fastly_secret_store' && call.key === 'UPTIME_TICK_TOKEN'))
  return { result, value: JSON.parse(result.response.body) }
}
function send(state, { fixture = { status: 202, headers: {} }, receive, ...options } = {}) {
  return execute({ binary: enabled.binary, state, nowMs: 60000, logEndpointFailure: false,
    secrets: { TICK_PROBE_TOKEN: token, UPTIME_TICK_TOKEN: workerToken }, fixtures: { [workerUrl]: fixture },
    onOutboundRequest(request) {
      fixture.headers = { 'x-tick-invocation-id': Object.fromEntries(request.headers)['x-tick-invocation-id'] }
      receive?.(request, fixture)
    }, ...options,
  })
}

test('status rejects invalid auth and worker selectors before KV; accepts no caller location authority', () => {
  for (const headers of [{}, { 'x-tick-probe-token': '' }, { 'x-tick-probe-token': 'wrong' },
    [['x-tick-probe-token', token], ['x-tick-probe-token', token]],
    { 'x-tick-probe-token': token, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['x-' + i, 'x'])) }]) {
    const result = status(authority(), { headers })
    assert.equal(result.response.status, 401)
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.logs, [])
  }
  for (const workerId of ['', '../sweep', 'a'.repeat(33), 'UPTIME', 'x\r\nsecret: value']) {
    const result = status(authority(), { headers: { 'x-tick-probe-token': token, 'x-tick-worker-id': workerId } })
    assert.equal(result.response.status, 400)
    assert.deepEqual(result.calls, [])
    assert.ok(!result.response.body.includes(workerId || 'secret'))
  }
  const duplicate = status(authority(), { headers: [['x-tick-probe-token', token], ['x-tick-worker-id', 'a'], ['x-tick-worker-id', 'b']] })
  assert.equal(duplicate.response.status, 400)
  assert.deepEqual(duplicate.calls, [])
  const { value } = snapshot(authority(), { headers: { 'x-tick-probe-token': token, 'fastly-pop': 'DEN' } })
  assert.equal(value.receiverPop, 'unavailable')
  assert.equal(value.liveGate, 'deferred')
})

test('status reads one sweep plus at most one worker, without changing state or echoing raw KV', () => {
  const state = authority({ version: 1, nextSweepAtMs: 75000, nextWorkerIndex: 1, hidden: 'secret-payload' })
  seed(state, deliveryKey('uptime'), record('uptime', { hidden: 'secret-payload' }))
  const before = [...state.stores.get(store)]
  const first = snapshot(state)
  assert.equal(first.value.sweepRead, 'found')
  assert.equal(first.value.nextSweepAtMs, 75000)
  assert.equal(first.value.deliveryRead, 'not-requested')
  assert.equal(first.result.calls.filter(call => call.stage === 'lookup').length, 1)
  for (const deliveryStatus of ['pending', 'acked', 'exhausted']) {
    const value = record('uptime', { status: deliveryStatus })
    delete value.droppedScheduledForMs // FT-04 compatibility.
    seed(state, deliveryKey('uptime'), value)
    const selected = snapshot(state, { headers: { 'x-tick-probe-token': token, 'x-tick-worker-id': 'uptime' } })
    assert.equal(selected.value.deliveryStatus, deliveryStatus)
    assert.equal(selected.value.droppedScheduledForMs, -1)
    assert.equal(selected.result.calls.filter(call => call.stage === 'lookup').length, 2)
    assert.deepEqual(selected.result.logs, [])
    assert.ok(!selected.result.response.body.includes('secret-payload'))
    assert.ok(!selected.result.response.body.includes(token))
  }
  assert.equal(state.get(store, key), before[0][1])
})

test('status labels invalid/failed reads and stops after a slow sweep read', () => {
  const headers = { 'x-tick-probe-token': token, 'x-tick-worker-id': 'uptime' }
  const state = seed(authority({ version: 2, nextSweepAtMs: 75000 }), deliveryKey('uptime'), record('uptime', { attempts: 4 }))
  const invalid = snapshot(state, { headers })
  assert.equal(invalid.value.sweepRead, 'invalid')
  assert.equal(invalid.value.deliveryRead, 'invalid')
  assert.equal(invalid.value.deliveryStatus, 'unknown')
  const slow = snapshot(state, { headers, fault: (stage, detail) =>
    stage === 'lookup' && detail.key === key ? { readyDelayMs: 1500 } : undefined })
  assert.equal(slow.value.deliveryRead, 'budget-exhausted')
  assert.equal(slow.result.calls.filter(call => call.stage === 'lookup').length, 1)
  const failed = snapshot(state, { fault: stage => stage === 'lookup' ? { status: 1 } : undefined })
  assert.equal(failed.value.sweepRead, 'failed')
  const malformed = status(authority({ version: 'bad', nextSweepAtMs: 'secret-payload' }))
  assert.equal(malformed.response.status, 503)
  assert.equal(malformed.response.body, 'status unavailable')
  assert.equal(malformed.headers['cache-control'], 'no-store')
  const noClock = status(authority(), { realtimeClock: () => ({ status: 1 }) })
  assert.equal(noClock.response.status, 503)
  assert.deepEqual(noClock.calls.filter(call => call.stage !== 'clock'), [])
})

test('slow authentication stops before all KV and is measured in response work', () => {
  const result = execute({ secretDelayMs: 1500, logEndpointFailure: false })
  assert.equal(result.response.body, 'healthy')
  assert.equal(result.headers['x-tick-admission'], 'budget-exhausted')
  assert.equal(result.headers['x-tick-response-elapsed-ms'], '1500')
  assert.deepEqual(result.calls.filter(call => call.stage !== 'clock'), [])
  assert.equal(outcome(result).responseElapsedMs, 1500)
})

test('failed log endpoint or write never changes probe health or admission', () => {
  for (const options of [{ logEndpointFailure: true }, { logEndpointFailure: false, logWriteFailure: true }]) {
    const result = execute({ ...options })
    assert.equal(result.response.body, 'healthy')
    assert.equal(result.headers['x-tick-admission'], 'admitted')
    assert.equal(result.headers['x-tick-acks'], '0')
    assert.deepEqual(result.logs, [])
  }
  const state = authority()
  const admitted = execute({ state, logEndpointFailure: false })
  const duplicate = execute({ state, logEndpointFailure: false })
  const summary = summarize([...events(admitted), ...events(duplicate)], 'local')
  assert.equal(summary.authenticatedProbes, 2)
  assert.equal(summary.admissionCounts.admitted, 1)
  assert.equal(summary.admissionCounts['not-due'], 1)
  assert.equal(summary.coverage.incomplete, true)
  assert.equal(summary.receiverPopCoverage, 'unavailable')
})

test('Native receiver ACK is visible in a fresh read-only instance; status does not count as a trigger', () => {
  const state = registryState()
  const workerState = authority()
  const accepted = send(state, { receive(request, fixture) {
    const result = worker({ state: workerState, request: { method: 'POST', path: '/__tick/run', headers: request.headers, body: request.body } })
    fixture.status = result.response.status
    fixture.headers = Object.fromEntries(result.response.headers)
  } })
  assert.equal(accepted.response.body, 'healthy')
  assert.equal(outcome(accepted).acks, 1)
  // Preserve the real beta.7 logging failure instead of repairing masked keys.
  assert.ok(accepted.logs.some(log => log.message.includes('cons<redacted>ered')))
  assert.equal(events(accepted).filter(event => event.event === 'fastly_tick.outcome').length, 0)
  const view = snapshot(state, { headers: { 'x-tick-probe-token': token, 'x-tick-worker-id': 'uptime' }, logEndpointFailure: false })
  assert.equal(view.value.deliveryStatus, 'acked')
  assert.equal(view.value.attempts, 1)
  assert.deepEqual(events(view.result), [])
})

test('both sends retain individual ACK latencies, rejection/late-response counts and lateness', () => {
  const pair = () => registryState(registry([entry('a'), entry('b')]))
  const two = send(pair(), { nowMs: 60100, hostcallDelayMs: { 'fastly_http_req.pending_req_wait': 10 } })
  assert.equal(outcome(two).acks, 2)
  assert.equal(outcome(two).ackLatencyOneMs, 10)
  assert.equal(outcome(two).ackLatencyTwoMs, 10)
  assert.equal(two.headers['x-tick-acks'], '2')
  assert.equal(outcome(two).dispatchLatenessMs, 110)
  for (const [options, field] of [[{ fixture: { status: 503, headers: {} } }, 'invalidAcks'],
    [{ hostcallDelayMs: { 'fastly_http_req.pending_req_wait': 1000 } }, 'ackTimeouts']]) {
    const result = send(registryState(), options)
    assert.equal(result.response.body, 'healthy')
    assert.equal(outcome(result)[field], 1)
    assert.equal(outcome(result).acks, 0)
    assert.equal(outcome(result).ackLatencyOneMs, -1)
  }
})

test('KV plus two bounded ACK waits leave the upstream response reserve; late work stops next candidate', () => {
  const state = registryState(registry([entry('a'), entry('b')]))
  const result = send(state, { fault: stage => ['lookup', 'insert'].includes(stage) ? { readyDelayMs: 50 } : undefined,
    hostcallDelayMs: { 'fastly_http_req.pending_req_wait': 999 } })
  assert.equal(result.response.body, 'healthy')
  assert.equal(outcome(result).acks, 2)
  assert.equal(outcome(result).responseElapsedMs, 2548)
  assert.ok(outcome(result).responseElapsedMs <= 5000 - 1000)
  const slow = send(registryState(registry([entry('a'), entry('b')])), {
    hostcallDelayMs: { 'fastly_http_req.pending_req_wait': 2000 },
  })
  assert.equal(outcome(slow).sends, 1)
  assert.equal(slow.headers['x-tick-registry'], 'budget-exhausted')
})

test('summaries withhold percentiles below 20 individual ACK samples and never certify deployment', () => {
  const base = outcome(send(registryState()))
  const many = Array.from({ length: 10 }, (_, i) => ({ ...base, sends: 2, acks: 2,
    ackLatencyOneMs: i + 1, ackLatencyTwoMs: i + 101 }))
  const summary = summarize(many, 'deployed')
  assert.equal(summary.ackLatency.sampleCount, 20)
  assert.equal(summary.ackLatency.medianMs, 55.5)
  assert.equal(summary.ackLatency.p95Ms, 109)
  assert.equal(summary.liveGate, 'requires-operator-verification')
  assert.equal(summary.coverage.incomplete, true)
  assert.equal(summarize(many.slice(0, 9), 'local').ackLatency.p95Ms, null)
  assert.equal(summarize([], 'deployed').maxObservedGapMs, null)
  assert.equal(normalize({ ...base, acks: 3 }), null)
  assert.equal(normalize({ ...base, admission: 'secret-payload' }), null)
})

test('stream collection bounds bytes/lines/events and drops unrelated secret-bearing content', async () => {
  const probe = JSON.stringify({ event: 'fastly_tick.probe', receiver: 'fastly-tick', kind: 'healthcheck', atMs: 1000, secret: token })
  const chunks = Readable.from(['[pulse:info] ' + probe.slice(0, 40), probe.slice(40) + '\r\n', 'x'.repeat(5000), '\nsecret-payload\n', probe])
  const collected = await collect(chunks)
  assert.equal(collected.events.length, 2)
  assert.equal(collected.coverage.oversizedLines, 1)
  assert.ok(!JSON.stringify(collected).includes(token))
  const capped = await collect(Readable.from([(probe + '\n').repeat(10001)]))
  assert.equal(capped.events.length, 10000)
  assert.equal(capped.coverage.limitReached, true)
  const bytes = await collect(Readable.from([Buffer.alloc(16 * 1024 * 1024 + 1, 120)]))
  assert.equal(bytes.events.length, 0)
  assert.equal(bytes.coverage.limitReached, true)
})
