import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function plan(input) {
  const c = { ...input }
  for (const key of ['triggerServiceId', 'receiverServiceId']) {
    assert.match(c[key] || '', /^[a-zA-Z0-9]{10,64}$/, `Set ${key}`)
  }
  assert.notEqual(c.triggerServiceId, c.receiverServiceId, 'Trigger and receiver must be separate services')
  for (const key of ['triggerHost', 'receiverHost']) {
    assert.match(c[key] || '', /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, `Use a DNS hostname for ${key}`)
  }
  assert.notEqual(c.triggerHost, c.receiverHost, 'Trigger must not health-check itself')
  for (const key of ['version', 'healthcheckTimeoutMs', 'kvBudgetMs', 'dispatches', 'ackTimeoutMs', 'overheadMs', 'responseReserveMs']) {
    assert.ok(Number.isSafeInteger(c[key]) && c[key] > 0, `Invalid ${key}`)
  }
  assert.ok(c.dispatches <= 2 && c.ackTimeoutMs <= 1000, 'Initial dispatch budget is at most 2 × 1000 ms')
  assert.ok(c.healthcheckTimeoutMs < 15000, 'Timeout must fit within the 15-second interval')
  const plannedWorkMs = c.kvBudgetMs + c.dispatches * c.ackTimeoutMs + c.overheadMs
  assert.ok(plannedWorkMs + c.responseReserveMs <= c.healthcheckTimeoutMs, 'Insufficient response reserve')
  return {
    serviceId: c.triggerServiceId, receiverServiceId: c.receiverServiceId, version: c.version,
    triggerHost: c.triggerHost,
    budget: { plannedWorkMs, responseReserveMs: c.responseReserveMs, healthcheckTimeoutMs: c.healthcheckTimeoutMs },
    healthcheck: {
      name: 'tick_probe', host: c.receiverHost, path: '/__tick/probe', method: 'GET',
      http_version: '1.1', check_interval: 15000, timeout: c.healthcheckTimeoutMs,
      expected_response: 200, window: 5, threshold: 3, initial: 3,
      headers: ['x-tick-probe-token: <runtime-secret>', 'x-tick-probe-kind: healthcheck'],
    },
    backend: {
      name: 'tick_receiver', address: c.receiverHost, port: 443, use_ssl: true,
      ssl_check_cert: true, ssl_cert_hostname: c.receiverHost, ssl_sni_hostname: c.receiverHost,
      override_host: c.receiverHost, healthcheck: 'tick_probe', connect_timeout: 1000,
      first_byte_timeout: c.healthcheckTimeoutMs, between_bytes_timeout: c.healthcheckTimeoutMs,
    },
  }
}

export function form(fields) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    // Fastly health-check headers are a JSON array inside the form field.
    // See fastly/go-fastly client.go: parseHealthCheckHeaders.
    if (Array.isArray(value)) body.set(key, JSON.stringify(value))
    else body.set(key, String(value))
  }
  return body
}

export async function apply(p, env = process.env, request = fetch) {
  assert.ok(env.FASTLY_API_TOKEN, 'FASTLY_API_TOKEN is required for apply')
  assert.match(env.TICK_PROBE_TOKEN || '', /^[\x21-\x7e]{32,256}$/, 'Use a 32–256 character printable token without whitespace')
  const api = async (method, path, fields) => {
    const response = await request(`https://api.fastly.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Fastly-Key': env.FASTLY_API_TOKEN, Accept: 'application/json', ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(fields ? { body: form(fields) } : {}),
    })
    // Never print an API body: validation errors may echo auth header values.
    assert.ok(response.ok, `Fastly ${method} request failed (HTTP ${response.status})`)
    return response.json()
  }
  const root = `/service/${p.serviceId}/version/${p.version}`
  const version = await api('GET', root)
  assert.ok(version.active === false && version.locked === false, 'Select an inactive, unlocked draft version')
  const domains = await api('GET', `${root}/domain`)
  assert.ok(domains.some((d) => d.name === p.triggerHost), 'Configure the trigger domain on this draft first')
  const receiverVersions = await api('GET', `/service/${p.receiverServiceId}/version`)
  const activeReceiver = receiverVersions.find((v) => v.active === true)
  assert.ok(activeReceiver, 'Receiver service has no active version')
  const receiverDomains = await api('GET', `/service/${p.receiverServiceId}/version/${activeReceiver.number}/domain`)
  assert.ok(receiverDomains.some((d) => d.name === p.backend.address), 'Receiver hostname must belong to the separate active receiver service')
  const backends = await api('GET', `${root}/backend`)
  assert.ok(backends.every((b) => b.name === p.backend.name), 'Use a dedicated trigger service with no unrelated backends')
  // One explicit setup smoke, not a source of recurring heartbeat traffic.
  const smoke = await request(`https://${p.healthcheck.host}/__tick/probe`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(p.healthcheck.timeout),
    headers: { 'x-tick-probe-token': env.TICK_PROBE_TOKEN, 'x-tick-probe-kind': 'setup' },
  })
  assert.ok(smoke.status === 200 && await smoke.text() === 'healthy', 'Receiver authentication/TLS smoke failed')
  const checks = await api('GET', `${root}/healthcheck`)
  const healthcheck = { ...p.healthcheck, headers: [`x-tick-probe-token: ${env.TICK_PROBE_TOKEN}`, 'x-tick-probe-kind: healthcheck'] }
  for (const [kind, fields, exists] of [
    ['healthcheck', healthcheck, checks.some((h) => h.name === healthcheck.name)],
    ['backend', p.backend, backends.some((b) => b.name === p.backend.name)],
  ]) await api(exists ? 'PUT' : 'POST', `${root}/${kind}${exists ? `/${fields.name}` : ''}`, fields)
  const saved = await api('GET', `${root}/healthcheck/tick_probe`)
  for (const key of ['host', 'path', 'method', 'check_interval', 'timeout', 'expected_response']) {
    assert.equal(String(saved[key]), String(healthcheck[key]), `Health check readback differs: ${key}`)
  }
  assert.deepEqual(saved.headers, healthcheck.headers, 'Health check headers differ')
  const savedBackend = await api('GET', `${root}/backend/tick_receiver`)
  for (const key of ['address', 'port', 'ssl_cert_hostname', 'ssl_sni_hostname', 'override_host', 'healthcheck']) {
    assert.equal(String(savedBackend[key]), String(p.backend[key]), `Backend readback differs: ${key}`)
  }
  for (const key of ['use_ssl', 'ssl_check_cert']) {
    assert.ok(savedBackend[key] === true || savedBackend[key] === '1' || savedBackend[key] === 1, `Backend disabled ${key}`)
  }
  const validation = await api('GET', `${root}/validate`)
  assert.equal(validation.status, 'ok', 'Fastly rejected the draft configuration')
  return { status: 'draft-configured-and-validated', serviceId: p.serviceId, version: p.version, activated: false, liveHeartbeatProof: 'pending' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, file] = process.argv.slice(2)
    assert.ok(['plan', 'apply'].includes(mode) && file, 'Usage: node scripts/trigger.mjs plan|apply deploy/trigger.local.json')
    const p = plan(JSON.parse(readFileSync(file, 'utf8')))
    console.log(JSON.stringify(mode === 'plan' ? p : await apply(p), null, 2))
  } catch (error) {
    // Assertion messages are fixed and contain no response bodies or secret values.
    console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Trigger setup failed; check configuration, network, and credentials. No response body was logged.')
    process.exitCode = 1
  }
}
