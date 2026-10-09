import { defineConfig } from '@pulse-compute/pulse'

export default defineConfig((scope) => ({
  pulse: {
    entry: 'src/index.ts',
    tests: 'test/pulse.harness.ts',
    defaultProfile: 'fastly',
    strict: true,
  },
  fastly: {
    host: 'fastly',
    target: 'native',
    outDir: 'dist',
    probeToken: scope.secret('TICK_PROBE_TOKEN'),
    fastly: {
      bindings: {
        secretStore: 'tick_secrets',
        dynamicBackends: false,
      },
      build: { name: 'fastly-tick' },
    },
  },
}))
