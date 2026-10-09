import { Pulse } from '@pulse-compute/pulse'

const app = new Pulse({ auto: true })

app.get('/__tick/probe', async (ctx) => {
  // beta.7's direct header lookup does not reject an absent header correctly
  // in Viceroy. Read the normalized lowercase header pairs and reject duplicates.
  const headers = ctx.req.headers
  let supplied = ''
  let matches = 0
  if (headers.length > 64) {
    return ctx.text('unauthorized', { status: 401 })
  }
  for (let i = 0; i < 64 && i < headers.length; i++) {
    const pair = headers[i]
    if (pair[0] === 'x-tick-probe-token') {
      supplied = pair[1]
      matches++
    }
  }
  if (matches !== 1 || !supplied) {
    return ctx.text('unauthorized', { status: 401 })
  }

  const expected = await ctx.secret.get('TICK_PROBE_TOKEN')
  if (!expected || supplied !== expected) {
    return ctx.text('unauthorized', { status: 401 })
  }

  // Receiver health only. Scheduling and worker delivery belong to later tickets.
  return ctx.text('healthy', {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
})

export default app
