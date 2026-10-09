import { authority, store, encodeConditionalKvValue, decodeConditionalKvValue } from './admission-fixture.mjs'

export const registryKey = 'fastly-tick-v1/workers'
export const deliveryKey = id => 'fastly-tick-v1/delivery/' + id
export const entry = (id = 'uptime', overrides = {}) => ({
  id, enabled: true, everyMs: 60000, backend: 'uptime', path: '/__tick/run', method: 'POST',
  authSecretRef: 'UPTIME_TICK_TOKEN', ackTimeoutMs: 1000, maxAttempts: 3, ...overrides,
})
export const registry = workers => ({ schema: 'fastly-tick.registry.v1', workers })
export function seed(state, key, value, generation = 1n) {
  state.seed(store, key, encodeConditionalKvValue(value), generation)
  return state
}
export const registryState = (value = registry([entry()])) => seed(authority(), registryKey, value)
export const delivery = (state, id = 'uptime') => {
  const found = state.get(store, deliveryKey(id))
  return found && decodeConditionalKvValue(found.wire)
}
export const record = (id = 'uptime', overrides = {}) => ({
  version: 1, runId: id + ':slot:60000', scheduledForMs: 60000, everyMs: 60000,
  status: 'acked', attempts: 1, nextAttemptAtMs: 100000, inFlightUntilMs: 0, droppedScheduledForMs: -1, ...overrides,
})
