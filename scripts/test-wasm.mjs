import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { enabledReceiver } from '../test/dispatch-fixture.mjs'

// One enabled build for the four suites, with separate test processes and state.
// The distinct fail-closed PoP variant is still built by the admission suite.
const enabled = enabledReceiver({ shared: null })
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
    'test/admission.test.mjs', 'test/dispatch.test.mjs', 'test/registry.test.mjs',
    'test/redelivery.test.mjs', 'test/observability.test.mjs', 'test/combined-acceptance.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', timeout: 180000,
    env: { ...process.env, FASTLY_TICK_TEST_RECEIVER: enabled.wasmPath,
      FASTLY_TICK_TEST_RECEIVER_SHA256: createHash('sha256').update(enabled.binary).digest('hex') },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  enabled.cleanup()
}
