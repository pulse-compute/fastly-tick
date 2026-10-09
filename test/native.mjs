import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fastly from '@pulse-compute/provider-fastly/testing/fastly-cli'
import harness from './pulse.harness.ts'

// Execute the same cases against the emitted module through real Fastly hostcalls.
// Viceroy is an explicit external test dependency, never an application runtime.
// The raw canonical fixture preserves input casing; Fastly's header-list ABI
// normalizes names. Test that transport normalization on the actual module.
const authenticated = harness.cases.find((test) => test.name === 'authenticated-probe')
const cases = [...harness.cases, {
  ...authenticated,
  name: 'mixed-case-wire-header',
  request: { path: '/__tick/probe', headers: { 'X-Tick-Probe-Token': authenticated.secrets.TICK_PROBE_TOKEN } },
}]
const groups = Map.groupBy(cases, (test) => JSON.stringify(test.secrets))
let passed = 0
for (const [secrets, cases] of groups) {
  const directory = await mkdtemp(join(tmpdir(), 'fastly-tick-'))
  let server
  try {
    await writeFile(join(directory, 'fastly.toml'), fastly.renderFastlyLocalConfig({
      name: 'fastly-tick-fixture',
      secretStores: { tick_secrets: JSON.parse(secrets) },
    }))
    server = await fastly.startFastlyComputeServe({
      launcherKind: 'viceroy-direct',
      viceroyBinary: process.env.PULSE_VICEROY_BIN,
      packageRoot: directory,
      wasmFile: resolve('dist/bin/main.wasm'),
      extraArgs: ['--log-stdout', '-v'],
      startTimeoutMs: 15000,
    })
    for (const test of cases) {
      let headers = test.request.headers
      if (Array.isArray(headers)) {
        const grouped = {}
        for (const [key, value] of headers) (grouped[key] ||= []).push(value)
        headers = grouped
      }
      const response = await fastly.requestFastlyCompute(server, { ...test.request, headers, timeoutMs: 3000 })
      assert.equal(response.status, test.expect.status, `${test.name}: status`)
      if (test.expect.text !== undefined) assert.equal(response.body.toString(), test.expect.text, `${test.name}: body`)
      for (const [name, value] of test.expect.headers || []) {
        assert.equal(response.headers.find(([key]) => key.toLowerCase() === name)?.[1], value, `${test.name}: ${name}`)
      }
      console.log(`ok - native ${test.name}`)
      passed++
    }
    // Logging must not disclose any fixture credentials.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const logs = server.logs.stdout + server.logs.stderr
    for (const value of Object.values(JSON.parse(secrets))) {
      if (value) assert.ok(!logs.includes(value), 'Secret leaked into native logs')
    }
    if (process.argv.includes('--require-logs') && cases.some((test) => test.expect.status === 200)) {
      assert.ok(logs.includes('fastly_tick.probe'), 'Authenticated Native probe emitted no observation')
    }
  } finally {
    if (server) await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
console.log(`${passed}/${cases.length} emitted-Wasm HTTP tests passed`)
