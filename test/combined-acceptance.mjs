import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { authority, execute, token } from './admission-fixture.mjs'
import { enabledReceiver, receiver, worker, workerToken, runId } from './dispatch-fixture.mjs'
import { delivery, deliveryKey } from './registry-fixture.mjs'
import { fromHeaders, parseEvent } from '../scripts/observe.mjs'

// Opt-in integrated-provider acceptance. The default suite still diagnoses the
// pinned beta.7 behavior; this suite must fail until the provider fixes land.
const enabled = enabledReceiver()
const cases = []
function trial(name, check) {
  try { check() }
  catch (error) { cases.push({ name, status: 'failed' }); throw error }
  cases.push({ name, status: 'passed' })
  console.log(`ok - combined ABI ${name}`)
}
function healthy(result, outcome) {
  assert.equal(result.response.status, 200)
  assert.equal(result.response.body, 'healthy')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['x-tick-dispatch'], outcome)
}
try {
  trial('missing probe auth rejects before KV or dispatch', () => {
    const result = receiver(enabled.binary, { headers: {} })
    assert.equal(result.response.status, 401)
    assert.equal(result.calls.length, 0)
    assert.equal(result.captured.length, 0)
  })
  trial('missing worker auth rejects before persistence', () => {
    const result = worker({ request: { method: 'POST', path: '/__tick/run', headers: {
      'x-tick-invocation-id': runId, 'x-tick-attempt': '1', 'content-type': 'application/json',
    }, body: '{"worker":"uptime","scheduledForMs":60000}' } })
    assert.equal(result.response.status, 401)
    assert.equal(result.calls.length, 0)
  })
  for (const [name, fixture, acks, invalidAcks] of [
    ['missing ACK ID', { status: 202, headers: {} }, 0, 1],
    ['valid ACK', { status: 202, headers: { 'x-tick-invocation-id': runId } }, 1, 0],
  ]) trial(name + ' preserves strict structured observations', () => {
    const emitted = []
    const result = receiver(enabled.binary, { fixture, logEndpointFailure: false,
      onLogWrite(message) { emitted.push(message) } })
    healthy(result, acks ? 'acked' : 'unacknowledged')
    assert.equal(result.captured.length, 1)
    // Parse actual guest writes, before the injected host's trace redaction.
    const events = emitted.map(parseEvent).filter(event => event?.event === 'fastly_tick.outcome')
    assert.equal(events.length, 1, 'closed observation must retain all metric keys')
    assert.deepEqual(events[0], fromHeaders(result.response.headers))
    assert.equal(events[0].considered, 1)
    assert.equal(events[0].invalidAcks, invalidAcks)
    assert.equal(events[0].acks, acks)
    assert.equal(delivery(result.state).status, acks ? 'acked' : 'pending')
    for (const secret of [token, workerToken]) assert.equal(emitted.some(line => line.includes(secret)), false)
  })
  for (const [name, fixture, category, sends] of [
    ['transport send failure', { sendStatus: 1 }, 'transport', 1],
    ['transport reset after send', { transportStatus: 1 }, 'transport', 1],
    ['delayed headers', { delayMs: 1400 }, 'timeout', 1],
    ['headers at exact deadline', { delayMs: 1000 }, 'timeout', 1],
  ]) trial(name + ' returns healthy without ACK, settlement, or retry', () => {
    const result = receiver(enabled.binary, { fixture })
    healthy(result, 'unacknowledged')
    assert.equal(result.headers['x-tick-dispatch-error'], category)
    assert.equal(result.captured.length, sends)
    const pending = delivery(result.state)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.attempts, 1)
    assert.ok(pending.inFlightUntilMs > pending.scheduledForMs)
    assert.equal(result.calls.filter(call => call.stage === 'insert' && call.key === deliveryKey('uptime')).length, 1)
    assert.equal(fromHeaders(result.response.headers), null, 'aborted sweep counters remain unknown, never zero-filled')
    if (category === 'timeout') assert.equal(result.monotonicMs, 1000)
  })
  trial('headers before the deadline ACK without reading the body', () => {
    const result = receiver(enabled.binary, { fixture: { status: 202,
      headers: { 'x-tick-invocation-id': runId }, delayMs: 999, bodyDelayMs: 10000 } })
    healthy(result, 'acked')
    assert.equal(result.monotonicMs, 999)
    assert.equal(result.captured.length, 1)
  })
  trial('shipped dispatch remains disabled', () => {
    const result = execute({ state: authority() })
    healthy(result, 'disabled')
    assert.equal(result.outboundRequests.length, 0)
  })
  console.log(`${cases.length}/${cases.length} combined actual-Native ABI cases passed`)
} finally {
  enabled.cleanup()
  if (process.env.FASTLY_TICK_COMBINED_ABI_REPORT) writeFileSync(process.env.FASTLY_TICK_COMBINED_ABI_REPORT,
    JSON.stringify({ status: cases.length === 10 && cases.every(test => test.status === 'passed') ? 'passed' : 'failed', evidence: 'actual-Native-injected-ABI', cases }, null, 2) + '\n')
}
