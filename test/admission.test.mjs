import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authority, execute, persisted, store, key, token } from './admission-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const stages = (result, stage) => result.calls.filter(call => call.stage === stage)
const kvStages = result => result.calls.filter(call => !['clock'].includes(call.stage))

function healthy(result, admission) {
  assert.equal(result.response.status, 200)
  assert.equal(result.response.body, 'healthy')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['x-tick-admission'], admission)
  if (admission !== 'admitted') assert.equal(result.headers['x-tick-next-sweep-at-ms'], undefined)
  // FT-02 cannot read a registry, fetch a worker, delete, renew, or retry.
  assert.deepEqual(result.outboundRequests, [])
  assert.ok(stages(result, 'lookup').length <= 1)
  assert.ok(stages(result, 'insert').length <= 1)
  for (const call of result.calls.filter(call => 'key' in call)) {
    assert.equal(call.store, store)
    assert.equal(call.key, key)
  }
  return result
}

test('emitted Wasm: rejected authentication never opens or reads KV', () => {
  const cases = [
    {},
    { 'x-tick-probe-token': '' },
    { 'x-tick-probe-token': 'wrong' },
    [['x-tick-probe-token', token], ['x-tick-probe-token', token]],
    { 'x-tick-probe-token': token, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-extra-${i}`, 'x'])) },
  ]
  for (const headers of cases) {
    const result = execute({ headers })
    assert.equal(result.response.status, 401)
    assert.deepEqual(kvStages(result), [])
    assert.deepEqual(result.outboundRequests, [])
    assert.equal(persisted(result.state), undefined)
  }
})

test('emitted Wasm: PoP filtering without trusted metadata skips before all KV', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fastly-tick-pop-'))
  try {
    cpSync(join(root, 'src'), join(directory, 'src'), { recursive: true })
    mkdirSync(join(directory, '.pulse'))
    mkdirSync(join(directory, 'test'))
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    copyFileSync(join(root, 'package.json'), join(directory, 'package.json'))
    copyFileSync(join(root, '.pulse/config.ts'), join(directory, '.pulse/config.ts'))
    copyFileSync(join(root, 'test/pulse.harness.ts'), join(directory, 'test/pulse.harness.ts'))
    const source = readFileSync(join(root, 'src/index.ts'), 'utf8')
    assert.equal(source.split("const popMode = 'all'").length, 2)
    writeFileSync(join(directory, 'src/index.ts'), source.replace("const popMode = 'all'", "const popMode = 'allowlist'"))
    const cli = join(dirname(require.resolve('@pulse-compute/cli')), '../bin/pulse.js')
    execFileSync(process.execPath, [cli, 'build'], { cwd: directory, stdio: 'pipe', timeout: 60000 })
    const binary = readFileSync(join(directory, 'dist/bin/main.wasm'))
    for (const headers of [
      { 'x-tick-probe-token': token },
      { 'x-tick-probe-token': token, 'x-tick-probe-kind': 'healthcheck', 'fastly-pop': 'IAD', 'x-tick-pop': 'IAD', 'x-served-by': 'cache-iad123' },
    ]) {
      const result = healthy(execute({ binary, headers }), 'pop-unavailable')
      assert.deepEqual(kvStages(result), [])
      assert.equal(persisted(result.state), undefined)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('emitted Wasm: all-PoP mode ignores untrusted location and kind headers', () => {
  for (const headers of [
    { 'x-tick-probe-token': token },
    { 'x-tick-probe-token': token, 'x-tick-probe-kind': 'healthcheck', 'fastly-pop': 'DEN', 'x-tick-pop': 'DEN' },
  ]) {
    const result = healthy(execute({ headers }), 'admitted')
    assert.equal(result.headers['x-tick-next-sweep-at-ms'], '115000')
    assert.deepEqual(persisted(result.state), { version: 1, nextSweepAtMs: 115000 })
    assert.equal(stages(result, 'insert')[0].mode, 1)
  }
})

test('emitted Wasm: read failures and corrupt wire bytes never become empty state', () => {
  for (const fault of [
    stage => stage === 'open' ? { status: 1 } : undefined,
    stage => stage === 'lookup' ? { status: 1 } : undefined,
    stage => stage === 'lookup_wait_v2' ? { status: 1 } : undefined,
    stage => stage === 'lookup_wait_v2' ? { kvError: 2 } : undefined,
    stage => stage === 'lookup' ? { readyDelayMs: 10000 } : undefined,
    stage => stage === 'lookup_wait_v2' ? { wire: Buffer.from('not json') } : undefined,
    stage => stage === 'lookup_wait_v2' ? { wire: Buffer.from('{"__pulseKv":1,"value":{"version":1,"version":2,"nextSweepAtMs":0}}') } : undefined,
  ]) {
    const state = authority({ version: 1, nextSweepAtMs: 0 })
    const before = state.get(store, key)
    const result = healthy(execute({ state, fault }), 'read-failed')
    assert.equal(stages(result, 'insert').length, 0)
    assert.equal(state.get(store, key), before)
  }
})

test('emitted Wasm: invalid persisted schema and timestamps are not overwritten', () => {
  for (const value of [
    null, false, 'sweep', [], {},
    { version: 2, nextSweepAtMs: 0 },
    { version: '1', nextSweepAtMs: 0 },
    { version: 1 },
    { version: 1, nextSweepAtMs: '0' },
    { version: 1, nextSweepAtMs: null },
    { version: 1, nextSweepAtMs: { toString: 'x', valueOf: 'x' } },
    { version: 1, nextSweepAtMs: -1 },
    { version: 1, nextSweepAtMs: 1.5 },
    { version: 1, nextSweepAtMs: 253402300800000 },
  ]) {
    const state = authority(value)
    const before = state.get(store, key)
    const result = healthy(execute({ state }), 'invalid-state')
    assert.equal(stages(result, 'insert').length, 0)
    assert.equal(state.get(store, key), before)
  }
})

test('emitted Wasm: future sweep timestamp is a read-only healthy skip', () => {
  const state = authority({ version: 1, nextSweepAtMs: 100001 })
  const result = healthy(execute({ state }), 'not-due')
  assert.equal(stages(result, 'lookup').length, 1)
  assert.equal(stages(result, 'insert').length, 0)
  assert.deepEqual(persisted(state), { version: 1, nextSweepAtMs: 100001 })
})

test('emitted Wasm: shared authority admits exactly one stale create contender', () => {
  const state = authority()
  // Every invocation is forced to observe the same earlier absent read. Writes
  // arbitrate against one current authority; execution order is deterministic.
  const results = Array.from({ length: 8 }, () => execute({
    state,
    fault: stage => stage === 'lookup_wait_v2' ? { kvError: 3 } : undefined,
  }))
  assert.equal(results.filter(result => result.headers['x-tick-admission'] === 'admitted').length, 1)
  results.forEach((result, index) => {
    healthy(result, index === 0 ? 'admitted' : 'conflict')
    const writes = stages(result, 'insert')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].mode, 1)
    assert.equal(writes[0].condition, undefined)
    assert.equal(writes[0].mask, 0) // No TTL or generation mask for absent insert.
  })
  assert.deepEqual(persisted(state), { version: 1, nextSweepAtMs: 115000 })
})

test('emitted Wasm: shared authority admits exactly one stale CAS contender', () => {
  const generation = 18446744073709551600n
  const state = authority({ version: 1, nextSweepAtMs: 100000 }, generation)
  const observation = state.get(store, key)
  const results = Array.from({ length: 8 }, () => execute({
    state,
    fault: stage => stage === 'lookup' ? { observation } : undefined,
  }))
  assert.equal(results.filter(result => result.headers['x-tick-admission'] === 'admitted').length, 1)
  results.forEach((result, index) => {
    healthy(result, index === 0 ? 'admitted' : 'conflict')
    const writes = stages(result, 'insert')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].condition, generation) // Opaque u64 survives beyond JS integer precision.
    assert.equal(writes[0].mask, 32)
  })
  healthy(execute({ state, nowMs: 100001 }), 'not-due')
})

test('emitted Wasm: uncertain writes never admit even when the write committed', () => {
  for (const fault of [
    stage => stage === 'insert' ? { status: 1, commit: true } : undefined,
    stage => stage === 'insert_wait' ? { status: 1 } : undefined,
    stage => stage === 'insert' ? { readyDelayMs: 10000 } : undefined,
  ]) {
    const result = healthy(execute({ fault }), 'unknown')
    assert.equal(stages(result, 'insert').length, 1)
    assert.deepEqual(persisted(result.state), { version: 1, nextSweepAtMs: 115000 })
    healthy(execute({ state: result.state, nowMs: 100001 }), 'not-due')
  }
})

test('emitted Wasm: a known pre-dispatch write failure never retries or admits', () => {
  const result = healthy(execute({ fault: stage => stage === 'body_new' ? { status: 1 } : undefined }), 'not-stored')
  assert.equal(stages(result, 'insert').length, 0)
  assert.equal(persisted(result.state), undefined)
})

test('emitted Wasm: elapsed KV budget fences prevent further work and late admission', () => {
  const slowRead = healthy(execute({ fault: stage => stage === 'lookup' ? { readyDelayMs: 1500 } : undefined }), 'budget-exhausted')
  assert.equal(stages(slowRead, 'insert').length, 0)
  assert.equal(persisted(slowRead.state), undefined)
  const slowClaim = healthy(execute({ fault: stage => stage === 'insert' ? { readyDelayMs: 1500 } : undefined }), 'claimed-too-late')
  assert.deepEqual(persisted(slowClaim.state), { version: 1, nextSweepAtMs: 115000 })
  const justWithin = healthy(execute({ fault: stage => stage === 'insert' ? { readyDelayMs: 1499 } : undefined }), 'admitted')
  assert.equal(justWithin.headers['x-tick-next-sweep-at-ms'], '115000')
  // These fixtures document the provider's 10s wait ceiling, not a claim that
  // the application can interrupt a pending host operation at its 1.5s budget.
  assert.ok(stages(slowRead, 'select').some(call => call.timeout === 10000))
})

test('emitted Wasm: clock failures and rollback fail closed at each admission fence', () => {
  for (const [samples, expected, committed] of [
    [[null], 'clock-unavailable', false],
    [[100000, null], 'clock-unavailable', false],
    [[100000, 99999], 'budget-exhausted', false],
    [[100000, 100000, null], 'clock-unavailable', true],
    [[100000, 100000, 99999], 'claimed-too-late', true],
  ]) {
    let index = 0
    const result = healthy(execute({ realtimeClock() {
      const sample = samples[Math.min(index++, samples.length - 1)]
      return sample === null ? { status: 1 } : { nanoseconds: BigInt(sample) * 1000000n }
    } }), expected)
    assert.equal(Boolean(persisted(result.state)), committed)
    if (samples[0] === null) assert.deepEqual(kvStages(result), [])
  }
})

test('emitted Wasm: crash after a claim preserves the slot until a later due heartbeat', () => {
  const state = authority()
  assert.throws(() => execute({ state, fault: stage => {
    if (stage === 'insert_wait') throw new Error('fixture invocation terminated after commit')
  } }), /fixture invocation terminated after commit/)
  assert.deepEqual(persisted(state), { version: 1, nextSweepAtMs: 115000 })
  healthy(execute({ state, nowMs: 114999 }), 'not-due')
  const next = healthy(execute({ state, nowMs: 115000 }), 'admitted')
  assert.equal(next.headers['x-tick-next-sweep-at-ms'], '130000')
  assert.deepEqual(persisted(state), { version: 1, nextSweepAtMs: 130000 })
  assert.equal(stages(next, 'insert')[0].mask, 32)
})
