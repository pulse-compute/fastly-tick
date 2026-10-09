import { Pulse } from '@pulse-compute/pulse'
import type { Sweep, Registry, Delivery } from './schemas.js'

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
  let workerIndex = 0
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
        value.nextSweepAtMs > 253402300799999 || value.nextSweepAtMs % 1 !== 0 ||
        (value.nextWorkerIndex !== undefined && (value.nextWorkerIndex < 0 ||
         value.nextWorkerIndex > 7 || value.nextWorkerIndex % 1 !== 0))) {
      admission = 'invalid-state'
    } else if (clock.unixEpochMs < value.nextSweepAtMs) {
      admission = 'not-due'
    } else {
      due = true
      if (value.nextWorkerIndex !== undefined) workerIndex = value.nextWorkerIndex
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
      const candidate = { version: 1, nextSweepAtMs, nextWorkerIndex: (workerIndex + 1) % 8 }
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
    // The fixed descriptor is still gated on Pulse #250/#251/#252.
    const dispatchEnabled = false
    const requestWorkBudgetMs = 4000
    let dispatch = dispatchEnabled ? 'not-due' : 'disabled'
    let ackLatencyMs = -1
    let registryStatus = 'missing'
    let considered = 0
    let selected = 0
    let sends = 0
    const beforeRegistry = await ctx.time.now()
    if (beforeRegistry.status !== 'ok' || beforeRegistry.unixEpochMs < clock.unixEpochMs ||
        beforeRegistry.unixEpochMs - clock.unixEpochMs >= kvBudgetMs) registryStatus = 'budget-exhausted'
    else {
      const registryStore = ctx.kv<Registry>('tick')
      const registryRead = await registryStore.getVersioned('fastly-tick-v1/workers')
      if (registryRead.status === 'failed') registryStatus = 'read-failed'
      if (registryRead.status === 'found') {
        ctx.state.set('tickPhase', 'registry')
        const encoded = ctx.encodeJson(registryRead.value, 'tick.Registry')
        const registry = registryRead.value
        let valid = registry.schema === 'fastly-tick.registry.v1' &&
          registry.workers.length <= 8 && encoded.length <= 8192
        // Validate the entire bounded document before touching any delivery record.
        for (let i = 0; i < 8 && i < registry.workers.length; i++) {
          const item = registry.workers[i]
          if (item.id.length < 1 || item.id.length > 32 ||
              item.everyMs < 15000 || item.everyMs > 86400000 || item.everyMs % 15000 !== 0 ||
              item.backend !== 'uptime' || item.path !== '/__tick/run' || item.method !== 'POST' ||
              item.authSecretRef !== 'UPTIME_TICK_TOKEN' || item.headers !== undefined ||
              item.ackTimeoutMs < 1 || item.ackTimeoutMs > 1000 || item.ackTimeoutMs % 1 !== 0 ||
              item.maxAttempts < 1 || item.maxAttempts > 3 || item.maxAttempts % 1 !== 0) valid = false
          for (let c = 0; c < 32 && c < item.id.length; c++) {
            const char = item.id[c]
            if (!((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '-' || char === '_')) valid = false
          }
          for (let j = 0; j < 8 && j < i; j++) {
            if (registry.workers[j].id === item.id) valid = false
          }
        }
        registryStatus = valid ? 'ready' : 'invalid'
        if (valid) {
          // Two candidate positions, with a rotating start. Not-due or failed
          // candidates leave capacity unused; later workers still get their turn.
          let first = -1
          let second = -1
          for (let offset = 0; offset < 8 && offset < registry.workers.length; offset++) {
            const index = (workerIndex + offset) % registry.workers.length
            considered++
            if (registry.workers[index].enabled) {
              if (first === -1) first = index
              else if (second === -1) second = index
            }
          }
          const deliveries = ctx.kv<Delivery>('tick')
          // beta.7 permits read-only effects in loops. Keep exactly two explicit
          // conditional-write/send blocks, matching the hard two-worker cap.
          if (first >= 0) {
            const item = registry.workers[first]
            const beforeRead = await ctx.time.now()
            if (beforeRead.status !== 'ok' || beforeRead.unixEpochMs < clock.unixEpochMs ||
                beforeRead.unixEpochMs - clock.unixEpochMs >= kvBudgetMs) registryStatus = 'budget-exhausted'
            else {
              const scheduledForMs = clock.unixEpochMs - (clock.unixEpochMs % item.everyMs)
              const runId = item.id + ':slot:' + scheduledForMs
              const deliveryKey = 'fastly-tick-v1/delivery/' + item.id
              const deliveryRead = await deliveries.getVersioned(deliveryKey)
              let eligible = deliveryRead.status === 'not-found'
              let ready = false
              if (deliveryRead.status === 'found') {
                ctx.state.set('tickPhase', 'delivery')
                ctx.encodeJson(deliveryRead.value, 'tick.Delivery')
                const old = deliveryRead.value
                if (old.version !== 1 || old.everyMs < 15000 || old.everyMs > 86400000 || old.everyMs % 15000 !== 0 ||
                    old.scheduledForMs < 0 || old.scheduledForMs > 253402300799999 || old.scheduledForMs % old.everyMs !== 0 ||
                    old.runId !== item.id + ':slot:' + old.scheduledForMs ||
                    (old.status !== 'pending' && old.status !== 'acked' && old.status !== 'exhausted') ||
                    old.attempts < 0 || old.attempts > 3 || old.attempts % 1 !== 0 ||
                    old.nextAttemptAtMs < 0 || old.nextAttemptAtMs > 253402300799999 || old.nextAttemptAtMs % 1 !== 0 ||
                    old.inFlightUntilMs < 0 || old.inFlightUntilMs > 253402300799999 || old.inFlightUntilMs % 1 !== 0 ||
                    (old.status === 'acked' && old.attempts === 0)) registryStatus = 'invalid-delivery'
                else {
                  // Newer UTC slots replace older records after their in-flight deadline.
                  // A cadence edit cannot re-send the same or an earlier timestamp.
                  eligible = old.scheduledForMs < scheduledForMs && old.inFlightUntilMs <= beforeRead.unixEpochMs
                  ready = old.runId === runId && old.everyMs === item.everyMs && old.status === 'pending' &&
                    old.attempts === 0 && old.inFlightUntilMs === 0
                }
              }
              if (eligible || ready) {
                const beforeWrite = await ctx.time.now()
                if (beforeWrite.status !== 'ok' || beforeWrite.unixEpochMs < beforeRead.unixEpochMs ||
                    beforeWrite.unixEpochMs - clock.unixEpochMs >= kvBudgetMs) registryStatus = 'budget-exhausted'
                else if (scheduledForMs + item.everyMs > 253402300799999) registryStatus = 'invalid-slot'
                else {
                  // Disabled dispatch prepares zero-attempt records. Enabling claims
                  // attempt one before sending; a crash leaves a pending record.
                  const candidateDelivery = {
                    version: 1, runId, scheduledForMs, everyMs: item.everyMs, status: 'pending',
                    attempts: dispatchEnabled ? 1 : 0,
                    nextAttemptAtMs: dispatchEnabled ? beforeWrite.unixEpochMs + resolutionMs : scheduledForMs,
                    inFlightUntilMs: dispatchEnabled ? beforeWrite.unixEpochMs + item.ackTimeoutMs + 500 : 0,
                  }
                  let claimed = 'not-stored'
                  if (ready && !dispatchEnabled) claimed = 'prepared'
                  else if (deliveryRead.status === 'not-found') {
                    const result = await deliveries.insertIfAbsent(deliveryKey, candidateDelivery)
                    claimed = result.status
                  } else if (deliveryRead.status === 'found') {
                    const result = await deliveries.compareAndSwap(deliveryKey, deliveryRead.generation, candidateDelivery)
                    claimed = result.status
                  }
                  if (claimed === 'stored' || claimed === 'prepared') {
                    selected++
                    if (dispatchEnabled) {
                      const workerToken = await ctx.secret.get('UPTIME_TICK_TOKEN')
                      let validToken = true
                      if (!workerToken || workerToken.length < 32 || workerToken.length > 256) validToken = false
                      else {
                        for (let c = 0; c < 256 && c < workerToken.length; c++) {
                          if (workerToken[c] <= ' ' || workerToken[c] > '~') validToken = false
                        }
                      }
                      if (!validToken) dispatch = 'secret-unavailable'
                      else {
                        const beforeSend = await ctx.time.now()
                        if (beforeSend.status !== 'ok' || beforeSend.unixEpochMs < beforeWrite.unixEpochMs) dispatch = 'clock-unavailable'
                        else if (beforeSend.unixEpochMs - clock.unixEpochMs >= requestWorkBudgetMs - item.ackTimeoutMs - 500 ||
                                 beforeSend.unixEpochMs >= candidateDelivery.inFlightUntilMs) dispatch = 'budget-exhausted'
                        else {
                          // Only the compiled destination and reserved headers have authority.
                          const response = await ctx.fetch('https://uptime.example.com/__tick/run', {
                            method: 'POST', timeoutMs: item.ackTimeoutMs,
                            headers: {
                              authorization: 'Bearer ' + workerToken, 'x-tick-invocation-id': runId,
                              'x-tick-attempt': '1', 'x-tick-source': 'fastly-tick', 'content-type': 'application/json',
                            },
                            body: '{"worker":"' + item.id + '","scheduledForMs":' + scheduledForMs + '}',
                          })
                          sends++
                          const afterAck = await ctx.time.now()
                          if (afterAck.status !== 'ok' || afterAck.unixEpochMs < beforeSend.unixEpochMs) dispatch = 'clock-unavailable'
                          else {
                            ackLatencyMs = afterAck.unixEpochMs - beforeSend.unixEpochMs
                            if (ackLatencyMs >= item.ackTimeoutMs) dispatch = 'late-ack'
                            else if (response.status === 202 && response.header('x-tick-invocation-id') === runId) dispatch = 'acked'
                            else dispatch = 'unacknowledged'
                            // Settle only the identical attempt under its current generation.
                            if (dispatch === 'acked' && afterAck.unixEpochMs - clock.unixEpochMs < requestWorkBudgetMs - 500) {
                              const receipt = await deliveries.getVersioned(deliveryKey)
                              if (receipt.status === 'found') {
                                ctx.state.set('tickPhase', 'delivery')
                                ctx.encodeJson(receipt.value, 'tick.Delivery')
                                if (receipt.value.version === 1 && receipt.value.runId === runId && receipt.value.status === 'pending' &&
                                    receipt.value.attempts === 1 && receipt.value.inFlightUntilMs === candidateDelivery.inFlightUntilMs &&
                                    receipt.value.everyMs === item.everyMs && receipt.value.scheduledForMs === scheduledForMs &&
                                    receipt.value.nextAttemptAtMs === candidateDelivery.nextAttemptAtMs) {
                                  const beforeSettle = await ctx.time.now()
                                  if (beforeSettle.status === 'ok' && beforeSettle.unixEpochMs >= afterAck.unixEpochMs &&
                                      beforeSettle.unixEpochMs - clock.unixEpochMs < requestWorkBudgetMs - 500) {
                                    await deliveries.compareAndSwap(deliveryKey, receipt.generation, {
                                      version: 1, runId, scheduledForMs, everyMs: item.everyMs, status: 'acked',
                                      attempts: 1, nextAttemptAtMs: candidateDelivery.nextAttemptAtMs, inFlightUntilMs: 0,
                                    })
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          if (second >= 0) {
            const item = registry.workers[second]
            const beforeRead = await ctx.time.now()
            if (beforeRead.status !== 'ok' || beforeRead.unixEpochMs < clock.unixEpochMs ||
                beforeRead.unixEpochMs - clock.unixEpochMs >= kvBudgetMs) registryStatus = 'budget-exhausted'
            else {
              const scheduledForMs = clock.unixEpochMs - (clock.unixEpochMs % item.everyMs)
              const runId = item.id + ':slot:' + scheduledForMs
              const deliveryKey = 'fastly-tick-v1/delivery/' + item.id
              const deliveryRead = await deliveries.getVersioned(deliveryKey)
              let eligible = deliveryRead.status === 'not-found'
              let ready = false
              if (deliveryRead.status === 'found') {
                ctx.state.set('tickPhase', 'delivery')
                ctx.encodeJson(deliveryRead.value, 'tick.Delivery')
                const old = deliveryRead.value
                if (old.version !== 1 || old.everyMs < 15000 || old.everyMs > 86400000 || old.everyMs % 15000 !== 0 ||
                    old.scheduledForMs < 0 || old.scheduledForMs > 253402300799999 || old.scheduledForMs % old.everyMs !== 0 ||
                    old.runId !== item.id + ':slot:' + old.scheduledForMs ||
                    (old.status !== 'pending' && old.status !== 'acked' && old.status !== 'exhausted') ||
                    old.attempts < 0 || old.attempts > 3 || old.attempts % 1 !== 0 ||
                    old.nextAttemptAtMs < 0 || old.nextAttemptAtMs > 253402300799999 || old.nextAttemptAtMs % 1 !== 0 ||
                    old.inFlightUntilMs < 0 || old.inFlightUntilMs > 253402300799999 || old.inFlightUntilMs % 1 !== 0 ||
                    (old.status === 'acked' && old.attempts === 0)) registryStatus = 'invalid-delivery'
                else {
                  // Newer UTC slots replace older records after their in-flight deadline.
                  // A cadence edit cannot re-send the same or an earlier timestamp.
                  eligible = old.scheduledForMs < scheduledForMs && old.inFlightUntilMs <= beforeRead.unixEpochMs
                  ready = old.runId === runId && old.everyMs === item.everyMs && old.status === 'pending' &&
                    old.attempts === 0 && old.inFlightUntilMs === 0
                }
              }
              if (eligible || ready) {
                const beforeWrite = await ctx.time.now()
                if (beforeWrite.status !== 'ok' || beforeWrite.unixEpochMs < beforeRead.unixEpochMs ||
                    beforeWrite.unixEpochMs - clock.unixEpochMs >= kvBudgetMs) registryStatus = 'budget-exhausted'
                else if (scheduledForMs + item.everyMs > 253402300799999) registryStatus = 'invalid-slot'
                else {
                  // Disabled dispatch prepares zero-attempt records. Enabling claims
                  // attempt one before sending; a crash leaves a pending record.
                  const candidateDelivery = {
                    version: 1, runId, scheduledForMs, everyMs: item.everyMs, status: 'pending',
                    attempts: dispatchEnabled ? 1 : 0,
                    nextAttemptAtMs: dispatchEnabled ? beforeWrite.unixEpochMs + resolutionMs : scheduledForMs,
                    inFlightUntilMs: dispatchEnabled ? beforeWrite.unixEpochMs + item.ackTimeoutMs + 500 : 0,
                  }
                  let claimed = 'not-stored'
                  if (ready && !dispatchEnabled) claimed = 'prepared'
                  else if (deliveryRead.status === 'not-found') {
                    const result = await deliveries.insertIfAbsent(deliveryKey, candidateDelivery)
                    claimed = result.status
                  } else if (deliveryRead.status === 'found') {
                    const result = await deliveries.compareAndSwap(deliveryKey, deliveryRead.generation, candidateDelivery)
                    claimed = result.status
                  }
                  if (claimed === 'stored' || claimed === 'prepared') {
                    selected++
                    if (dispatchEnabled) {
                      const workerToken = await ctx.secret.get('UPTIME_TICK_TOKEN')
                      let validToken = true
                      if (!workerToken || workerToken.length < 32 || workerToken.length > 256) validToken = false
                      else {
                        for (let c = 0; c < 256 && c < workerToken.length; c++) {
                          if (workerToken[c] <= ' ' || workerToken[c] > '~') validToken = false
                        }
                      }
                      if (!validToken) dispatch = 'secret-unavailable'
                      else {
                        const beforeSend = await ctx.time.now()
                        if (beforeSend.status !== 'ok' || beforeSend.unixEpochMs < beforeWrite.unixEpochMs) dispatch = 'clock-unavailable'
                        else if (beforeSend.unixEpochMs - clock.unixEpochMs >= requestWorkBudgetMs - item.ackTimeoutMs - 500 ||
                                 beforeSend.unixEpochMs >= candidateDelivery.inFlightUntilMs) dispatch = 'budget-exhausted'
                        else {
                          // Only the compiled destination and reserved headers have authority.
                          const response = await ctx.fetch('https://uptime.example.com/__tick/run', {
                            method: 'POST', timeoutMs: item.ackTimeoutMs,
                            headers: {
                              authorization: 'Bearer ' + workerToken, 'x-tick-invocation-id': runId,
                              'x-tick-attempt': '1', 'x-tick-source': 'fastly-tick', 'content-type': 'application/json',
                            },
                            body: '{"worker":"' + item.id + '","scheduledForMs":' + scheduledForMs + '}',
                          })
                          sends++
                          const afterAck = await ctx.time.now()
                          if (afterAck.status !== 'ok' || afterAck.unixEpochMs < beforeSend.unixEpochMs) dispatch = 'clock-unavailable'
                          else {
                            ackLatencyMs = afterAck.unixEpochMs - beforeSend.unixEpochMs
                            if (ackLatencyMs >= item.ackTimeoutMs) dispatch = 'late-ack'
                            else if (response.status === 202 && response.header('x-tick-invocation-id') === runId) dispatch = 'acked'
                            else dispatch = 'unacknowledged'
                            // Settle only the identical attempt under its current generation.
                            if (dispatch === 'acked' && afterAck.unixEpochMs - clock.unixEpochMs < requestWorkBudgetMs - 500) {
                              const receipt = await deliveries.getVersioned(deliveryKey)
                              if (receipt.status === 'found') {
                                ctx.state.set('tickPhase', 'delivery')
                                ctx.encodeJson(receipt.value, 'tick.Delivery')
                                if (receipt.value.version === 1 && receipt.value.runId === runId && receipt.value.status === 'pending' &&
                                    receipt.value.attempts === 1 && receipt.value.inFlightUntilMs === candidateDelivery.inFlightUntilMs &&
                                    receipt.value.everyMs === item.everyMs && receipt.value.scheduledForMs === scheduledForMs &&
                                    receipt.value.nextAttemptAtMs === candidateDelivery.nextAttemptAtMs) {
                                  const beforeSettle = await ctx.time.now()
                                  if (beforeSettle.status === 'ok' && beforeSettle.unixEpochMs >= afterAck.unixEpochMs &&
                                      beforeSettle.unixEpochMs - clock.unixEpochMs < requestWorkBudgetMs - 500) {
                                    await deliveries.compareAndSwap(deliveryKey, receipt.generation, {
                                      version: 1, runId, scheduledForMs, everyMs: item.everyMs, status: 'acked',
                                      attempts: 1, nextAttemptAtMs: candidateDelivery.nextAttemptAtMs, inFlightUntilMs: 0,
                                    })
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }

        }
      }
    }
    if (ackLatencyMs >= 0) {
      return ctx.text('healthy', { headers: {
        'cache-control': 'no-store', 'x-tick-admission': admission,
        'x-tick-next-sweep-at-ms': '' + nextSweepAtMs,
        'x-tick-dispatch': dispatch, 'x-tick-ack-latency-ms': '' + ackLatencyMs,
        'x-tick-registry': registryStatus, 'x-tick-workers-considered': '' + considered,
        'x-tick-workers-selected': '' + selected, 'x-tick-sends': '' + sends,
      } })
    }
    return ctx.text('healthy', { headers: {
      'cache-control': 'no-store', 'x-tick-admission': admission,
      'x-tick-next-sweep-at-ms': '' + nextSweepAtMs,
      'x-tick-dispatch': dispatch,
      'x-tick-registry': registryStatus, 'x-tick-workers-considered': '' + considered,
      'x-tick-workers-selected': '' + selected, 'x-tick-sends': '' + sends,
    } })
  }
  return ctx.text('healthy', {
    status: 200,
    headers: { 'cache-control': 'no-store', 'x-tick-admission': admission },
  })
})

app.error(async (error, ctx, next) => {
  if ((error as { code?: string }).code === 'PULSE_SCHEMA_ENCODE') {
    const phase = ctx.state.get('tickPhase')
    if (phase === 'registry' || phase === 'delivery') {
      return ctx.text('healthy', { headers: {
        'cache-control': 'no-store', 'x-tick-admission': 'admitted',
        'x-tick-registry': phase === 'registry' ? 'invalid' : 'invalid-delivery',
      } })
    }
    return ctx.text('healthy', { headers: {
      'cache-control': 'no-store', 'x-tick-admission': 'invalid-state',
    } })
  }
  return next(error)
})

export default app
