import { defineSchemaRegistry, schema } from '@pulse-compute/pulse/schema'
import type { ScalarRecord } from '@pulse-compute/pulse/schema'

// Cursor is optional so the FT-02 sweep document can be upgraded in place.
export interface Sweep { version: number; nextSweepAtMs: number; nextWorkerIndex?: number }
export interface Worker {
  id: string; enabled: boolean; everyMs: number; backend: string; path: string
  method: string; authSecretRef: string; ackTimeoutMs: number; maxAttempts: number
  headers?: ScalarRecord
}
export interface Registry { schema: string; workers: Worker[] }
export interface Delivery {
  version: number; runId: string; scheduledForMs: number; everyMs: number
  status: string; attempts: number; nextAttemptAtMs: number; inFlightUntilMs: number
  droppedScheduledForMs?: number
}
export interface Observation {
  event: string; receiver: string; kind: string; atMs: number; popMode: string
  receiverPop: string; admission: string; registry: string
  considered: number; selected: number; sends: number; acks: number
  ackTimeouts: number; invalidAcks: number; redeliveries: number
  exhausted: number; dropped: number; ackLatencyOneMs: number; ackLatencyTwoMs: number
  dispatchLatenessMs: number; responseElapsedMs: number
}
export interface Status {
  schema: string; observedAtMs: number; scope: string; dispatch: string; popMode: string
  receiverPop: string; logging: string; liveGate: string; resolutionMs: number
  kvBudgetMs: number; requestWorkBudgetMs: number; responseReserveMs: number
  healthcheckTimeoutMs: number; ackTimeoutCapMs: number; maxSends: number
  sweepRead: string; nextSweepAtMs: number; workerId: string; deliveryRead: string
  deliveryStatus: string; scheduledForMs: number; attempts: number
  nextAttemptAtMs: number; inFlightUntilMs: number; droppedScheduledForMs: number
}

export default defineSchemaRegistry({
  schemas: {
    'tick.Sweep': schema<Sweep>(),
    'tick.Registry': schema<Registry>({ json: {
      maxTextBytes: 8192, maxJsonBytes: 8192, maxDepth: 4, maxNodes: 160,
      maxArrayItems: 8, maxObjectMembers: 12, maxStringLength: 64, maxKeyLength: 32,
    } }),
    'tick.Delivery': schema<Delivery>(),
    'tick.Observation': schema<Observation>(),
    'tick.Status': schema<Status>(),
  },
})
