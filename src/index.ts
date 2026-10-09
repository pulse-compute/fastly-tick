import { Pulse } from '@pulse-compute/pulse'
import type { Sweep } from './schemas.js'

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

  // Static app settings. Rebuild after changing them. beta.7 has no trusted
  // executing-PoP API: all mode works; any filtering mode must skip before KV.
  const popMode = 'all'
  const resolutionMs = 15000
  const kvBudgetMs = 1500
  if (popMode !== 'all') {
    return ctx.text('healthy', { headers: {
      'cache-control': 'no-store', 'x-tick-admission': 'pop-unavailable',
    } })
  }

  // Caller-supplied kind and location headers carry no admission authority.
  const clock = await ctx.time.now()
  if (clock.status === 'ok') {
    ctx.log.info('{"event":"fastly_tick.probe","receiver":"fastly-tick","kind":"' + probeKind + '","atMs":' + clock.unixEpochMs + ',"receiverPop":null}')
  } else {
    ctx.log.info('{"event":"fastly_tick.probe","receiver":"fastly-tick","kind":"' + probeKind + '","atMs":null,"receiverPop":null}')
    return ctx.text('healthy', { headers: {
      'cache-control': 'no-store', 'x-tick-admission': 'clock-unavailable',
    } })
  }

  const store = ctx.kv<Sweep>('tick')
  const key = 'fastly-tick-v1/sweep'
  const seen = await store.getVersioned(key)
  let admission = 'read-failed'
  let due = false
  if (seen.status === 'not-found') {
    due = true
  } else if (seen.status === 'found') {
    // beta.7 accepts `typeof` at build time but cannot execute it in Native.
    // Use its supported schema validator; the error lane below skips bad data.
    ctx.encodeJson(seen.value, 'tick.Sweep')
    const value = seen.value
    // The generic type is not persisted-data validation. Unknown versions and
    // corrupt values fail closed; an operator must repair them, never overwrite.
    if (value.version !== 1 || value.nextSweepAtMs < 0 ||
        value.nextSweepAtMs > 253402300799999 || value.nextSweepAtMs % 1 !== 0) {
      admission = 'invalid-state'
    } else if (clock.unixEpochMs < value.nextSweepAtMs) {
      admission = 'not-due'
    } else {
      due = true
    }
  }

  let nextSweepAtMs = 0
  if (due) {
    const beforeClaim = await ctx.time.now()
    // These fences prevent starting MORE work after a slow KV operation. They
    // cannot interrupt beta.7's fixed 10s KV wait; see docs/admission.md.
    if (beforeClaim.status !== 'ok') {
      admission = 'clock-unavailable'
    } else if (beforeClaim.unixEpochMs < clock.unixEpochMs ||
               beforeClaim.unixEpochMs - clock.unixEpochMs >= kvBudgetMs) {
      admission = 'budget-exhausted'
    } else if (resolutionMs < 15000 || resolutionMs % 1 !== 0 ||
               beforeClaim.unixEpochMs + resolutionMs > 253402300799999) {
      admission = 'invalid-settings'
    } else {
      nextSweepAtMs = beforeClaim.unixEpochMs + resolutionMs
      const candidate = { version: 1, nextSweepAtMs }
      // A read only filters. The opaque storage generation arbitrates the write.
      // No unconditional writes, TTL, deletion, or retry within this heartbeat.
      if (seen.status === 'not-found') {
        const claim = await store.insertIfAbsent(key, candidate)
        admission = claim.status
      } else if (seen.status === 'found') {
        const claim = await store.compareAndSwap(key, seen.generation, candidate)
        admission = claim.status
      }
      if (admission === 'stored') {
        const afterClaim = await ctx.time.now()
        if (afterClaim.status !== 'ok') {
          admission = 'clock-unavailable'
        } else if (afterClaim.unixEpochMs < beforeClaim.unixEpochMs ||
                   afterClaim.unixEpochMs - clock.unixEpochMs >= kvBudgetMs) {
          admission = 'claimed-too-late'
        } else {
          // The only future registry/dispatch entry point. A failure after this
          // claim loses this opportunity; leave it in place until the next due
          // heartbeat. This is admission, not a renewable lease or completion.
          admission = 'admitted'
        }
      }
    }
  }

  // Small authenticated HTTP observations make admission inspectable even while
  // Native log delivery is deferred. No generation, token, or raw KV payload is exposed.
  if (admission === 'admitted') {
    // FT-03 fixed transport descriptor. Disabled until Native fetch can return
    // recoverable errors and enforce an ACK deadline; registry/slots are FT-04.
    const dispatchEnabled = false
    const runId = 'uptime:slot:0'
    const ackTimeoutMs = 1000
    const requestWorkBudgetMs = 4000
    let dispatch = 'disabled'
    let ackLatencyMs = -1
    if (dispatchEnabled) {
      const workerToken = await ctx.secret.get('UPTIME_TICK_TOKEN')
      let validToken = true
      if (!workerToken || workerToken.length < 32 || workerToken.length > 256) {
        validToken = false
      } else {
        // Secret values must fit one printable, whitespace-free HTTP header.
        for (let i = 0; i < 256 && i < workerToken.length; i++) {
          if (workerToken[i] <= ' ' || workerToken[i] > '~') validToken = false
        }
      }
      if (!validToken) {
        dispatch = 'secret-unavailable'
      } else {
        const beforeSend = await ctx.time.now()
        if (beforeSend.status !== 'ok') {
          dispatch = 'clock-unavailable'
        } else if (beforeSend.unixEpochMs < clock.unixEpochMs ||
                   beforeSend.unixEpochMs - clock.unixEpochMs >= requestWorkBudgetMs - ackTimeoutMs - 500) {
          dispatch = 'budget-exhausted'
        } else {
          // Literal destination + named backend, closed protocol headers, and a
          // dedicated Secret Store credential. No caller/registry URL or headers.
          const response = await ctx.fetch('https://uptime.example.com/__tick/run', {
            method: 'POST', timeoutMs: 1000,
            headers: {
              authorization: 'Bearer ' + workerToken,
              'x-tick-invocation-id': runId,
              'x-tick-attempt': '1',
              'x-tick-source': 'fastly-tick',
              'content-type': 'application/json',
            },
            body: '{"worker":"uptime","scheduledForMs":0}',
          })
          const afterAck = await ctx.time.now()
          if (afterAck.status !== 'ok' || afterAck.unixEpochMs < beforeSend.unixEpochMs) {
            dispatch = 'clock-unavailable'
          } else {
            ackLatencyMs = afterAck.unixEpochMs - beforeSend.unixEpochMs
            if (ackLatencyMs >= ackTimeoutMs) {
              dispatch = 'late-ack'
            } else if (response.status === 202 && response.header('x-tick-invocation-id') === runId) {
              dispatch = 'acked'
            } else {
              dispatch = 'unacknowledged'
            }
          }
          // Never read the response body, poll completion, or retry immediately.
          // Native timeoutMs/transport recovery qualification is in docs/dispatch.md.
        }
      }
    }
    if (ackLatencyMs >= 0) {
      return ctx.text('healthy', { headers: {
        'cache-control': 'no-store', 'x-tick-admission': admission,
        'x-tick-next-sweep-at-ms': '' + nextSweepAtMs,
        'x-tick-dispatch': dispatch, 'x-tick-ack-latency-ms': '' + ackLatencyMs,
      } })
    }
    return ctx.text('healthy', { headers: {
      'cache-control': 'no-store', 'x-tick-admission': admission,
      'x-tick-next-sweep-at-ms': '' + nextSweepAtMs,
      'x-tick-dispatch': dispatch,
    } })
  }
  return ctx.text('healthy', {
    status: 200,
    headers: { 'cache-control': 'no-store', 'x-tick-admission': admission },
  })
})

app.error(async (error, ctx, next) => {
  if ((error as { code?: string }).code === 'PULSE_SCHEMA_ENCODE') {
    return ctx.text('healthy', { headers: {
      'cache-control': 'no-store', 'x-tick-admission': 'invalid-state',
    } })
  }
  return next(error)
})

export default app
