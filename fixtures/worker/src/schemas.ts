import { defineSchemaRegistry, schema } from '@pulse-compute/pulse/schema'

export interface Invocation { worker: string; scheduledForMs: number }
export interface Receipt { version: number; runId: string; worker: string; scheduledForMs: number }

export default defineSchemaRegistry({ schemas: {
  'fixture.Invocation': schema<Invocation>(),
  'fixture.Receipt': schema<Receipt>(),
} })
