import { defineSchemaRegistry, schema } from '@pulse-compute/pulse/schema'

import type { TickInvocation } from './tick/schemas.js'
export interface Receipt { version: number; runId: string; worker: string; scheduledForMs: number }

export default defineSchemaRegistry({ schemas: {
  'tick.Invocation': schema<TickInvocation>(),
  'fixture.Receipt': schema<Receipt>(),
} })
