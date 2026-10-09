# FT-04 — bounded registry and UTC slots

FT-04 implements selection and first-attempt delivery records. **Dispatch stays
compiled off** pending Pulse [#250](https://github.com/pulse-compute/pulse/issues/250),
[#251](https://github.com/pulse-compute/pulse/issues/251), and
[#252](https://github.com/pulse-compute/pulse/issues/252). The shipped app prepares
zero-attempt pending records, resolves no worker credentials, and sends nothing.
An isolated enabled Native build tests the conditional send and ACK path.
Same-slot redelivery and attempt exhaustion remain FT-05 work. Logging, live
cadence, trusted PoP filtering, and live smoke retain their existing deferrals;
known Viceroy KV/CAS failures remain nonblocking.

## Registry contract

After a confirmed, timely sweep claim, read **`fastly-tick-v1/workers`** from the
existing `tick_state` resource. Store this JSON value using Pulse's conditional
KV envelope (`encodeConditionalKvValue`); plain unwrapped JSON is not a valid
Pulse KV value. Provisioning the store/registry is an operator action.

```json
{
  "schema": "fastly-tick.registry.v1",
  "workers": [{
    "id": "uptime",
    "enabled": true,
    "everyMs": 60000,
    "backend": "uptime",
    "path": "/__tick/run",
    "method": "POST",
    "authSecretRef": "UPTIME_TICK_TOKEN",
    "ackTimeoutMs": 1000,
    "maxAttempts": 3
  }]
}
```

| Field / limit | Policy |
| --- | --- |
| Total workers | 0–8; reject an oversized list, never slice it |
| IDs | Unique, 1–32 lowercase ASCII letters, digits, `_` or `-` |
| Enablement | Required boolean; false leaves its delivery record untouched |
| Interval | Integer multiple of 15,000ms, from 15,000 to 86,400,000ms |
| ACK timeout | Integer 1–1,000ms; default example 1,000ms |
| Attempts | Integer 1–3; default example 3; retries land in FT-05 |
| Destination | Exactly `uptime`, `POST`, `/__tick/run`, `UPTIME_TICK_TOKEN` |
| Custom headers | Unsupported; reject even an empty `headers` object |
| Document | Schema-bound, at most 8 KiB encoded declared content |

There is currently one compiled destination descriptor. Multiple logical worker
IDs can select that same endpoint, but the endpoint must own each configured ID.
The independent fixture accepts only `uptime`. Add actual destinations as literal
fetch sites and bindings when forking; a KV entry cannot authorize a new backend,
URL, path, method, secret reference or protocol header. Unknown extra fields are
ignored by the closed codec and never used as dispatch configuration.

The provider bounds **all raw conditional KV wire reads at 65,560 bytes before
parsing**, with finite node/depth limits. Registry schema and semantic checks then
reject oversized/invalid documents before any delivery lookup or write. This is
not an unbounded parse followed by a worker-list slice. Missing registry is an
empty scheduling opportunity; failed read, unknown version, bad schema,
duplicates or any invalid entry skip the entire document. No fallback workers,
partial registry repair, or overwrite of invalid state is attempted.

## Selection and identity

Each confirmed sweep advances optional `Sweep.nextWorkerIndex` modulo eight.
Old FT-02 sweep documents without that field start at zero and upgrade through
their normal conditional claim; invalid cursors fail closed. A read cannot
advance the cursor or authorize scheduling.

Scan the entire bounded list in cyclic order from `nextWorkerIndex % count`,
choosing up to **two enabled candidate positions**. Examine delivery state only
for those candidates. Not-due, failed or in-flight candidates leave their position
unused rather than scanning more KV records. With a stable registry and normal
budgets, advancing by one gives every enabled position a turn within eight
admitted sweeps, even when earlier entries stay enabled or not-due. Registry
reordering changes rotation order; this is best-effort fairness, not a cadence SLA.

For the heartbeat's initial UTC time `nowMs`:

- `scheduledForMs = nowMs - (nowMs % everyMs)`.
- `runId = id + ':slot:' + scheduledForMs` (timestamp is **milliseconds**).
- First observation of a worker schedules the latest current slot, including slot
  zero near the epoch. Missed slots are dropped; there is no catch-up loop.
- ACKed, exhausted, or already attempted current slots do not send again in
  FT-04. An unattempted prepared record can be conditionally claimed when dispatch
  is enabled. FT-05 will make attempted pending records eligible for bounded retry.
- At a strictly newer slot, replace the old record only after its in-flight
  deadline. A future timestamp never authorizes a replacement.
- Disable/re-enable preserves the record. An interval edit takes effect at a
  strictly newer aligned timestamp; the same/earlier timestamp is not sent again.

## One record per worker

The fixed key is **`fastly-tick-v1/delivery/<id>`**, never a key per interval or
attempt. Its version-one value contains:

```json
{
  "version": 1,
  "runId": "uptime:slot:60000",
  "scheduledForMs": 60000,
  "everyMs": 60000,
  "status": "pending",
  "attempts": 0,
  "nextAttemptAtMs": 60000,
  "inFlightUntilMs": 0
}
```

A missing record uses `insertIfAbsent`; a replacement/prepared first attempt uses
CAS with the observed opaque generation. Only confirmed `stored` authorizes a
send. Conflict, failure and uncertain writes never send or retry immediately.
Enabling dispatch records attempt one and a deadline of claim time plus the ACK
timeout plus 500ms before sending. A failure after that claim may consume an
attempt without a send; the pending record is retained for FT-05 recovery.

An exact, timely 202 ACK is settled through a fresh read and CAS only if the
stored slot, interval, attempt, retry timestamp and in-flight deadline still
match. A newer record cannot be overwritten. `x-tick-dispatch: acked` describes
an observed worker ACK; an uncertain settlement can still leave storage pending.
Tick never polls for completion or reads the ACK body.

At most eight active worker records exist for an unchanged registry. Removed IDs
are no longer read and their records are left for operator cleanup; continuously
inventing new IDs is not a supported retention policy. The application stores no
per-run history. No delete or unconditional write is used in the receiver.

## Bounds and verification

One sweep performs at most one registry read, two delivery reads, two first-attempt
conditional writes, two sends, two settlement reads and two settlement CAS writes.
Including sweep coordination, the maximum is six reads and five conditional
writes. There are two explicit delivery blocks because beta.7 does not permit
writes/fetches inside read loops; the scan itself is pure and literally capped at
eight. No compiler/runtime/package is patched.

Elapsed fences run before registry/delivery work and first-attempt writes, before
send, and before ACK settlement writes. They preserve the existing 1,500ms KV
fence and 4,000ms work fence with response headroom. They **cannot interrupt** the
provider's fixed KV wait or ignored fetch timeout; live total-budget enforcement
is still unproven.

Authenticated winner responses expose bounded counts via `x-tick-workers-considered`,
`x-tick-workers-selected`, and `x-tick-sends`, plus `x-tick-registry`. These are
per-request observations, not aggregate telemetry. Schema errors remain explicit
healthy skips with an invalid registry/delivery outcome.

```sh
npm run verify
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native-registry
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native-dispatch-qualification
```

The emitted-Wasm tests cover registry bounds, due/disabled workers, UTC boundaries,
missed windows, rotation, interval edits, corruption, uncertain/stale writes and
ACK settlement races. Native HTTP checks separately exercise populated registry
reads and preparation against Viceroy. Strict FT-03 timeout, transport and absent
ACK-header checks remain failing diagnostics until Pulse is fixed. Deployed
Fastly behavior is not claimed by either local runner.
