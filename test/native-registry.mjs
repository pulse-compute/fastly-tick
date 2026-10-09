import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fastly from '@pulse-compute/provider-fastly/testing/fastly-cli'
import { token, encodeConditionalKvValue } from './admission-fixture.mjs'
import { registryKey, registry, entry } from './registry-fixture.mjs'

const header = (response, name) => response.headers.find(([key]) => key.toLowerCase() === name)?.[1]
const wire = value => Buffer.from(encodeConditionalKvValue(value)).toString('utf8')
const trials = [
  { name: 'eight workers, two preparations', value: registry(Array.from({ length: 8 }, (_, i) => entry('w' + i))), status: 'ready', selected: '2', considered: '8' },
  { name: 'disabled worker', value: registry([entry('uptime', { enabled: false })]), status: 'ready', selected: '0', considered: '1' },
  { name: 'invalid interval', value: registry([entry('uptime', { everyMs: 1 })]), status: 'invalid', selected: '0', considered: '0' },
  { name: 'oversized list', value: registry(Array.from({ length: 9 }, (_, i) => entry('w' + i))), status: 'invalid', selected: '0', considered: '0' },
]
let passed = 0
for (const trial of trials) {
  const directory = await mkdtemp(join(tmpdir(), 'fastly-tick-registry-'))
  let server
  try {
    await writeFile(join(directory, 'fastly.toml'), fastly.renderFastlyLocalConfig({
      name: 'fastly-tick-registry-fixture',
      secretStores: { tick_secrets: { TICK_PROBE_TOKEN: token } },
      kvStores: { tick_state: { [registryKey]: wire(trial.value) } },
    }))
    server = await fastly.startFastlyComputeServe({ launcherKind: 'viceroy-direct',
      viceroyBinary: process.env.PULSE_VICEROY_BIN, packageRoot: directory,
      wasmFile: resolve('dist/bin/main.wasm'), startTimeoutMs: 15000,
    })
    const response = await fastly.requestFastlyCompute(server, {
      path: '/__tick/probe', headers: { 'x-tick-probe-token': token }, timeoutMs: 5000,
    })
    const outcome = { admission: header(response, 'x-tick-admission'), registry: header(response, 'x-tick-registry'),
      selected: header(response, 'x-tick-workers-selected') ?? '0', considered: header(response, 'x-tick-workers-considered') ?? '0' }
    console.log(JSON.stringify({ case: trial.name, ...outcome }))
    assert.equal(response.status, 200)
    assert.equal(response.body.toString(), 'healthy')
    assert.equal(outcome.admission, 'admitted')
    assert.equal(outcome.registry, trial.status)
    assert.equal(outcome.selected, trial.selected)
    assert.equal(outcome.considered, trial.considered)
    if (trial.status === 'ready') {
      assert.equal(header(response, 'x-tick-dispatch'), 'disabled')
      assert.equal(header(response, 'x-tick-sends'), '0')
    }
    assert.ok(!server.logs.stdout.includes(token) && !server.logs.stderr.includes(token))
    passed++
    console.log('ok - native ' + trial.name)
  } catch (error) {
    process.exitCode = 1
    console.error('not ok - native ' + trial.name + ': ' + error.message)
  } finally {
    if (server) await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
console.log(`${passed}/${trials.length} local Native registry HTTP checks passed; live smoke deferred`)
