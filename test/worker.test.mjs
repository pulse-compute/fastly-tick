import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerFiles } from '../scripts/worker.mjs'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const cli = join(root, 'scripts/worker.mjs')
const pulse = join(dirname(require.resolve('@pulse-compute/cli')), '../bin/pulse.js')
const provider = dirname(require.resolve('@pulse-compute/provider-fastly'))
const { executeFastlyNativePlatformCapabilities } = require(join(provider, 'testing/native-platform-capabilities-host.js'))

test('installer rejects invalid inputs and never overwrites an existing directory', () => {
  for (const worker of ['', 'Upper', 'bad/id', 'x'.repeat(33), "x';evil()"])
    assert.throws(() => workerFiles({ worker }), /Worker ID/)
  assert.throws(() => workerFiles({ worker: 'uptime', secret: 'bad secret' }), /Secret/)
  assert.throws(() => workerFiles({ worker: 'uptime', accept: "../evil.js';evil()" }), /relative/)
  const directory = mkdtempSync(join(tmpdir(), 'tick-installer-'))
  try {
    const bin = join(directory, 'fastly-tick')
    symlinkSync(cli, bin)
    execFileSync(process.execPath, [bin, 'worker', 'uptime'], { cwd: directory })
    const handler = join(directory, 'src/tick/handler.ts')
    const before = readFileSync(handler)
    assert.notEqual(spawnSync(process.execPath, [cli, 'worker', 'other'], { cwd: directory }).status, 0)
    assert.deepEqual(readFileSync(handler), before)
    assert.notEqual(spawnSync(process.execPath, [cli, 'worker', 'uptime', '--secret'], { cwd: directory }).status, 0)
    assert.notEqual(spawnSync(process.execPath, [cli, 'worker', 'uptime', '--unknown', 'x'], { cwd: directory }).status, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('freshly installed default Router compiles Native and refuses ACK until acceptance is implemented', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tick-worker-native-'))
  try {
    execFileSync(process.execPath, [cli, 'worker', 'uptime'], { cwd: directory })
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'tick-consumer-test', private: true, type: 'module' }))
    writeFileSync(join(directory, 'src/index.ts'), "import { Pulse } from '@pulse-compute/pulse'\nimport tick from './tick/index.js'\nconst app = new Pulse({ auto: true })\napp.mount('/', tick)\nexport default app\n")
    mkdirSync(join(directory, '.pulse'))
    writeFileSync(join(directory, '.pulse/config.ts'), `import { defineConfig } from '@pulse-compute/pulse'
export default defineConfig(scope => ({
  pulse: { entry: 'src/index.ts', schema: 'src/tick/schemas.ts', strict: true, defaultProfile: 'fastly' },
  fastly: { host: 'fastly', target: 'native', outDir: 'dist', token: scope.secret('TICK_TOKEN'),
    fastly: { bindings: { secretStore: 'worker_secrets', dynamicBackends: false }, build: { name: 'tick-consumer-test' } } },
}))`)
    execFileSync(process.execPath, [pulse, 'build'], { cwd: directory, stdio: 'pipe', timeout: 60000 })
    const build = JSON.parse(readFileSync(join(directory, 'dist/pulse-build.json')))
    assert.equal(build.configuredTarget, 'native')
    assert.equal(build.providerTarget.javascriptRuntime, false)
    const binary = readFileSync(join(directory, 'dist/bin/main.wasm'))
    const token = 'test-worker-token-not-a-credential-12345'
    const headers = { authorization: 'Bearer ' + token, 'x-tick-invocation-id': 'uptime:slot:60000',
      'x-tick-attempt': '1', 'content-type': 'application/json' }
    const request = { method: 'POST', path: '/__tick', headers, body: '{"worker":"uptime","scheduledForMs":60000}' }
    for (const [input, secret, status] of [
      [request, token, 503],
      [{ ...request, headers: {} }, token, 401],
      ...['authorization', 'x-tick-invocation-id', 'x-tick-attempt'].map(name =>
        [{ ...request, headers: { ...headers, [name]: [headers[name], headers[name]] } }, token, 401]),
      [{ ...request, headers: { ...headers, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`extra-${i}`, 'x'])) } }, token, 401],
      [request, '', 401], [request, 'short', 401], [request, token + ' ', 401],
      [{ ...request, body: 'not JSON' }, token, 400],
      [{ ...request, headers: { ...headers, 'x-tick-invocation-id': 'other' } }, token, 400],
      [{ ...request, headers: { ...headers, 'x-tick-attempt': '4' } }, token, 400],
      [{ ...request, body: '{"worker":"other","scheduledForMs":60000}' }, token, 400],
      [{ ...request, body: '{"worker":"uptime","scheduledForMs":60001}' }, token, 400],
    ]) {
      const result = executeFastlyNativePlatformCapabilities(binary, {
        request: input, secretStores: { worker_secrets: { TICK_TOKEN: secret } }, logEndpointFailure: true,
      })
      assert.equal(result.response.status, status)
      assert.equal(Object.fromEntries(result.response.headers)['x-tick-invocation-id'], undefined)
      assert.deepEqual(result.outboundRequests, [])
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
