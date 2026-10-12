import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fastly from '@pulse-compute/provider-fastly/testing/fastly-cli'
import { registry, entry, registryKey } from './registry-fixture.mjs'
import { encodeConditionalKvValue } from './admission-fixture.mjs'
import { token } from './admission-fixture.mjs'
import { enabledReceiver, workerToken } from './dispatch-fixture.mjs'

// Real loopback HTTP through Viceroy. The Node origin is only an adversarial
// transport fixture; the final case uses a separate Native worker service.
const enabled = enabledReceiver()
const header = (response, name) => response.headers.find(([key]) => key.toLowerCase() === name)?.[1]
const cases = []
let passed = 0
let total = 0
let mode = 'valid'
let captured
const timers = new Set()
const origin = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    // The provider's readiness helper probes backend GET /. This origin is an
    // adversarial POST transport fixture; readiness is not a worker ACK.
    if (request.method === 'GET' && request.url === '/') { response.end('ready'); return }
    captured = { method: request.method, path: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString() }
    if (mode === 'reset') { request.socket.destroy(); return }
    const status = mode === 'generic-200' ? 200 : mode === 'rejected' ? 503 : 202
    const headers = mode === 'missing-id' || !request.headers['x-tick-invocation-id'] ? {} : {
      'x-tick-invocation-id': mode === 'wrong-id' ? 'other' : request.headers['x-tick-invocation-id'],
    }
    const later = (ms, action) => {
      const timer = setTimeout(() => { timers.delete(timer); action() }, ms)
      timers.add(timer)
    }
    if (mode === 'slow-headers') {
      later(1400, () => { response.writeHead(status, headers); response.end('ignored') })
    } else {
      response.writeHead(status, headers)
      if (mode === 'slow-body') { response.flushHeaders(); later(2000, () => response.end('ignored')) }
      else response.end('ignored')
    }
  })
})
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
const originUrl = `http://127.0.0.1:${origin.address().port}`

async function server({ wasmFile, name, backends, secretStores, kvStores }) {
  const directory = await mkdtemp(join(tmpdir(), 'fastly-tick-http-'))
  try {
    await writeFile(join(directory, 'fastly.toml'), fastly.renderFastlyLocalConfig({ name, backends, secretStores, kvStores }))
    const instance = await fastly.startFastlyComputeServe({
      launcherKind: 'viceroy-direct', viceroyBinary: process.env.PULSE_VICEROY_BIN,
      packageRoot: directory, wasmFile, startTimeoutMs: 15000,
    })
    return { ...instance, async cleanup() {
      await instance.stop()
      await rm(directory, { recursive: true, force: true })
    } }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function probe(backendUrl, check) {
  const receiver = await server({ name: 'fastly-tick-dispatch-fixture', wasmFile: enabled.wasmPath,
    backends: { uptime: { url: backendUrl, overrideHost: 'uptime.example.com' } },
    secretStores: { tick_secrets: { TICK_PROBE_TOKEN: token, UPTIME_TICK_TOKEN: workerToken } },
    kvStores: { tick_state: { [registryKey]: Buffer.from(encodeConditionalKvValue(registry([entry()]))).toString('utf8') } },
  })
  try {
    const started = performance.now()
    const response = await fastly.requestFastlyCompute(receiver, {
      path: '/__tick/probe', headers: { 'x-tick-probe-token': token }, timeoutMs: 3500,
    })
    const elapsedMs = performance.now() - started
    console.log(JSON.stringify({ case: mode, status: response.status,
      dispatch: header(response, 'x-tick-dispatch') ?? null, elapsedMs: Math.round(elapsedMs),
      ackLatencyMs: header(response, 'x-tick-ack-latency-ms') ?? null }))
    await check(response, elapsedMs)
    assert.ok(!JSON.stringify(receiver.logs).includes(workerToken), 'Worker token leaked into logs')
  } finally { await receiver.cleanup() }
}

async function trial(name, work) {
  total++
  try { await work(); passed++; cases.push({ name, status: 'passed' }); console.log(`ok - native ${name}`) }
  catch (error) { cases.push({ name, status: 'failed' }); process.exitCode = 1; console.error(`not ok - native ${name}: ${error.message}`) }
}

function healthy(response, outcome) {
  assert.equal(response.status, 200)
  assert.equal(response.body.toString(), 'healthy')
  assert.equal(header(response, 'x-tick-dispatch'), outcome)
  assert.equal(header(response, 'cache-control'), 'no-store')
}

let worker
try {
  for (const [name, outcome] of [
    ['valid', 'acked'], ['generic-200', 'unacknowledged'], ['missing-id', 'unacknowledged'],
    ['wrong-id', 'unacknowledged'], ['rejected', 'unacknowledged'], ['slow-body', 'acked'],
  ]) {
    mode = name
    await trial(name, () => probe(originUrl, (response, elapsedMs) => {
      healthy(response, outcome)
      assert.equal(captured.method, 'POST')
      assert.equal(captured.path, '/__tick/run')
      assert.equal(captured.headers.authorization, 'Bearer ' + workerToken)
      assert.match(captured.headers['x-tick-invocation-id'], /^uptime:slot:\d+$/)
      assert.equal(captured.headers['x-tick-attempt'], '1')
      assert.equal(captured.headers['x-tick-source'], 'fastly-tick')
      const input = JSON.parse(captured.body)
      assert.equal(input.worker, 'uptime')
      assert.equal(input.scheduledForMs % 60000, 0)
      assert.equal(captured.headers['x-tick-invocation-id'], 'uptime:slot:' + input.scheduledForMs)
      assert.ok(elapsedMs < 1000, 'ACK/body-free response must arrive before one second')
    }))
  }
  worker = await server({ name: 'independent-native-worker',
    wasmFile: resolve('fixtures/worker/dist/bin/main.wasm'),
    secretStores: { tick_worker_secrets: { UPTIME_TICK_TOKEN: workerToken } },
    kvStores: { worker_state: {} },
  })
  mode = 'independent-native-worker'
  await trial(mode, () => probe(worker.baseUrl, response => healthy(response, 'acked')))

  if (process.argv.includes('--qualify')) {
    await trial('missing worker auth', async () => {
      const response = await fastly.requestFastlyCompute(worker, { method: 'POST', path: '/__tick/run',
        headers: { 'x-tick-invocation-id': 'uptime:slot:60000', 'x-tick-attempt': '1', 'content-type': 'application/json' },
        body: '{"worker":"uptime","scheduledForMs":60000}' })
      assert.equal(response.status, 401)
      assert.equal(header(response, 'x-tick-invocation-id'), undefined)
    })
    mode = 'slow-headers'
    await trial('strict ACK deadline', () => probe(originUrl, (response, elapsedMs) => {
      assert.equal(response.status, 200)
      assert.equal(response.body.toString(), 'healthy')
      healthy(response, 'unacknowledged')
      assert.equal(header(response, 'x-tick-dispatch-error'), mode === 'reset' ? 'transport' : 'timeout')
      assert.ok(elapsedMs <= 1250, `One-second ACK wait exceeded: ${Math.round(elapsedMs)}ms`)
    }))
    mode = 'reset'
    await trial('strict healthy transport failure', () => probe(originUrl, response => {
      assert.equal(response.status, 200)
      assert.equal(response.body.toString(), 'healthy', 'Transport failure must remain an explicit healthy skip')
      healthy(response, 'unacknowledged')
      assert.equal(header(response, 'x-tick-dispatch-error'), mode === 'reset' ? 'transport' : 'timeout')
    }))
  }
} finally {
  if (worker) await worker.cleanup()
  for (const timer of timers) clearTimeout(timer)
  origin.closeAllConnections()
  await new Promise(resolve => origin.close(resolve))
  enabled.cleanup()
}
console.log(`${passed}/${total} local Native dispatch HTTP checks passed; live Fastly smoke remains deferred`)

if (process.env.FASTLY_TICK_NATIVE_DISPATCH_REPORT) await writeFile(process.env.FASTLY_TICK_NATIVE_DISPATCH_REPORT,
  JSON.stringify({ status: passed === total ? 'passed' : 'failed', evidence: 'Viceroy-loopback-HTTP', cases }, null, 2) + '\n')
