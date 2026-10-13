import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execute, authority, key, store, token } from './admission-fixture.mjs'
import { enabledReceiver, worker, workerToken, workerUrl } from './dispatch-fixture.mjs'
import { registryKey, deliveryKey, entry, registry, registryState, seed, delivery, record } from './registry-fixture.mjs'

const enabled = enabledReceiver()
after(() => enabled.cleanup())
const id = 'uptime:slot:60000'
const requestHeaders = request => Object.fromEntries(request.headers)
function heartbeat(state, nowMs, { response = 'ack', receive, ...options } = {}) {
  const fixture = { status: 202, headers: {} }
  const captured = []
  const result = execute({ state, nowMs, binary: enabled.binary,
    secrets: { TICK_PROBE_TOKEN: token, UPTIME_TICK_TOKEN: workerToken },
    fixtures: { [workerUrl]: fixture },
    onOutboundRequest(request) {
      captured.push(request)
      fixture.headers = response === 'missing-id' ? {} : { 'x-tick-invocation-id': requestHeaders(request)['x-tick-invocation-id'] }
      if (response === 'reject') fixture.status = 503
      if (response === 'reset') fixture.transportStatus = 1
      receive?.(request, fixture)
    }, ...options,
  })
  assert.equal(result.response.status, 200)
  assert.equal(result.response.body, 'healthy')
  assert.ok(captured.length <= 2)
  return { ...result, captured }
}
function admittedAgain(state) {
  // Bypass ONLY the sweep timestamp to test the independent delivery arbiter.
  state.stores.get(store).delete(key)
  return state
}
const pending = (overrides = {}) => record('uptime', {
  status: 'pending', nextAttemptAtMs: 75000, inFlightUntilMs: 61500, ...overrides,
})
const at = (value, workers = [entry()]) => seed(registryState(registry(workers)), deliveryKey('uptime'), value)

// This is the lost-ACK proof: two emitted Native modules, independent stores,
// acceptance before response loss, then duplicate acceptance of the SAME ID.
test('worker accepts, ACK is lost, later heartbeat redelivers same ID and stops after ACK', () => {
  const state = registryState()
  const workerState = authority()
  const received = []
  const accept = (request, fixture) => {
    const result = worker({ state: workerState, request: {
      method: request.method, path: '/__tick/run', headers: request.headers, body: request.body,
    } })
    assert.equal(result.response.status, 202)
    received.push(requestHeaders(request))
    fixture.status = result.response.status
    fixture.headers = Object.fromEntries(result.response.headers)
    if (received.length === 1) fixture.transportStatus = 1 // Worker accepted; its ACK is lost.
  }
  const lost = heartbeat(state, 60000, { receive: accept })
  assert.equal(lost.headers['x-tick-dispatch'], 'unacknowledged')
  assert.equal(lost.headers['x-tick-dispatch-error'], 'transport')
  assert.equal(lost.captured.length, 1)
  assert.equal(workerState.stores.get('worker_state').size, 1)
  assert.equal(delivery(state).status, 'pending')
  assert.equal(delivery(state).attempts, 1)
  assert.equal(delivery(state).nextAttemptAtMs, 75000)
  assert.deepEqual(heartbeat(state, 74999, { receive: accept }).captured, [])
  const retry = heartbeat(state, 75000, { receive: accept })
  assert.equal(retry.headers['x-tick-redeliveries'], '1')
  assert.deepEqual(received.map(h => [h['x-tick-invocation-id'], h['x-tick-attempt']]), [[id, '1'], [id, '2']])
  assert.equal(delivery(state).status, 'acked')
  assert.equal(delivery(state).attempts, 2)
  assert.deepEqual(heartbeat(state, 90000, { receive: accept }).captured, [])
  assert.equal(workerState.stores.get('worker_state').size, 1)
})

test('retry timestamp AND in-flight deadline each fence a second attempt', () => {
  for (const [value, nowMs] of [
    [pending({ nextAttemptAtMs: 60500 }), 61499],
    [pending({ inFlightUntilMs: 60001 }), 74999],
  ]) {
    const state = at(value)
    const before = state.get(store, deliveryKey('uptime'))
    assert.deepEqual(heartbeat(state, nowMs).captured, [])
    assert.equal(state.get(store, deliveryKey('uptime')), before)
  }
  const state = at(pending({ nextAttemptAtMs: 60500 }))
  const retry = heartbeat(state, 61500)
  assert.equal(requestHeaders(retry.captured[0])['x-tick-attempt'], '2')
})

test('three failed attempts exhaust once; no same-sweep retry, next window can run', () => {
  const state = registryState()
  for (const [nowMs, attempt] of [[60000, 1], [75000, 2], [90000, 3]]) {
    const result = heartbeat(state, nowMs, { response: 'reject' })
    assert.equal(result.captured.length, 1)
    assert.equal(requestHeaders(result.captured[0])['x-tick-invocation-id'], id)
    assert.equal(requestHeaders(result.captured[0])['x-tick-attempt'], '' + attempt)
    assert.equal(delivery(state).attempts, attempt)
    assert.equal(delivery(state).status, attempt === 3 ? 'exhausted' : 'pending')
    assert.equal(result.headers['x-tick-exhausted'], attempt === 3 ? '1' : '0')
  }
  assert.deepEqual(heartbeat(state, 105000).captured, [])
  const fresh = heartbeat(state, 120000)
  assert.equal(requestHeaders(fresh.captured[0])['x-tick-invocation-id'], 'uptime:slot:120000')
  assert.equal(delivery(state).attempts, 1)
  assert.equal(delivery(state).status, 'acked')
})

test('configured retry ceiling and later budget reductions never permit an extra send', () => {
  for (const maxAttempts of [1, 2]) {
    const state = registryState(registry([entry('uptime', { maxAttempts })]))
    for (let i = 0; i < maxAttempts; i++) heartbeat(state, 60000 + i * 15000, { response: 'reject' })
    assert.equal(delivery(state).status, 'exhausted')
    assert.deepEqual(heartbeat(state, 60000 + maxAttempts * 15000).captured, [])
  }
  const state = at(pending({ attempts: 2 }), [entry('uptime', { maxAttempts: 1 })])
  const retired = heartbeat(state, 75000)
  assert.deepEqual(retired.captured, [])
  assert.equal(delivery(state).status, 'exhausted')
  assert.equal(delivery(state).attempts, 2)
  assert.equal(retired.headers['x-tick-exhausted'], '1')
})

test('crash after attempt claim but before send recovers only on a later heartbeat', () => {
  const state = registryState()
  let inserting
  assert.throws(() => heartbeat(state, 60000, { fault(stage, detail) {
    if (stage === 'insert') inserting = detail.key
    if (stage === 'insert_wait' && inserting === deliveryKey('uptime')) throw new Error('terminated after attempt claim')
  } }), /terminated after attempt claim/)
  assert.equal(delivery(state).attempts, 1)
  assert.equal(delivery(state).inFlightUntilMs, 61500)
  assert.deepEqual(heartbeat(admittedAgain(state), 61499).captured, [])
  const result = heartbeat(admittedAgain(state), 75000)
  assert.equal(requestHeaders(result.captured[0])['x-tick-attempt'], '2')
  assert.equal(delivery(state).status, 'acked')
})

test('termination after worker acceptance can cause duplicate delivery, never exactly once', () => {
  const state = registryState()
  const workerState = authority()
  let accepted = 0
  const receive = request => {
    const result = worker({ state: workerState, request: { method: 'POST', path: '/__tick/run', headers: request.headers, body: request.body } })
    assert.equal(result.response.status, 202)
    accepted++
    if (accepted === 1) throw new Error('terminated after acceptance before ACK')
  }
  assert.throws(() => heartbeat(state, 60000, { receive }), /terminated after acceptance/)
  const next = heartbeat(state, 75000, { receive })
  assert.equal(requestHeaders(next.captured[0])['x-tick-invocation-id'], id)
  assert.equal(accepted, 2)
  assert.equal(workerState.stores.get('worker_state').size, 1)
  assert.equal(delivery(state).status, 'acked')
})

test('healthy transport recovery leaves the claim pending until a later heartbeat', () => {
  const state = registryState()
  const reset = heartbeat(state, 60000, { response: 'reset' })
  assert.equal(reset.headers['x-tick-dispatch'], 'unacknowledged')
  assert.equal(reset.headers['x-tick-dispatch-error'], 'transport')
  assert.equal(reset.captured.length, 1)
  assert.equal(delivery(state).status, 'pending')
  assert.equal(delivery(state).attempts, 1)
  heartbeat(state, 75000)
  assert.equal(delivery(state).status, 'acked')
  assert.equal(delivery(state).attempts, 2)
})

test('last-attempt crash becomes exhausted after deadline, without another send', () => {
  const state = at(pending({ attempts: 3, inFlightUntilMs: 76500, nextAttemptAtMs: 90000 }))
  assert.deepEqual(heartbeat(state, 76499).captured, [])
  assert.equal(delivery(state).status, 'pending')
  const after = heartbeat(admittedAgain(state), 76500)
  assert.deepEqual(after.captured, [])
  assert.equal(delivery(state).status, 'exhausted')
  assert.equal(after.headers['x-tick-exhausted'], '1')
  heartbeat(state, 120000)
  assert.equal(delivery(state).runId, 'uptime:slot:120000')
})

test('unknown retry claim cannot send whether or not the CAS actually committed', () => {
  for (const commit of [false, true]) {
    const state = at(pending())
    const result = heartbeat(state, 75000, { fault: (stage, detail) =>
      stage === 'insert' && detail.key === deliveryKey('uptime') ? { status: 1, commit } : undefined })
    assert.deepEqual(result.captured, [])
    assert.equal(delivery(state).attempts, commit ? 2 : 1)
    const recovery = heartbeat(state, 90000)
    assert.equal(requestHeaders(recovery.captured[0])['x-tick-attempt'], commit ? '3' : '2')
    assert.equal(delivery(state).status, 'acked')
  }
})

test('uncertain ACK persistence is resolved by the next read, without inventing acceptance', () => {
  for (const commit of [false, true]) {
    const state = registryState()
    let writes = 0
    const first = heartbeat(state, 60000, { fault(stage, detail) {
      if (stage === 'insert' && detail.key === deliveryKey('uptime') && ++writes === 2) return { status: 1, commit }
    } })
    assert.equal(first.headers['x-tick-dispatch'], 'acked')
    assert.equal(delivery(state).status, commit ? 'acked' : 'pending')
    const next = heartbeat(state, 75000)
    assert.equal(next.captured.length, commit ? 0 : 1)
    if (!commit) assert.equal(requestHeaders(next.captured[0])['x-tick-invocation-id'], id)
  }
})

test('stale retry contenders use opaque CAS and only one confirmed winner sends', () => {
  const state = at(pending())
  const observation = state.get(store, deliveryKey('uptime'))
  const results = []
  for (let i = 0; i < 6; i++) {
    let reads = 0
    results.push(heartbeat(admittedAgain(state), 75000, { fault(stage, detail) {
      if (stage === 'lookup' && detail.key === deliveryKey('uptime') && ++reads === 1) return { observation }
    } }))
  }
  assert.equal(results.reduce((n, r) => n + r.captured.length, 0), 1)
  assert.equal(delivery(state).attempts, 2)
  assert.equal(delivery(state).status, 'acked')
})

test('late prior ACK cannot overwrite a newer attempt or newer slot', () => {
  for (const newer of [pending({ attempts: 3, nextAttemptAtMs: 100000, inFlightUntilMs: 86500 }),
    pending({ runId: 'uptime:slot:120000', scheduledForMs: 120000, attempts: 1, nextAttemptAtMs: 135000, inFlightUntilMs: 121500 })]) {
    const state = at(pending())
    const result = heartbeat(state, 75000, { receive() { seed(state, deliveryKey('uptime'), newer, 99n) } })
    assert.equal(result.headers['x-tick-dispatch'], 'acked')
    assert.deepEqual(delivery(state), newer)
  }
})

test('new slots expire pending work after its deadline and persist one bounded dropped marker', () => {
  const state = at(pending({ inFlightUntilMs: 120500 }))
  assert.deepEqual(heartbeat(state, 120499).captured, [])
  const fresh = heartbeat(admittedAgain(state), 120500, { response: 'reject' })
  assert.equal(requestHeaders(fresh.captured[0])['x-tick-invocation-id'], 'uptime:slot:120000')
  assert.equal(requestHeaders(fresh.captured[0])['x-tick-attempt'], '1')
  assert.equal(fresh.headers['x-tick-dropped'], '1')
  assert.equal(delivery(state).droppedScheduledForMs, 60000)
  const retry = heartbeat(state, 135500)
  assert.equal(retry.headers['x-tick-dropped'], '0')
  assert.equal(delivery(state).droppedScheduledForMs, 60000)
  assert.equal(delivery(state).status, 'acked')
  assert.equal([...state.stores.get(store).keys()].filter(k => k.startsWith('fastly-tick-v1/delivery/')).length, 1)
})

test('disabled dispatch and disabled registry entries cannot advance pending attempts', () => {
  for (const disabledEntry of [false, true]) {
    const state = at(pending(), [entry('uptime', { enabled: !disabledEntry })])
    const old = state.get(store, deliveryKey('uptime'))
    const result = disabledEntry ? heartbeat(state, 75000) : execute({ state, nowMs: 75000 })
    assert.deepEqual(result.outboundRequests, [])
    assert.equal(state.get(store, deliveryKey('uptime')), old)
  }
})

test('pre-send failure consumes a reserved attempt conservatively, then recovers', () => {
  for (const options of [
    { secrets: { TICK_PROBE_TOKEN: token } },
    { fault: (stage, detail) => stage === 'insert' && detail.key === deliveryKey('uptime') ? { readyDelayMs: 501 } : undefined },
  ]) {
    const state = registryState()
    const first = heartbeat(state, 60000, options)
    assert.deepEqual(first.captured, [])
    assert.equal(delivery(state).attempts, 1)
    assert.equal(delivery(state).status, 'pending')
    heartbeat(state, 75000)
    assert.equal(delivery(state).attempts, 2)
    assert.equal(delivery(state).status, 'acked')
  }
})

test('both candidate blocks honor retries and the two-send cap', () => {
  const state = registryState(registry(['a', 'b', 'c'].map(name => entry(name, { maxAttempts: 2 }))))
  for (const name of ['a', 'b', 'c']) seed(state, deliveryKey(name), record(name, { status: 'pending', nextAttemptAtMs: 75000, inFlightUntilMs: 61500 }))
  const result = heartbeat(state, 75000, { response: 'reject' })
  assert.equal(result.captured.length, 2)
  assert.equal(result.headers['x-tick-redeliveries'], '2')
  assert.equal(result.headers['x-tick-exhausted'], '2')
  for (const name of ['a', 'b']) {
    assert.equal(delivery(state, name).attempts, 2)
    assert.equal(delivery(state, name).status, 'exhausted')
  }
  assert.equal(delivery(state, 'c').attempts, 1)
})


test('FT-04 pending records upgrade without losing identity; invalid drop markers fail closed', () => {
  const legacy = pending()
  delete legacy.droppedScheduledForMs
  const state = at(legacy)
  heartbeat(state, 75000)
  assert.equal(delivery(state).runId, id)
  assert.equal(delivery(state).attempts, 2)
  assert.equal(delivery(state).droppedScheduledForMs, -1)
  for (const droppedScheduledForMs of [-2, 60000, 1.5, '0']) {
    const value = pending({ droppedScheduledForMs })
    const invalid = at(value)
    const result = heartbeat(invalid, 75000)
    assert.equal(result.headers['x-tick-registry'], 'invalid-delivery')
    assert.deepEqual(result.captured, [])
    assert.deepEqual(delivery(invalid), value)
  }
})


test('out-of-range persisted retry deadlines fail closed', () => {
  for (const overrides of [
    { nextAttemptAtMs: 253402300800000 },
    { inFlightUntilMs: 253402300800000 },
    { nextAttemptAtMs: -1 },
    { inFlightUntilMs: 1.5 },
  ]) {
    const value = pending(overrides)
    const state = at(value)
    const result = heartbeat(state, 75000)
    assert.equal(result.headers['x-tick-registry'], 'invalid-delivery')
    assert.deepEqual(result.captured, [])
    assert.deepEqual(delivery(state), value)
  }
})
