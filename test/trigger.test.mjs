import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { plan, apply, form } from '../scripts/trigger.mjs'
import { summarize } from '../scripts/observe.mjs'

const config = { ...JSON.parse(readFileSync(new URL('../deploy/trigger.example.json', import.meta.url))), triggerServiceId: 'TriggerService123', receiverServiceId: 'ReceiverService123' }
const token = 'public-test-token-not-a-real-secret-123'
const env = { FASTLY_API_TOKEN: 'public-api-fixture', TICK_PROBE_TOKEN: token }

test('TLS/Host routing, fixed interval, redacted plan and response reserve', () => {
  const p = plan(config)
  assert.equal(p.healthcheck.check_interval, 15000)
  assert.equal(p.healthcheck.timeout, 5000)
  assert.equal(p.budget.plannedWorkMs, 4000)
  assert.equal(p.backend.ssl_sni_hostname, config.receiverHost)
  assert.equal(p.backend.ssl_cert_hostname, config.receiverHost)
  assert.equal(p.backend.override_host, config.receiverHost)
  assert.equal(p.backend.ssl_check_cert, true)
  assert.equal(JSON.stringify(p).includes(token), false)
  assert.deepEqual(JSON.parse(form(p.healthcheck).get('headers')), p.healthcheck.headers)
  assert.throws(() => plan({ ...config, responseReserveMs: 1001 }))
  assert.throws(() => plan({ ...config, receiverServiceId: config.triggerServiceId }))
  assert.throws(() => plan({ ...config, receiverHost: 'tick.example.com\r\nx: bad' }))
})

function fixture({ active = false, smokeStatus = 200, backendNames = [], existing = false } = {}) {
  const calls = []
  const p = plan(config)
  const fetcher = async (url, init) => {
    calls.push({ url, init })
    if (url.startsWith('https://tick.example.com/')) return new Response('healthy', { status: smokeStatus })
    assert.equal(new URL(url).origin, 'https://api.fastly.com')
    if (init.method !== 'GET') return Response.json({})
    if (url.endsWith('/validate')) return Response.json({ status: 'ok' })
    if (url.endsWith('/backend/tick_receiver')) return Response.json(p.backend)
    if (url.endsWith('/healthcheck/tick_probe')) return Response.json({ ...p.healthcheck, headers: [`x-tick-probe-token: ${token}`, 'x-tick-probe-kind: healthcheck'] })
    if (url.endsWith('/healthcheck')) return Response.json(existing ? [{ name: 'tick_probe' }] : [])
    if (url.endsWith('/backend')) return Response.json(backendNames.map((name) => ({ name })))
    if (url.endsWith('/domain')) return Response.json([{ name: url.includes(config.receiverServiceId) ? config.receiverHost : config.triggerHost }])
    if (url.endsWith('/version')) return Response.json([{ number: 2, active: true }])
    return Response.json({ active, locked: false })
  }
  return { calls, fetcher }
}

test('draft apply injects runtime auth, validates readback, and never activates', async () => {
  const { calls, fetcher } = fixture()
  const result = await apply(plan(config), env, fetcher)
  assert.equal(result.activated, false)
  const writes = calls.filter((c) => c.init.method !== 'GET')
  assert.equal(writes.length, 2)
  assert.ok(writes.every((c) => c.init.method === 'POST'))
  assert.equal(JSON.parse(writes[0].init.body.get('headers'))[0], `x-tick-probe-token: ${token}`)
  assert.ok(!JSON.stringify(result).includes(token))
  assert.ok(calls.every((c) => !c.url.includes('/activate')))
})

test('rerun updates only the named resources', async () => {
  const { calls, fetcher } = fixture({ existing: true, backendNames: ['tick_receiver'] })
  await apply(plan(config), env, fetcher)
  assert.deepEqual(calls.filter((c) => c.init.method !== 'GET').map((c) => c.init.method), ['PUT', 'PUT'])
})

test('active version, unrelated service, bad auth and header injection stop before writes', async () => {
  for (const options of [{ active: true }, { smokeStatus: 401 }, { backendNames: ['unrelated'] }]) {
    const { calls, fetcher } = fixture(options)
    await assert.rejects(apply(plan(config), env, fetcher))
    assert.equal(calls.filter((c) => c.init.method !== 'GET').length, 0)
  }
  const { calls, fetcher } = fixture()
  await assert.rejects(apply(plan(config), { ...env, TICK_PROBE_TOKEN: token + '\r\nx: bad' }, fetcher))
  assert.equal(calls.length, 0)
})

test('observation keeps configured cadence separate from merged measured gaps', () => {
  const result = summarize([
    { kind: 'healthcheck', atMs: 16000 }, { kind: 'manual', atMs: 9000 },
    { kind: 'healthcheck', atMs: 1000 }, { kind: 'healthcheck', atMs: 50000 },
    { kind: 'healthcheck', atMs: null },
  ].map(e => ({ event: 'fastly_tick.probe', receiver: 'fastly-tick', ...e })), 'local')
  assert.equal(result.source, 'local')
  assert.equal(result.configuredIntervalMs, 15000)
  assert.equal(result.maxObservedGapMs, 34000)
  assert.equal(result.otherProbes, 1)
  assert.equal(result.missingTimestamps, 1)
  assert.equal(summarize([], 'deployed').maxObservedGapMs, null)
  assert.notEqual(result.liveGate, 'passed')
})
