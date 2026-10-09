# FT-06 — minimal operational visibility

The application exposes bounded HTTP observations and a protected current-state
view. Structured logs and their summarizer are implemented, but Native logging
qualification and the integrated deployed proof remain **deferred** by the owner.
FT-06's live acceptance gates are still open. Dispatch stays compiled off pending
Pulse [#250](https://github.com/pulse-compute/pulse/issues/250),
[#251](https://github.com/pulse-compute/pulse/issues/251), and
[#252](https://github.com/pulse-compute/pulse/issues/252).

## Current state without triggering work

`GET /__tick/status` requires the same `x-tick-probe-token` authentication as the
probe. It returns schema-bound JSON with `Cache-Control: no-store`. For the local
fixture only:

```sh
curl -sS -H 'x-tick-probe-token: fixture-only-not-a-credential' \
  -H 'x-tick-worker-id: uptime' http://127.0.0.1:7676/__tick/status
```

Omit `x-tick-worker-id` for the sweep alone. A supplied ID must be 1–32 lowercase
letters, digits, `_` or `-`, with no duplicate selector. The endpoint reads the
sweep and at most one worker delivery record. It never reads the registry,
resolves worker credentials, claims a sweep, writes KV, sends work, or records
itself as a heartbeat. A selector may name a retired worker's record; this view
does not imply current registry membership or enablement.

The response labels its scope `current-persisted-records`, reports observation
time, static shipped settings, qualification deferrals, read statuses, sweep
deadline, and the selected delivery's status/attempt/deadlines/drop marker. `-1`
means unavailable or no known drop. Reads are independent snapshots, not a
transaction. `acked` describes persisted acceptance, not worker completion or
recent liveness. A future sweep deadline alone does not prove fresh heartbeats.

Invalid values and failed reads are labeled without echoing raw KV. Schema
failure or an unavailable clock returns `503 status unavailable`; it cannot
affect probe health. The second read is skipped after the 1,500ms elapsed fence.
The provider's fixed KV wait remains a qualification gap for this endpoint too.
The status settings mirror the shipped probe constants and must be updated when
dispatch/PoP settings change; the enabled test variant is not a deployment.

## Per-probe observations

Authenticated probe responses retain admission/registry/dispatch headers and add:

| Headers | Meaning |
| --- | --- |
| `x-tick-observed-at-ms`, `x-tick-probe-kind` | Initial clock sample and caller-supplied kind; kind is not source proof |
| `x-tick-pop-mode`, `x-tick-receiver-pop` | Static selection policy; trusted executing PoP remains unavailable |
| `x-tick-workers-considered`, `x-tick-workers-selected`, `x-tick-sends` | Request-local selection and completed outbound calls |
| `x-tick-acks`, `x-tick-ack-timeouts`, `x-tick-invalid-acks` | Exact timely ACKs, observed late responses, and rejection/mismatched ACKs |
| `x-tick-ack-latency-one-ms`, `x-tick-ack-latency-two-ms` | Individual valid-ACK latency samples; `-1` means no sample |
| `x-tick-redeliveries`, `x-tick-exhausted`, `x-tick-dropped` | Completed retry calls and confirmed exhaustion/replacement writes |
| `x-tick-dispatch-lateness-ms` | Maximum send-start minus scheduled slot among this probe's completed sends |
| `x-tick-response-elapsed-ms` | Before probe secret lookup through the pre-response clock sample; excludes header scan, final log/response construction and transmission |

Counts are per response, never aggregate KV counters. Skipped probes have no
dispatch work. Schema error responses or fatal provider exits may lack outcome
metrics; missing metrics are unknown, not zero. Legacy `x-tick-dispatch` and
`x-tick-ack-latency-ms` describe the last handled send, so use the new counts and
individual samples for two-worker observations. ACK observations and confirmed
ACK persistence remain separate, as described in [redelivery](redelivery.md).
`ack-timeouts` currently means an observed late return, not successful timeout
cancellation or healthy transport recovery.

The app attempts one `fastly_tick.probe` arrival log and one closed
`fastly_tick.outcome` summary. It includes no IDs, bodies, tokens, secret-bearing
headers, opaque generations, or raw KV. Logging failure does not gate work.
Fatal exits and schema errors can leave arrivals without outcome logs.

Logging remains unqualified for two separate reasons:

- The beta.7 reserved-stdout endpoint fails under Viceroy; see [trigger](trigger.md).
- KV read/write redaction masks unrelated metric keys after reading a registry:
  `considered` becomes `cons<redacted>ered` when KV contains the key `id`.
  [Pulse #254](https://github.com/pulse-compute/pulse/issues/254) tracks this new
  reproduction. The summarizer rejects the altered event shape; no redaction or
  provider code is bypassed here. HTTP headers/current-state JSON remain usable.

## Bounded summaries

After Pulse logging is repaired and checked on the deployed receiver, stop a
short log-tail session and summarize it:

```sh
node scripts/observe.mjs deployed < receiver.log
```

The reader accepts at most 10,000 events, 16 MiB of input, and 4 KiB per line. It
drops malformed/unrelated lines and preserves only closed fields. It reports
time range, source, observed arrivals/outcomes, admission and PoP-selection
counts, worker/send/ACK/retry/drop/exhaustion totals, unclassified sends, and
maximum merged healthcheck-tagged arrival gap. Unknown executing-PoP coverage
and incomplete coverage are explicit. Manual probes do not enter cadence gaps.
No sample means unknown, not zero. Limits and rejected lines are reported.

ACK median/p95 appear only at 20 individual valid-ACK samples, with sample count;
p95 uses nearest rank. Per-probe maximum lateness and work-time summaries are
labeled separately. This sample threshold is a display rule, not a statistical
confidence or precision SLA. `local` is labeled synthetic; `deployed` never
certifies the live gate. Missing logs, multiple sites, crashes, clock skew, and
caller-supplied kind limit all conclusions. No per-site or complete service
counters can be inferred. The exported `fromHeaders` helper normalizes the same
closed response metadata for existing operator tooling while logging is deferred;
it does not manufacture arrival history or poll the receiver.

## Integrated proof and remaining gates

`npm run verify` builds the actual Native receiver/worker, checks artifact identity,
and exercises focused admission, transport, registry, redelivery and operational
fixtures. `npm run test:observability` checks status isolation/auth/privacy,
independent receiver/worker ACK visibility, both ACK samples, healthy rejection
and late-return observations, log failures, summary bounds, and percentile rules.
The prior lost-ACK, stale-contender and crash tests remain in the normal gate.
Each fixture invocation is a fresh Wasm instance with external conditional KV
state; this is synthetic persistence evidence, not a Fastly redeploy result.

The combined-wait fixture injects 50ms per KV operation plus two 999ms ACK waits.
It observes 2,548ms of probe work, leaving the configured 1,000ms reserve under
the 5,000ms upstream timeout. Authentication now enters elapsed fences: a slow
probe secret lookup stops before any KV. Late work stops another candidate.
These fences cannot interrupt fixed KV waits or the ignored fetch timeout.
Healthy timeout/transport recovery and a universal response deadline remain
unproven; the existing strict HTTP qualification keeps its failed assertions.

| Gate | Current result |
| --- | --- |
| Genuine Native build/report and focused state transitions | Locally verified; report identifies actual artifact/configuration |
| Protected status and bounded observations | Verified through emitted Wasm; Native HTTP checked separately |
| Native log endpoint and usable post-KV log shape | Deferred; existing stdout gap plus Pulse #254 |
| Trusted receiver PoP / filtering | Deferred; all-PoP mode |
| Live trigger arrivals, warm-up, coverage and redeploy | Deferred; no deployed cadence claim |
| Live conditional-write arbitration and overlapping probes | Deferred; known Viceroy discrepancies remain nonblocking |
| Live service-to-service ACK and deliberately lost ACK → retry | Deferred; synthetic two-module recovery is verified |
| Slow/unavailable worker within health-check budget | Pending Pulse timeout/error fixes, then deployed qualification |

For the eventual bounded live run, use the setup in [trigger](trigger.md) and
[dispatch](dispatch.md). Identify receiver/worker service versions, trigger
version, report SHA-256, bindings, intervals and timeout settings; record the
observation range and coverage. Exercise exact ACK, lost ACK/retry, overlapping
probes, receiver redeploy, rejection and a slow/unavailable worker. Keep a concise
passed/pending result with sample counts and actual timings, then discard raw
logs. No deployment, credential provisioning, polling scheduler, evidence archive,
dashboard platform or worker completion tracking is introduced by FT-06.
