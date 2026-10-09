import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fastly from '@pulse-compute/provider-fastly/testing/fastly-cli'
import runtimeHost from '@pulse-compute/runtime/host'

// Actual emitted Wasm, concurrent HTTP requests, and Viceroy's KV authority.
// This strict local diagnostic is separate from injected-host state-machine
// evidence and deployed Fastly qualification. Known engine defects still fail.
const token = 'fixture-only-not-a-credential'
const key = 'fastly-tick-v1/sweep'
const width = 16
const dueWire = Buffer.from(runtimeHost.encodeConditionalKvValue({ version: 1, nextSweepAtMs: 0 })).toString('utf8')
const trials = [
  { name: 'concurrent-create', entries: {} },
  { name: 'concurrent-cas', entries: { [key]: dueWire } },
]

const header = (response, name) => response.headers.find(([key]) => key.toLowerCase() === name)?.[1]
let passed = 0
for (const trial of trials) {
  const directory = await mkdtemp(join(tmpdir(), 'fastly-tick-admission-'))
  let server
  try {
    await writeFile(join(directory, 'fastly.toml'), fastly.renderFastlyLocalConfig({
      name: 'fastly-tick-admission-fixture',
      secretStores: { tick_secrets: { TICK_PROBE_TOKEN: token } },
      kvStores: { tick_state: trial.entries },
    }))
    server = await fastly.startFastlyComputeServe({
      launcherKind: 'viceroy-direct',
      viceroyBinary: process.env.PULSE_VICEROY_BIN,
      packageRoot: directory,
      wasmFile: resolve('dist/bin/main.wasm'),
      startTimeoutMs: 15000,
    })
    const started = Date.now()
    const results = await Promise.allSettled(Array.from({ length: width }, () => fastly.requestFastlyCompute(server, {
      path: '/__tick/probe',
      headers: { 'x-tick-probe-token': token },
      timeoutMs: 5000,
    })))
    const outcomes = results.map((result) => result.status === 'fulfilled'
      ? header(result.value, 'x-tick-admission') || 'missing-admission'
      : 'request-failed')
    const counts = Object.fromEntries([...new Set(outcomes)].sort().map((outcome) => [outcome, outcomes.filter((item) => item === outcome).length]))
    // Print bounded nonsecret outcomes even when assertions fail.
    console.log(`${trial.name}: ${JSON.stringify(counts)}`)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 0, 'Every concurrent request must complete')
    for (const result of results) {
      const response = result.value
      assert.equal(response.status, 200, 'Every concurrent probe must remain healthy')
      assert.equal(response.body.toString(), 'healthy')
      assert.equal(header(response, 'cache-control'), 'no-store')
      const outcome = header(response, 'x-tick-admission')
      assert.ok(['admitted', 'conflict', 'not-due'].includes(outcome), `Unexpected admission outcome: ${outcome}`)
      const next = header(response, 'x-tick-next-sweep-at-ms')
      if (outcome === 'admitted') {
        assert.match(next || '', /^\d+$/)
        assert.ok(Number(next) >= started + 15000, 'Winner must advance the sweep timestamp')
      } else {
        assert.equal(next, undefined, 'Only a confirmed winner may publish a new sweep timestamp')
      }
    }
    assert.equal(counts.admitted || 0, 1, 'Concurrent arrivals must have exactly one confirmed winner')
    assert.ok(!server.logs.stdout.includes(token) && !server.logs.stderr.includes(token), 'Secret leaked into native logs')
    passed++
    console.log(`ok - native ${trial.name}`)
  } catch (error) {
    process.exitCode = 1
    console.error(`not ok - native ${trial.name}: ${error.message}`)
  } finally {
    if (server) await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
console.log(`${passed}/${trials.length} strict local emitted-Wasm admission trials passed; deployed conditional-write qualification remains separate`)
