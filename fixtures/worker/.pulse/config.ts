import { defineConfig } from '@pulse-compute/pulse'

export default defineConfig((scope) => ({
  pulse: { entry: 'src/index.ts', schema: 'src/schemas.ts', strict: true, defaultProfile: 'fastly' },
  fastly: {
    host: 'fastly', target: 'native', outDir: 'dist',
    workerToken: scope.secret('UPTIME_TICK_TOKEN'),
    fastly: {
      bindings: {
        secretStore: 'tick_worker_secrets',
        kv: { receipts: 'worker_state' },
        dynamicBackends: false,
      },
      build: { name: 'fastly-tick-worker-fixture' },
    },
  },
}))
