import { defineSchemaRegistry, schema } from '@pulse-compute/pulse/schema'

export interface TickInvocation { worker: string; scheduledForMs: number }

// Merge this ID into the application's schema registry if it already has one.
export default defineSchemaRegistry({ schemas: {
  'tick.Invocation': schema<TickInvocation>(),
} })
