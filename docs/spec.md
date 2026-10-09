# fastly-tick — v0.1 Specification

**Status:** Proposed / implementation-ready scope, with explicit platform proof gates

**Date:** 2026-10-09

**Repository:** `pulse-compute/fastly-tick` (created; private)

**Execution target:** Pulse → Fastly Native Wasm (`target: native`), no JavaScript fallback

**Design posture:** Fastly-opinionated, best-effort, small, forkable; not enterprise orchestration

## 1. Purpose

Turn Fastly's distributed backend health-check traffic into useful scheduling *opportunities*. A small Native Wasm receiver filters participating PoPs, conditionally admits an eligible sweep through Fastly KV, reads a small worker registry, and dispatches due work to independently deployed Fastly services. The worker acknowledges **acceptance**; Tick does not supervise or await execution completion.

> **Product statement:** Harvest a distributed heartbeat. Admit bounded scheduled work. Dispatch and await ACK. Stop.

`fastly-tick` is a **new standalone application**, not a rewrite of or new abstraction in `@pulse-compute/tick`. Leave the existing `pulse-compute/tick` repository and its implementation untouched. Its prior experiments can be consulted as reference but are not migrated by default. Pulse is the compiler/runtime used by this app, not an authority over the separate Tick project or over worker execution.

## 2. Architecture and boundaries

```text
Fastly trigger service (configured backend health check)
   |  noisy, multi-site, best-effort GET /__tick/probe
   v
fastly-tick — independent Pulse/Fastly Native Wasm service
   |-- authenticate probe (fixed header)
   |-- optional executing-PoP allowlist (early healthy skip)
   |-- KV sweep timestamp read (early healthy skip)
   |-- conditional KV sweep claim (one confirmed winner)
   |-- read bounded KV registry
   |-- inspect due/pending deliveries
   |-- dispatch to preconfigured Fastly worker backends
   |-- accept short ACK; record delivery outcome
   +-- return health-check-safe 200
                   |
                   v
Uptime / other independent Fastly workers
   |-- authenticate + accept invocation
   |-- respond with ACK (not proof of completed work)
   +-- own all subsequent work, results, failure, and deduplication
```

**Tick owns:** heartbeat admission, registry scheduling, per-worker delivery attempts, acknowledgement timeout, bounded redelivery, dispatch visibility.

**Workers own:** accepting invocations, their work, persistence, deduplication, outcome, retries *after* acceptance.

**Fastly owns:** health-check generation, topology, configured service backends, KV, edge execution.

**Pulse owns:** Native compilation, declared effects, and evidence about the emitted artifact.

Fastly service chaining is the preferred worker transport. It normally routes internally within the same cache server, but that behavior is conditional on service topology; it is not a zero-failure or private-network guarantee.

## 3. Deliberate constraints

- **Resolution:** `15s` default; best-effort opportunity to sweep, not a timer promise. No sub-15-second objective in v0.1.
- **Worker schedules:** independent intervals, e.g. Uptime every `60s`; dispatch after a job becomes eligible, not at an exact instant.
- **PoP participation:** optional static allowlist, initially an operator-chosen geographically diverse subset. Count is empirical, not fixed at 10. Nonparticipants return healthy without KV access.
- **Registry:** one small KV-backed list of known workers, with a bounded maximum. Registry may enable/disable workers and define intervals, paths, headers, ACK timeout, and retry budget.
- **Destinations:** only preconfigured Fastly backends. A KV entry selects a declared backend ID; it does not authorize arbitrary URLs or dynamic backend creation. Native fetch call-shape eligibility must be proven before committing to fully dynamic paths or per-worker header maps.
- **Health checks:** a separate trigger service health-checks the Tick receiver. Fastly health checks are periodic independently of subsequent end-user requests once the relevant service/site is initialized; this is the heartbeat mechanism, not a speculative idle-execution feature. Fastly documents that a site initializes on its first end-user request, so deployment and warm-up must account for site activation. The Tick receiver does not recursively request itself or manufacture a timer.
- **No precision SLA:** late/missed heartbeats mean late/missed opportunities. No backlog or catch-up storm.
- **One shared KV store** with namespaced keys; no database or object store required for the orchestration path.
- **Bounded work per request:** finite worker scan, finite dispatches and short per-worker acknowledgement deadline. Configure the upstream Fastly health-check timeout with enough headroom for all awaited work; an ACK timeout must not cause the health-check backend to be marked unhealthy. No work survives the Compute request automatically.

## 4. Configuration (proposed surface, not a promised compile-ready API)

```ts
export default defineFastlyTick({
  resolutionMs: 15_000,
  probePath: '/__tick/probe',
  pops: { mode: 'allowlist', ids: ['IAD', 'LAX', 'LHR', 'FRA'] },
  kvNamespace: 'fastly-tick-v1',
  registryKey: 'workers',
  maxWorkersPerSweep: 8,
  maxDispatchesPerSweep: 2,
  defaults: {
    ackTimeoutMs: 1_000,
    maxAttempts: 3,
  },
})
```

`pops.mode = 'all'` disables filtering; an unavailable executing-PoP identity when an allowlist is enabled must **not** be treated as an allowed PoP. The example PoP IDs are illustrative only. Host access to the actual executing PoP within Pulse Fastly Native is a **proof gate**, not an assumed current capability.

Example KV registry document:

```json
{
  "schema": "fastly-tick.registry.v1",
  "workers": [
    {
      "id": "uptime",
      "enabled": true,
      "everyMs": 60000,
      "backend": "uptime",
      "path": "/__tick/run",
      "method": "POST",
      "ackTimeoutMs": 1000,
      "maxAttempts": 3,
      "headers": { "x-tick-source": "fastly-tick" },
      "authSecretRef": "UPTIME_TICK_TOKEN"
    }
  ]
}
```

The example is a **target contract**, not evidence that arbitrary KV-loaded headers/paths are accepted by the present Native compiler. If necessary, v0.1 uses a fixed worker dispatch table compiled into the app, with KV storing enablement, cadence and delivery state; don't widen the compiler just to gain configuration flexibility.

No plaintext credentials in KV, source, reports, or logs. Configured headers cannot override reserved protocol/auth headers. `authSecretRef` resolves through Fastly Secret Store or an equivalent existing Pulse secret binding.

## 5. Heartbeat and admission

1. Accept a correctly authenticated probe at `GET /__tick/probe`. No body required.
2. If the PoP is not eligible, return `200 healthy`, **before** any KV call.
3. Read `sweep` with `ctx.kv.getVersioned`. If current time is earlier than `nextSweepAtMs`, return `200 healthy`.
4. If due, attempt `insertIfAbsent` or `compareAndSwap` to advance the sweep timestamp/claim. Only a **confirmed** conditional-write winner may read the registry and dispatch.
5. If the claim loses or is uncertain, do not dispatch. Respond healthy for an authenticated health-check probe; report internal status only through bounded telemetry.
6. The winner scans a limited registry slice and dispatches eligible workers, then returns `200 healthy`.

A timestamp read is a fast prefilter, **not** concurrency control. The conditional write arbitrates competing PoPs. Keep the per-sweep mutation and pending-delivery record small and versioned. Avoid extending leases or building a general election algorithm unless measurements show a need.

The health-check response means **the receiver endpoint is healthy**, not that a worker accepted work. A normal coordination error, duplicate, nonparticipating PoP, or worker timeout must not turn the trigger backend unhealthy. In particular, the sum of bounded KV, dispatch and ACK waits must fit beneath the configured health-check timeout with a response reserve. Start with no more than two awaited worker dispatches per sweep, a 1-second ACK budget each, and a separately configured health-check timeout; measure and adjust from the deployed result. Invalid/missing trigger authentication may reject as an access-control error. This separation prevents transient worker trouble from suppressing the heartbeat source.

## 6. Delivery / ACK-only protocol

Tick sends a short authenticated POST through a statically configured Fastly backend:

```http
POST /__tick/run HTTP/1.1
x-tick-invocation-id: uptime:slot:1730000000
x-tick-attempt: 1
x-tick-source: fastly-tick
Authorization: Bearer <injected-secret>
Content-Type: application/json

{"worker":"uptime","scheduledForMs":1730000000000}
```

The worker responds when it **accepts responsibility**, not after it finishes:

```http
HTTP/1.1 202 Accepted
x-tick-invocation-id: uptime:slot:1730000000
Content-Length: 0
```

The illustrative IDs/timestamps above are protocol examples, not wall-clock examples. For v0.1, a valid ACK is `202` with an invocation ID matching the request; the response body is irrelevant. Do not mistakenly treat a generic `200 OK` page or transport success as an ACK. A later version may make status policy configurable if a concrete worker needs it.

- **Valid ACK:** record this delivery accepted. Tick is done; never poll for work completion.
- **Timeout, transport error, malformed ACK, or rejection:** retain the logical invocation as pending for another eligible heartbeat, with `nextAttemptAtMs` and attempt limit.
- **Redelivery:** preserve the same logical invocation ID; increment attempt number. It is *at-least-once delivery attempts*, not exactly-once acceptance or work execution.
- **Worker responsibility:** workers decide how to handle duplicates and how to persist or perform work. They must only ACK when they are willing to own the invocation. Tick provides no durable worker-side execution queue.
- **Bounded retries:** default maximum 3 attempts; do not retry immediately inside one sweep. Unacknowledged attempts are eventually marked exhausted and do not block future windows.

Use one bounded delivery state per worker/active interval, not a forever-growing event log. A delivery record needs stable `runId`, scheduled slot, `status` (`pending`, `acked`, `exhausted`), attempt count, and `nextAttemptAtMs`/short in-flight deadline. Conditional KV updates prevent a second concurrent send before the previous attempt's deadline. If an older window remains unresolved when a newer one is due, v0.1 may expire it rather than backfill; record that as a dropped opportunity.

**Known limitation:** a worker may accept work while its ACK gets lost; a later attempt can duplicate delivery. This is intentional and part of the worker contract.

## 7. Simplicity and non-goals

**Explicitly not included in v0.1:**

- Modifications to `pulse-compute/tick`, its adapters, or its existing tests.
- General scheduler engine, cron syntax, workflow graphs, distributed transactions, multi-cloud support, S3 coordination, automatic PoP leader election, or health-scoring system.
- General package lowering, `app.use(tick)` middleware, arbitrary dynamic HTTP destinations, or an external worker SDK.
- Worker execution monitoring, completion callbacks, job-result collection, or exactly-once guarantees.
- Guaranteed 15-second cadence, backfilling missed slots, priority queues, or autonomous timers inside Wasm.
- A broad evidence archive, new CI bureaucracy, or extra publish/release gates beyond focused proof.

The old `tick` repository is **left alone**, neither archived nor replaced by this work. This spec does not mandate changes in Pulse compiler; a concrete eligibility blocker is recorded before proposing a targeted fix.

## 8. Minimal structure and outputs

```text
fastly-tick/
  README.md
  src/index.ts             # Native Pulse routing and heartbeat
  src/registry.ts          # bounded registry read and due selection
  src/dispatch.ts          # fixed-backend HTTP request and ACK handling
  .pulse/config.ts         # explicit fastly/native profile and bindings
  fastly.toml              # deployment / named resources
  test/                    # focused behavior and Native parity tests
```

Build output must include the actual Fastly Native `bin/main.wasm`, deterministic artifact identity, and a `pulse report --json`/`--html` generated from that artifact. The Apps showcase can later link **Live / Source / Latest Report / Compare**, with compare against the preceding successfully published build. Site integration does not block the first deployed proof.

## 9. Validation: fastest possible falsification

| Gate | Question | Minimal passing evidence |
|---|---|---|
| **FT-00 Native skeleton** | Does an ordinary standalone Pulse Native project build and serve the probe route? | Built `bin/main.wasm`, runnable Fastly provider fixture, one short report |
| **FT-01 Health-check wiring and cadence** | Does the deployed trigger service deliver its already-periodic Fastly health-check requests to Tick, with the expected site initialization and receiver identity? | Confirm live arrivals and configured 15-second interval, account for initial per-site warm-up, observe site/PoP coverage and redeploy behavior. Idle operation is a documented mechanism, not a separate feasibility gate. |
| **FT-02 PoP + KV gate** | Can receiver PoP identity be read in Native and can competing arrivals admit one confirmed sweep? | Real PoP readout or filter deferred; local concurrent KV test plus deployed conditional-write trial; no duplicate confirmed winner |
| **FT-03 Worker ACK** | Does one configured Fastly worker receive and ACK within the request budget? | Real service-to-service dispatch, exact ACK, measured latency; reject bogus ACK |
| **FT-04 Lost ACK** | Will redelivery occur without mistaking acceptance for completed work? | One deliberately lost ACK → later heartbeat sends same ID, bounded retry, eventual ACK recorded |
| **FT-05 Public proof** | Can a stranger deploy and understand it? | README with explicit Fastly setup, source, latest actual build report, minimum telemetry |

Treat Fastly’s periodic health-check mechanism as a platform capability, not an open design hypothesis. **FT-00** establishes the Native application build; **FT-01** verifies deployment wiring, site initialization, cadence, and observed coverage. Neither demands proving from first principles that health checks continue without end-user requests. If unexpected gaps appear, investigate configuration, warm-up, routing, or deployment behavior rather than adding a background clock.

## 10. Operational telemetry (small, not a platform)

Record or display: received trigger count; selected/nonselected PoP count; sweep eligibility and confirmed admissions; registry workers considered; dispatch attempts; valid ACKs, timeouts, failed ACKs, and redeliveries; maximum observed heartbeat gap; lateness between worker due time and successful dispatch attempt. Report median/p95 dispatch-to-ACK latency only once enough real samples exist. Label local synthetic evidence distinctly from deployed Fastly measurements.

Avoid request/response body logging and secret-bearing headers. No unbounded per-attempt evidence retention in the application. Basic Fastly logging and a tiny current-status view are enough for v0.1.

## 11. Definition of done

`fastly-tick` is done for v0.1 when:

1. It is a separate, forkable repository with no imports from `tick` source.
2. It compiles as genuine Pulse **Fastly Native Wasm**, with no JavaScript fallback.
3. Its trigger path responds healthily to authenticated probe traffic without requiring an application user request.
4. It implements configurable resolution and (when proven available) optional PoP filtering, with a conditional KV sweep claim.
5. It dispatches at least one registered worker through an explicit Fastly backend and closes its responsibility on an authentic acceptance ACK.
6. A dropped ACK causes bounded redelivery of the same logical invocation on a subsequent trigger.
7. It has a minimal README, actual build report, and focused tests. Unproven platform behavior remains labeled unproven.

**Success criterion:** A small real Wasm artifact turns noisy distributed health-check traffic into useful, acknowledged, approximately scheduled worker invocations—with clean boundaries and without pretending to provide timing precision or execution guarantees.

## References / verification boundaries

- Fastly health checks: <https://www.fastly.com/documentation/guides/concepts/healthcheck/>
- Health-check API (interval, expected response, headers): <https://www.fastly.com/documentation/reference/api/services/healthcheck/>
- Fastly service chaining: <https://www.fastly.com/documentation/guides/getting-started/services/service-chaining/>
- Pulse Fastly Native deployment: <https://github.com/pulse-compute/pulse/blob/main/docs/guides/deploying-fastly.md>
- Pulse Fastly Native conditional KV realization: <https://github.com/pulse-compute/pulse/blob/main/packages/provider-fastly/src/build/kv-native.as.ts>
- Prior Tick trigger study (reference only, no migration): <https://github.com/pulse-compute/tick/blob/main/proof/README.md>

These references describe current mechanisms, not proof that this new app has been deployed or that every desired Native authoring shape is already eligible.
