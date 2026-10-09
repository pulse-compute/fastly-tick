import { defineSchemaRegistry, schema } from '@pulse-compute/pulse/schema'

export interface Sweep { version: number; nextSweepAtMs: number }

export default defineSchemaRegistry({
  schemas: { 'tick.Sweep': schema<Sweep>() },
})
