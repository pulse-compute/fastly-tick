import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute, authority, token } from './admission-fixture.mjs'

import { seed, registryKey, registry as document, entry } from './registry-fixture.mjs'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const provider = dirname(require.resolve('@pulse-compute/provider-fastly'))
const { executeFastlyNativePlatformCapabilities } = require(join(provider, 'testing/native-platform-capabilities-host.js'))
export const workerToken = 'fixture-worker-token-not-a-credential'
export const runId = 'uptime:slot:60000'
export const workerUrl = 'https://uptime.example.com/__tick/run'
export const workerBinary = readFileSync(join(root, 'fixtures/worker/dist/bin/main.wasm'))

export function enabledReceiver({ shared = process.env.FASTLY_TICK_TEST_RECEIVER } = {}) {
  // The suite runner owns this temporary build; standalone commands still build
  // their own variant. Never silently fall back if shared bytes are missing/stale.
  if (shared) {
    const binary = readFileSync(shared)
    assert.equal(createHash('sha256').update(binary).digest('hex'), process.env.FASTLY_TICK_TEST_RECEIVER_SHA256)
    return { binary, wasmPath: shared, cleanup() {} }
  }
  const directory = mkdtempSync(join(tmpdir(), 'fastly-tick-dispatch-'))
  try {
    for (const path of ['src', '.pulse/config.ts', 'test/pulse.harness.ts', 'package.json']) {
      const destination = join(directory, path)
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(join(root, path), destination, { recursive: true })
    }
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    const file = join(directory, 'src/index.ts')
    const source = readFileSync(file, 'utf8')
    assert.equal(source.split('const dispatchEnabled = false').length, 2)
    writeFileSync(file, source.replace('const dispatchEnabled = false', 'const dispatchEnabled = true'))
    const cli = join(dirname(require.resolve('@pulse-compute/cli')), '../bin/pulse.js')
    execFileSync(process.execPath, [cli, 'build'], { cwd: directory, stdio: 'pipe', timeout: 60000 })
    return { binary: readFileSync(join(directory, 'dist/bin/main.wasm')),
      wasmPath: join(directory, 'dist/bin/main.wasm'), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function receiver(binary, { workerSecret = workerToken, fixture, delayMs = 0, registry = document([entry()]), state = authority(), ...options } = {}) {
  if (registry !== undefined) seed(state, registryKey, registry)
  const captured = []
  const result = execute({ binary, state, secrets: { TICK_PROBE_TOKEN: token, UPTIME_TICK_TOKEN: workerSecret },
    fixtures: { [workerUrl]: fixture ?? { status: 202, headers: { 'x-tick-invocation-id': runId }, body: 'ignored body' } },
    onOutboundRequest: request => captured.push(request),
    hostcallDelayMs: { 'fastly_http_req.pending_req_wait': delayMs },
    ...options,
  })
  return { ...result, captured }
}

export function worker({ state = authority(), request, fault } = {}) {
  state.stores.set('worker_state', state.stores.get('worker_state') ?? new Map())
  const calls = []
  const result = executeFastlyNativePlatformCapabilities(workerBinary, {
    request: request ?? { method: 'POST', path: '/__tick/run', headers: {
      authorization: 'Bearer ' + workerToken, 'x-tick-invocation-id': runId,
      'x-tick-attempt': '1', 'content-type': 'application/json',
    }, body: '{"worker":"uptime","scheduledForMs":60000}' },
    secretStores: { tick_worker_secrets: { UPTIME_TICK_TOKEN: workerToken } },
    conditionalKv: { authority: state, onCall(stage, detail) { calls.push({ stage, ...detail }); return fault?.(stage, detail) } },
    logEndpointFailure: true,
  })
  return { ...result, state, calls }
}
