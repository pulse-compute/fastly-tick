import { Pulse } from '@pulse-compute/pulse'
import type { Invocation, Receipt } from './schemas.js'

const app = new Pulse({ auto: true })

app.post('/__tick/run', async (ctx) => {
  const headers = ctx.req.headers
  let authorization = ''
  let runId = ''
  let attempt = ''
  let authCount = 0
  let idCount = 0
  let attemptCount = 0
  if (headers.length > 64) return ctx.text('rejected', { status: 401 })
  for (let i = 0; i < 64 && i < headers.length; i++) {
    const pair = headers[i]
    if (pair[0] === 'authorization') { authorization = pair[1]; authCount++ }
    if (pair[0] === 'x-tick-invocation-id') { runId = pair[1]; idCount++ }
    if (pair[0] === 'x-tick-attempt') { attempt = pair[1]; attemptCount++ }
  }
  if (authCount !== 1 || idCount !== 1 || attemptCount !== 1) {
    return ctx.text('rejected', { status: 401 })
  }
  const token = await ctx.secret.get('UPTIME_TICK_TOKEN')
  if (!token || authorization !== 'Bearer ' + token) return ctx.text('rejected', { status: 401 })
  if (attempt !== '1') return ctx.text('invalid invocation', { status: 400 })
  const input = await ctx.req.json<Invocation>('fixture.Invocation')
  if (input.worker !== 'uptime' || input.scheduledForMs < 0 ||
      input.scheduledForMs > 253402300799999 || input.scheduledForMs % 15000 !== 0 ||
      runId !== 'uptime:slot:' + input.scheduledForMs) return ctx.text('invalid invocation', { status: 400 })

  // This fixture's complete work is durably recording an accepted invocation.
  // It ACKs after persistence, with no background task or implied execution queue.
  const receipts = ctx.kv<Receipt>('receipts')
  const receiptKey = 'fastly-tick-fixture/' + runId
  const claim = await receipts.insertIfAbsent(receiptKey, {
    version: 1, runId, worker: input.worker, scheduledForMs: input.scheduledForMs,
  })
  if (claim.status === 'conflict') {
    const seen = await receipts.getVersioned(receiptKey)
    if (seen.status !== 'found') return ctx.text('not accepted', { status: 503 })
    ctx.encodeJson(seen.value, 'fixture.Receipt')
    const value = seen.value
    if (value.version !== 1 || value.runId !== runId || value.worker !== input.worker ||
        value.scheduledForMs !== input.scheduledForMs) return ctx.text('not accepted', { status: 503 })
  } else if (claim.status !== 'stored') {
    return ctx.text('not accepted', { status: 503 })
  }
  return ctx.text('', { status: 202, headers: {
    'x-tick-invocation-id': runId, 'cache-control': 'no-store',
  } })
})

app.error(async (error, ctx, next) => {
  const code = (error as { code?: string }).code
  if (code === 'PULSE_SCHEMA_ENCODE') return ctx.text('not accepted', { status: 503 })
  if (code === 'PULSE_SCHEMA_DECODE' || code === 'PULSE_SCHEMA_JSON_MALFORMED' ||
      code === 'PULSE_SCHEMA_CONTENT_TYPE' || code === 'PULSE_BODY_TOO_LARGE' ||
      code === 'PULSE_REQUEST_BODY_INVALID_UTF8') return ctx.text('invalid invocation', { status: 400 })
  return next(error)
})

export default app
