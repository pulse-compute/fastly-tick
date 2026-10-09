// Execute the emitted application Wasm against an injected Fastly ABI host.
// The shared authority models conditional writes; it is not live Fastly evidence.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const providerRoot = dirname(require.resolve('@pulse-compute/provider-fastly'))
const { executeFastlyNativePlatformCapabilities } = require(join(providerRoot, 'testing/native-platform-capabilities-host.js'))
const { createConditionalKvAuthority } = require(join(providerRoot, 'testing/conditional-kv-host.js'))
const { encodeConditionalKvValue, decodeConditionalKvValue } = require('@pulse-compute/runtime/host')

export const store = 'tick_state'
export const key = 'fastly-tick-v1/sweep'
export const token = 'fixture-only-not-a-credential'
export const wasm = readFileSync(new URL('../dist/bin/main.wasm', import.meta.url))
export { encodeConditionalKvValue, decodeConditionalKvValue }

export function authority(value, generation = 1n) {
  const result = createConditionalKvAuthority()
  result.stores.set(store, new Map())
  if (value !== undefined) result.seed(store, key, encodeConditionalKvValue(value), generation)
  return result
}

export function execute({ state = authority(), nowMs = 100000, headers, fault, binary = wasm, ...options } = {}) {
  const calls = []
  const result = executeFastlyNativePlatformCapabilities(binary, {
    clockUnixSeconds: nowMs / 1000,
    logEndpointFailure: true, // Admission never depends on the deferred log sink.
    ...options,
    request: { path: '/__tick/probe', headers: headers ?? { 'x-tick-probe-token': token } },
    secretStores: { tick_secrets: { TICK_PROBE_TOKEN: token } },
    conditionalKv: {
      authority: state,
      onCall(stage, detail) {
        calls.push({ stage, ...detail })
        return fault?.(stage, detail)
      },
    },
  })
  return { ...result, state, calls, headers: Object.fromEntries(result.response.headers) }
}

export function persisted(state) {
  const item = state.get(store, key)
  return item && decodeConditionalKvValue(item.wire)
}
