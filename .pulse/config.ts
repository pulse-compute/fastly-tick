import { defineConfig } from '@pulse-compute/pulse'

export default defineConfig((scope) => ({
  pulse: {
    entry: 'src/index.ts',
    schema: 'src/schemas.ts',
    tests: 'test/pulse.harness.ts',
    defaultProfile: 'fastly',
    strict: true,
  },
  fastly: {
    host: 'fastly',
    target: 'native',
    outDir: 'dist',
    probeToken: scope.secret('TICK_PROBE_TOKEN'),
    workerToken: scope.secret('UPTIME_TICK_TOKEN'),
    fastly: {
      bindings: {
        secretStore: 'tick_secrets',
        kv: { tick: 'tick_state' },
        backends: { 'https://uptime.example.com': 'uptime' },
        dynamicBackends: false,
      },
      build: { name: 'fastly-tick' },
    },
  },
}))
