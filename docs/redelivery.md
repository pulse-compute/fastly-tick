# FT-05 — bounded redelivery and crash recovery

FT-05 completes the delivery transitions on top of the [registry and slot
contract](registry.md). Dispatch remains compiled off pending deployed
qualification with the pinned Pulse beta.8 packages.
The default app can prepare records but does not consume retry attempts or
resolve worker credentials. The enabled test variant executes the real emitted
Wasm; no production gate or provider code is patched.

## Attempt policy

A pending delivery is eligible for another attempt only when:

- Its ID and interval still describe the current UTC slot.
- `attempts < maxAttempts` (registry limit 1–3, default 3).
- Both `nextAttemptAtMs` and `inFlightUntilMs` have passed.
- This request has confirmed sweep admission and sufficient remaining budget.

CAS reserves the next attempt before sending. The request retains the same
`runId` and `scheduledForMs`; only `x-tick-attempt` increases. Each reservation
sets `nextAttemptAtMs = claimTime + 15000` and
`inFlightUntilMs = claimTime + ackTimeoutMs + 500`. There is no same-sweep retry.
A confirmed write is required: conflict, failed and unknown claims never send,
even when an unknown write actually committed.

The pre-send fence requires enough time for the entire ACK budget within both
the attempt's in-flight deadline and the request work budget. Slow claims,
missing credentials or process termination can consume an attempt without a
send; that is deliberate conservative accounting. Elapsed fences cannot cancel
the provider's fixed KV wait. Beta.8 enforces the fetch deadline and exposes
recoverable errors; live smoke remains deferred.

## Outcomes and recovery

| Event | Persisted behavior |
| --- | --- |
| Exact timely 202 with matching ID | CAS to `acked`; stop delivering that invocation |
| Rejection, wrong/missing ACK, or late response | CAS to `pending`, or `exhausted` after the last allowed attempt |
| Crash before/after send or recoverable transport failure | Claimed pending record survives; another heartbeat may retry after both deadlines |
| Last attempt crashes | After its in-flight deadline, a later heartbeat conditionally marks it exhausted without sending |
| Unknown result-write outcome | The next versioned read determines whether ACK/exhaustion committed; no guessed success |
| Newer slot while old record remains pending | After its in-flight deadline, conditionally replace it with the current slot; do not backfill |

Result writes require the stored invocation, interval, attempt number, retry
stamp, in-flight deadline and dropped-slot marker to match the reserved attempt.
The final write also uses the fresh opaque generation. A late result cannot
replace a newer attempt or slot. A confirmed worker ACK and a confirmed Tick
record update are separate observations: `x-tick-dispatch: acked` reports the
former even if its persistence is uncertain.

A newer slot takes precedence over retrying an older pending window. One optional
`droppedScheduledForMs` field records the most recently replaced pending slot
inside the same worker record (`-1` means none). It survives retries and later
ACK settlement; there is no per-run history or backlog. FT-04 records without
this field are accepted and acquire it on their next conditional transition.
Only confirmed replacement increments the per-request `x-tick-dropped` count.
`x-tick-exhausted` counts confirmed exhaustion writes and `x-tick-redeliveries`
counts completed outbound retry calls. Fatal provider exits cannot emit these
response observations; aggregate telemetry remains FT-06 work.

Disabling a worker preserves its state. Re-enabling may retry a still-current
pending slot after both deadlines. Lowering `maxAttempts` can retire a pending
record after its in-flight deadline; raising it does not resurrect an exhausted
slot. Interval changes retain FT-04's rule: no resend at the same or earlier
aligned timestamp. Exhausted and expired windows do not block newer slots.

## What is proven

`npm run test:redelivery` executes the receiver and independent worker Wasm
against injected Fastly ABIs and a shared conditional KV authority. The lost-ACK
case has the worker persist acceptance, then injects a transport failure before
Tick receives the ACK. Beta.8 returns a healthy unacknowledged response with a
transport error marker; the next heartbeat recovers the pending record and sends the
same ID with attempt two. The worker ACKs the duplicate receipt, Tick records
`acked`, and a later heartbeat sends nothing for that slot.

This proves bounded delivery-state and healthy transport-error recovery through
injected Native ABIs. It does not prove live KV arbitration or a deployed lost-ACK
gate; strict HTTP qualification remains separate. Known
Viceroy KV/CAS discrepancies remain documented and nonblocking; logging and live
cadence retain their existing deferrals.

Other focused cases cover both retry fences, attempt ceilings, crash boundaries,
unknown claim/settlement outcomes, stale concurrent contenders, late ACKs, older
window expiry, configuration changes, both candidate positions, and timestamp
bounds. No worker completion is polled. Worker acceptance followed by a lost ACK
can cause duplicate delivery; this is never an exactly-once contract.
