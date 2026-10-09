# Connect an external Pulse worker

Install `@pulse-compute/fastly-tick` into a Pulse project, then generate a local
worker handler. The command creates a new directory and refuses to overwrite it:

```sh
npx fastly-tick worker uptime
# Options: --dir src/tick --secret TICK_TOKEN --accept ../accept.js
```

The worker ID must match the scheduler registry. The default secret name is
**`TICK_TOKEN`**; its value must match the scheduler's dedicated worker credential
and contain 32–256 printable, non-whitespace ASCII characters. The secret name
can differ between services. Store the value in each service's Secret Store.
`--accept` imports an existing local module exporting `acceptTick`; its path is
relative to the generated `handler.ts`, using a `.js` specifier for TypeScript.

Register the generated handler in your app. The default endpoint is **`/__tick`**:

```ts
import { Pulse } from '@pulse-compute/pulse'
import { tickHandler, tickError } from './tick/handler.js'

const app = new Pulse({ auto: true })
app.post('/__tick', tickHandler)
app.error(tickError)
export default app
```

Alternatively, the generated `src/tick/index.ts` exports a Router already
registering POST `/__tick` and its error handler:

```ts
import tick from './tick/index.js'
app.mount('/', tick)
```

The Router imports `@pulse-compute/runtime`; declare that package in the consuming
project when using the mounted form. Generated source is yours to review and
modify. Pulse beta.7 admits static local handlers and ctx-first source helpers
on Native; arbitrary npm handler factories are outside that compiler contract.
The installer avoids requiring a custom lowerer or a JavaScript fallback.

## Configuration

For a new worker, use `src/tick/schemas.ts` as `pulse.schema`. If the app already
has a registry, import the generated `TickInvocation` type and add
`'tick.Invocation': schema<TickInvocation>()` to that registry instead. Keep the
schema ID used by `handler.ts` and the registry identical.

In the selected `.pulse/config.ts` profile, declare the credential and Fastly
resource link:

```ts
workerToken: scope.secret('TICK_TOKEN'),
fastly: {
  bindings: {
    secretStore: 'tick_worker_secrets',
    dynamicBackends: false,
    // Add KV/backends required by your acceptance implementation.
  },
},
```

**`TICK_URL` is not needed for inbound worker acceptance.** Tick calls this route,
and the route replies directly to that request. There is no registration API or
callback POST to the scheduler. If your app later calls Tick's authenticated
status/probe API, declare `tickUrl: scope.config('TICK_URL')` in its profile and
read `await ctx.config.get('TICK_URL')` in that separate handler; Fastly Native
fetch still needs an explicitly configured backend and an eligible static URL.
A URL is not authentication and no incoming URL/header chooses the scheduler.

The shipped scheduler still uses the fixed `/__tick/run` descriptor. To connect
to that candidate, register `app.post('/__tick/run', tickHandler)` instead (or
alongside the default route) and generate with
`--secret UPTIME_TICK_TOKEN`. Its named backend, literal URL and registry path
must agree; adding this helper does not register a backend or migrate existing
registries. Dispatch remains compiled off pending the documented Pulse fixes.

## Acceptance belongs to the worker

Implement `src/tick/accept.ts`:

```ts
export async function acceptTick(
  ctx: PulseRouteContext, runId: string, scheduledForMs: number,
): Promise<boolean> {
  // Complete actual work or confirm durable ownership here.
  // Deduplicate using runId; a retry carries the same ID.
  return false
}
```

The generated stub deliberately returns false. Only **true**, after actual work
or a durable handoff, permits a response with status **202** and an exact
`x-tick-invocation-id`. False returns 503 without that header. Do not start a
background promise and ACK: Compute request termination does not guarantee it
will run. Acceptance is not a completion receipt or an exactly-once guarantee.

The helper rejects missing/duplicate protocol headers, invalid credentials,
attempts outside 1–3, wrong worker IDs, invalid 15-second UTC slots, malformed
schema input and mismatched run IDs before invoking `acceptTick`. Keep Native
acceptance code within Pulse's static source-helper contract: `ctx` first,
explicitly typed scalar inputs, a boolean result, trusted effects, no callbacks,
nested helpers or response construction. The caller owns the ACK.

The independent fixture supplies a receipt-based acceptance implementation and
tests the same generated handler's Native Wasm, including duplicates and failed
persistence. The installer test also compiles a fresh default Router and proves
the unfinished stub cannot ACK. Live service-to-service smoke remains deferred.
