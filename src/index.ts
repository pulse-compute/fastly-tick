import { Pulse } from '@pulse-compute/pulse'

const app = new Pulse({ auto: true })

app.get('/__tick/probe', async (ctx) => {
  // beta.7's direct header lookup does not reject an absent header correctly
  // in Viceroy. Read the normalized lowercase header pairs and reject duplicates.
  const headers = ctx.req.headers
  let supplied = ''
  let matches = 0
  let probeKind = 'manual'
  if (headers.length > 64) {
    return ctx.text('unauthorized', { status: 401 })
  }
  for (let i = 0; i < 64 && i < headers.length; i++) {
    const pair = headers[i]
    if (pair[0] === 'x-tick-probe-token') {
      supplied = pair[1]
      matches++
    }
    if (pair[0] === 'x-tick-probe-kind' && pair[1] === 'healthcheck') {
      probeKind = 'healthcheck'
    }
  }
  if (matches !== 1 || !supplied) {
    return ctx.text('unauthorized', { status: 401 })
  }

  const expected = await ctx.secret.get('TICK_PROBE_TOKEN')
  if (!expected || supplied !== expected) {
    return ctx.text('unauthorized', { status: 401 })
  }

  // Caller-supplied kind is observation metadata, never admission authority.
  // Actual executing-PoP identity remains unproven until FT-02.
  const clock = await ctx.time.now()
  if (clock.status === 'ok') {
    ctx.log.info('{"event":"fastly_tick.probe","receiver":"fastly-tick","kind":"' + probeKind + '","atMs":' + clock.unixEpochMs + ',"receiverPop":null}')
  } else {
    ctx.log.info('{"event":"fastly_tick.probe","receiver":"fastly-tick","kind":"' + probeKind + '","atMs":null,"receiverPop":null}')
  }

  // Receiver health only. Scheduling and worker delivery belong to later tickets.
  return ctx.text('healthy', {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
})

export default app
