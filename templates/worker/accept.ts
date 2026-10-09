import type { PulseRouteContext } from '@pulse-compute/pulse'

// Implement actual work or a durable handoff before returning true.
// Use runId to make retries idempotent. Returning false leaves Tick unacknowledged.
// Keep this a static ctx-first source helper with scalar inputs for Native.
export async function acceptTick(ctx: PulseRouteContext, runId: string, scheduledForMs: number): Promise<boolean> {
  return false
}
