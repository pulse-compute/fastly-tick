import type { PulseContext, PulseRouteContext, RouterNext } from '@pulse-compute/pulse'
import type { TickInvocation } from './schemas.js'
import { acceptTick } from __ACCEPT__

export async function tickHandler(ctx: PulseRouteContext) {
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
  const token = await ctx.secret.get(__TOKEN__)
  if (!token || token.length < 32 || token.length > 256) return ctx.text('rejected', { status: 401 })
  let validToken = true
  for (let i = 0; i < 256 && i < token.length; i++) {
    if (token[i] < '!' || token[i] > '~') validToken = false
  }
  if (!validToken || authorization !== 'Bearer ' + token) return ctx.text('rejected', { status: 401 })
  if (attempt !== '1' && attempt !== '2' && attempt !== '3') return ctx.text('invalid invocation', { status: 400 })
  const input = await ctx.req.json<TickInvocation>('tick.Invocation')
  if (input.worker !== __WORKER__ || input.scheduledForMs < 0 ||
      input.scheduledForMs > 253402300799999 || input.scheduledForMs % 15000 !== 0 ||
      runId !== __RUN_PREFIX__ + input.scheduledForMs) return ctx.text('invalid invocation', { status: 400 })

  const accepted = await acceptTick(ctx, runId, input.scheduledForMs)
  if (accepted !== true) return ctx.text('not accepted', { status: 503 })
  return ctx.text('', { status: 202, headers: {
    'x-tick-invocation-id': runId, 'cache-control': 'no-store',
  } })
}

export async function tickError(error: unknown, ctx: PulseContext, next: RouterNext) {
  const code = (error as { code?: string }).code
  if (code === 'PULSE_SCHEMA_ENCODE') return ctx.text('not accepted', { status: 503 })
  if (code === 'PULSE_SCHEMA_DECODE' || code === 'PULSE_SCHEMA_JSON_MALFORMED' ||
      code === 'PULSE_SCHEMA_CONTENT_TYPE' || code === 'PULSE_BODY_TOO_LARGE' ||
      code === 'PULSE_REQUEST_BODY_INVALID_UTF8') return ctx.text('invalid invocation', { status: 400 })
  return next(error)
}
