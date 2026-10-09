import type { PulseRouteContext } from '@pulse-compute/pulse'
import type { Receipt } from './schemas.js'

export async function acceptTick(ctx: PulseRouteContext, runId: string, scheduledForMs: number): Promise<boolean> {
  // This fixture's complete work is durably recording an accepted invocation.
  // It ACKs after persistence, with no background task or implied execution queue.
  const receipts = ctx.kv<Receipt>('receipts')
  const receiptKey = 'fastly-tick-fixture/' + runId
  const claim = await receipts.insertIfAbsent(receiptKey, {
    version: 1, runId, worker: 'uptime', scheduledForMs: scheduledForMs,
  })
  if (claim.status === 'conflict') {
    const seen = await receipts.getVersioned(receiptKey)
    if (seen.status !== 'found') return false
    ctx.encodeJson(seen.value, 'fixture.Receipt')
    const value = seen.value
    if (value.version !== 1 || value.runId !== runId || value.worker !== 'uptime' ||
        value.scheduledForMs !== scheduledForMs) return false
  } else if (claim.status !== 'stored') {
    return false
  }
  return true
}
