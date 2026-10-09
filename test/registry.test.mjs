import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execute, authority, key, store, token } from './admission-fixture.mjs'
import { enabledReceiver, workerToken, workerUrl } from './dispatch-fixture.mjs'
import { registryKey, deliveryKey, entry, registry, registryState, seed, delivery, record } from './registry-fixture.mjs'

const enabled = enabledReceiver()
after(() => enabled.cleanup())
const send = (state, options = {}) => {
  const fixture = { status: 202, headers: {} }
  return execute({ state, binary: enabled.binary,
    secrets: { TICK_PROBE_TOKEN: token, UPTIME_TICK_TOKEN: workerToken },
    fixtures: { [workerUrl]: fixture }, onOutboundRequest(request) {
      fixture.headers['x-tick-invocation-id'] = Object.fromEntries(request.headers)['x-tick-invocation-id']
    }, ...options,
  })
}
function healthy(result, status = 'ready') {
  assert.equal(result.response.status, 200)
  assert.equal(result.response.body, 'healthy')
  assert.equal(result.headers['x-tick-registry'], status)
  assert.ok(result.outboundRequests.length <= 2)
  assert.ok(Number(result.headers['x-tick-workers-considered'] || 0) <= 8)
  const records = result.calls.filter(call => call.stage === 'insert' && call.key?.startsWith('fastly-tick-v1/delivery/'))
  assert.ok(new Set(records.map(call => call.key)).size <= 2)
  return result
}

test('only a confirmed sweep may read registry; missing/failed registry is a healthy skip', () => {
  for (const options of [
    { headers: {} }, { state: authority({ version: 1, nextSweepAtMs: 100001 }) },
    { fault: stage => stage === 'insert' ? { kvError: 4 } : undefined },
    { fault: stage => stage === 'insert_wait' ? { status: 1 } : undefined },
  ]) {
    const result = execute(options)
    assert.ok(!result.calls.some(call => call.key === registryKey))
  }
  healthy(execute(), 'missing')
  healthy(execute({ state: registryState(), fault: (stage, detail) =>
    stage === 'lookup' && detail.key === registryKey ? { status: 1 } : undefined }), 'read-failed')
})

test('empty/disabled registries do no delivery work; disabled dispatch prepares but never sends', () => {
  for (const workers of [[], [entry('uptime', { enabled: false })]]) {
    const result = healthy(execute({ state: registryState(registry(workers)) }))
    assert.equal(result.headers['x-tick-workers-selected'], '0')
    assert.ok(!result.calls.some(call => call.key?.startsWith('fastly-tick-v1/delivery/')))
  }
  const result = healthy(execute({ state: registryState() }))
  assert.equal(result.headers['x-tick-dispatch'], 'disabled')
  assert.equal(result.headers['x-tick-sends'], '0')
  assert.deepEqual(delivery(result.state), record('uptime', {
    status: 'pending', attempts: 0, nextAttemptAtMs: 60000,
  }))
  assert.ok(!result.trace.some(call => call.key === 'UPTIME_TICK_TOKEN'))
})

test('reject malformed whole registries before any per-worker state or send', () => {
  for (const value of [null, {}, { schema: 'v2', workers: [] }, registry([entry(), entry()]),
    registry(Array.from({ length: 9 }, (_, i) => entry('w' + i))),
    ...[
      { id: '' }, { id: 'x'.repeat(33) }, { id: 'bad/id' }, { id: 'X' }, { id: '雪' },
      { enabled: 'true' }, { everyMs: 14999 }, { everyMs: 15001 }, { everyMs: 86415000 },
      { everyMs: '60000' }, { ackTimeoutMs: 0 }, { ackTimeoutMs: 1001 }, { ackTimeoutMs: 1.5 },
      { maxAttempts: 0 }, { maxAttempts: 4 }, { maxAttempts: 2.5 },
      { backend: 'evil' }, { path: '/other' }, { method: 'GET' }, { authSecretRef: 'OTHER_SECRET' },
      { headers: {} }, { headers: { authorization: 'override' } },
    ].map(overrides => registry([entry('uptime', overrides)])),
  ]) {
    const result = healthy(execute({ state: registryState(value) }), 'invalid')
    assert.ok(!result.calls.some(call => call.key?.startsWith('fastly-tick-v1/delivery/')))
    assert.deepEqual(result.outboundRequests, [])
  }
  // The provider bounds raw KV wire BEFORE parsing. Do not parse an unbounded
  // list and pretend an array slice enforces a document bound.
  const state = authority()
  state.seed(store, registryKey, Buffer.from('{"__pulseKv":1,"value":{"padding":"' + 'x'.repeat(70000) + '"}}'), 1n)
  healthy(execute({ state }), 'read-failed')
})

test('UTC slot boundary and missed windows keep IDs stable without catch-up', () => {
  for (const [nowMs, slot] of [[59999, 0], [60000, 60000], [119999, 60000], [120000, 120000], [3600001, 3600000]]) {
    const result = healthy(send(registryState(), { nowMs }))
    assert.equal(result.outboundRequests.length, 1)
    assert.equal(delivery(result.state).runId, 'uptime:slot:' + slot)
    assert.equal(delivery(result.state).scheduledForMs, slot)
    assert.equal(delivery(result.state).status, 'acked')
    assert.equal(JSON.parse(result.outboundRequests[0].body).scheduledForMs, slot)
  }
})

test('acked/exhausted/attempted slots are not re-sent in FT-04; next slot replaces one key', () => {
  for (const status of ['acked', 'pending', 'exhausted']) {
    const state = seed(registryState(), deliveryKey('uptime'), record('uptime', { status }))
    const same = healthy(send(state))
    assert.deepEqual(same.outboundRequests, [])
    const next = healthy(send(state, { nowMs: 120000 }))
    assert.equal(next.outboundRequests.length, 1)
    assert.equal(delivery(state).runId, 'uptime:slot:120000')
    assert.equal([...state.stores.get(store).keys()].filter(k => k.startsWith('fastly-tick-v1/delivery/')).length, 1)
  }
})

test('two sends maximum, eight scans maximum, rotation gives later entries their turn', () => {
  const workers = Array.from({ length: 8 }, (_, i) => entry('w' + i, { everyMs: 86400000 }))
  const state = registryState(registry(workers))
  const first = healthy(send(state))
  assert.equal(first.outboundRequests.length, 2)
  assert.equal(first.headers['x-tick-workers-considered'], '8')
  assert.equal(delivery(state, 'w0').status, 'acked')
  assert.equal(delivery(state, 'w1').status, 'acked')
  // Not-due candidates can leave a dispatch position unused; advance by one,
  // rather than making later workers depend on earlier ones becoming disabled.
  for (let i = 1; i < 8; i++) healthy(send(state, { nowMs: 100000 + i * 15000 }))
  for (let i = 0; i < 8; i++) assert.equal(delivery(state, 'w' + i).status, 'acked')
  assert.equal([...state.stores.get(store).keys()].filter(k => k.startsWith('fastly-tick-v1/delivery/')).length, 8)
})

test('enablement and interval edits preserve attempted identity and wait for a newer slot', () => {
  const state = registryState()
  healthy(send(state))
  seed(state, registryKey, registry([entry('uptime', { enabled: false })]))
  healthy(send(state, { nowMs: 115000 }))
  assert.equal(delivery(state).runId, 'uptime:slot:60000')
  seed(state, registryKey, registry([entry('uptime', { everyMs: 30000 })]))
  const changed = healthy(send(state, { nowMs: 130000 }))
  assert.equal(changed.outboundRequests.length, 1)
  assert.equal(delivery(state).runId, 'uptime:slot:120000')
  seed(state, registryKey, registry([entry('uptime', { everyMs: 60000 })]))
  assert.deepEqual(healthy(send(state, { nowMs: 145000 })).outboundRequests, [])
})

test('future/in-flight/corrupt records are never overwritten to gain authority', () => {
  for (const [value, expected] of [
    [record('uptime', { scheduledForMs: 180000, runId: 'uptime:slot:180000', nextAttemptAtMs: 180000 }), 'ready'],
    [record('uptime', { status: 'pending', inFlightUntilMs: 200000 }), 'ready'],
    [record('uptime', { version: 2 }), 'invalid-delivery'],
    [record('uptime', { runId: 'other' }), 'invalid-delivery'],
    [record('uptime', { attempts: 4 }), 'invalid-delivery'],
    [record('uptime', { everyMs: 0 }), 'invalid-delivery'],
    [record('uptime', { status: 'done' }), 'invalid-delivery'],
    [record('uptime', { inFlightUntilMs: -1 }), 'invalid-delivery'],
    [{}, 'invalid-delivery'],
  ]) {
    const state = seed(registryState(), deliveryKey('uptime'), value)
    const old = state.get(store, deliveryKey('uptime'))
    const result = healthy(send(state, { nowMs: 120000 }), expected)
    assert.deepEqual(result.outboundRequests, [])
    assert.equal(state.get(store, deliveryKey('uptime')), old)
  }
})

test('conditional delivery conflicts/unknown commits never authorize send or retry', () => {
  for (const fault of [
    (stage, detail) => stage === 'insert' && detail.key === deliveryKey('uptime') ? { kvError: 4 } : undefined,
    (stage, detail) => stage === 'insert' && detail.key === deliveryKey('uptime') ? { status: 1, commit: true } : undefined,
  ]) {
    const result = healthy(send(registryState(), { fault }))
    assert.deepEqual(result.outboundRequests, [])
    assert.equal(result.calls.filter(call => call.stage === 'insert' && call.key === deliveryKey('uptime')).length, 1)
  }
  const state = seed(registryState(), deliveryKey('uptime'), record())
  const result = healthy(send(state, { nowMs: 120000, fault: (stage, detail) =>
    stage === 'insert' && detail.key === deliveryKey('uptime') ? { kvError: 4 } : undefined }))
  assert.deepEqual(result.outboundRequests, [])
  assert.equal(delivery(state).runId, 'uptime:slot:60000')
})

test('stale delivery read still yields one confirmed first send across admitted invocations', () => {
  const state = registryState()
  const results = []
  // Force each invocation past its sweep read, but do not weaken the delivery
  // arbiter. This also models a known Viceroy duplicate sweep admission.
  for (let i = 0; i < 4; i++) {
    state.stores.get(store).delete(key)
    let currentKey
    let deliveryReads = 0
    results.push(healthy(send(state, { fault(stage, detail) {
      if (stage === 'lookup') { currentKey = detail.key; if (currentKey === deliveryKey('uptime')) deliveryReads++ }
      if (stage === 'lookup_wait_v2' && currentKey === deliveryKey('uptime') && deliveryReads === 1) return { kvError: 3 }
    } })))
  }
  assert.equal(results.reduce((sum, r) => sum + r.outboundRequests.length, 0), 1)
  assert.equal(delivery(state).status, 'acked')
})

test('ACK settlement cannot overwrite a newer delivery record', () => {
  const state = registryState()
  const replacement = record('uptime', { scheduledForMs: 120000, runId: 'uptime:slot:120000', status: 'pending', inFlightUntilMs: 140000 })
  let reads = 0
  const result = healthy(send(state, { fault(stage, detail) {
    if (stage === 'lookup' && detail.key === deliveryKey('uptime') && ++reads === 2) seed(state, deliveryKey('uptime'), replacement, 99n)
  } }))
  assert.equal(result.headers['x-tick-dispatch'], 'acked')
  assert.deepEqual(delivery(state), replacement)
})

test('registry and delivery waits stop new work after the KV budget', () => {
  for (const slowKey of [registryKey, deliveryKey('uptime')]) {
    const result = healthy(send(registryState(), { fault: (stage, detail) =>
      stage === 'lookup' && detail.key === slowKey ? { readyDelayMs: 1500 } : undefined }), 'budget-exhausted')
    assert.deepEqual(result.outboundRequests, [])
    assert.equal(delivery(result.state), undefined)
  }
})


test('prepared zero-attempt slot is conditionally claimed once when dispatch is enabled', () => {
  const state = registryState()
  healthy(execute({ state }))
  const prepared = delivery(state)
  assert.equal(prepared.attempts, 0)
  const result = healthy(send(state, { nowMs: 115000 }))
  assert.equal(result.outboundRequests.length, 1)
  assert.equal(delivery(state).runId, prepared.runId)
  assert.equal(delivery(state).attempts, 1)
  assert.equal(delivery(state).status, 'acked')
  const claim = result.calls.find(call => call.stage === 'insert' && call.key === deliveryKey('uptime'))
  assert.equal(claim.mask, 32)
})
