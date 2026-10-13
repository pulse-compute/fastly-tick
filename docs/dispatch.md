# FT-03 — fixed worker dispatch and exact ACK

The static transport and worker fixture use Pulse beta.8. **Dispatch remains
disabled by default pending deployed qualification.** Native timeout, recoverable
transport failure, missing-header and structured-log contracts are checked in the
normal injected-ABI gate. Viceroy KV/CAS discrepancies remain nonblocking; live
cadence and deployed smoke remain deferred. Native stdio logging delivery is
tracked separately in [Pulse #309](https://github.com/pulse-compute/pulse/issues/309).

## Fixed descriptor

An admitted sweep uses literal POST calls to
`https://uptime.example.com/__tick/run`, bound to the preconfigured **`uptime`**
backend. This hostname is a placeholder; replace it at the literal call site and
in `.pulse/config.ts` before any deployment that enables dispatch. No dynamic
backends, caller-selected URLs, registry-loaded paths, or custom header maps are
accepted. Configure the actual backend with worker address, Host override, TLS
SNI, certificate verification, and short connect/first-byte timeouts.

The dedicated **`UPTIME_TICK_TOKEN`** is read from the existing `tick_secrets`
resource link. It must be 32–256 printable non-whitespace ASCII characters.
Missing or invalid credentials skip before sending. It is distinct from the
receiver probe token and injected as `Authorization: Bearer ...`.

The closed request shape is:

```http
POST /__tick/run
Authorization: Bearer <Secret Store value>
x-tick-invocation-id: uptime:slot:0
x-tick-attempt: 1
x-tick-source: fastly-tick
Content-Type: application/json

{"worker":"uptime","scheduledForMs":0}
```

This fixed invocation is the original FT-03 transport example.
[FT-04](registry.md) now supplies bounded registry selection, stable UTC slot IDs,
conditional first-attempt records and ACK settlement. [FT-05](redelivery.md) supplies bounded
redelivery; the current path never retries within a sweep. No incoming header can replace any protocol/auth header.

Only status **202** with `x-tick-invocation-id` exactly matching the request is
an ACK. Generic 200, another status, absent/empty/mismatched ID, and an ACK arriving
at or after one second are unacknowledged. The body is never read, parsed, or
treated as proof. There is no completion poll or immediate retry.

On handled application paths, the receiver remains `200 healthy`. An admitted
sweep adds `x-tick-dispatch`: `disabled`, `secret-unavailable`, `clock-unavailable`,
`budget-exhausted`, `acked`, `unacknowledged`, or `late-ack`. Measurable response
arrivals also include `x-tick-ack-latency-ms`; no zero latency is invented when no
request was sent or the clock failed. The default disabled path neither resolves
the worker token nor sends a request.

## Independent Native worker

`fixtures/worker` is a separate Pulse Native project and Wasm module. It requires
the same dedicated worker credential via **`tick_worker_secrets`**, plus an
independent KV resource link **`worker_state`**.

Its entire fixture work is durably recording an authenticated, validated `uptime`
slot invocation under `fastly-tick-fixture/<runId>`. Its test-only receipts are not
the scheduler’s bounded per-worker delivery records. It returns 202 only after a
confirmed insert, or after checking an existing matching receipt for a duplicate.
Failed or uncertain persistence returns 503 without an ACK. Invalid auth/protocol
or payload is rejected before persistence. A conflicting/corrupt receipt cannot
authorize acceptance.

This fixture does not start work after returning or pretend a background promise
survives Compute request termination. Real workers must take responsibility for
their actual work before ACKing.

## Beta.8 capability checks

The normal Wasm gate now checks the fixes originally tracked in Pulse #250,
#251, #246/#252 and #254 using the installed beta.8 packages:

| Contract | Checked behavior |
| --- | --- |
| Fetch deadline | Headers at or after 1,000ms time out; headers before it can ACK without waiting for the body |
| Transport recovery | Send/wait failures return healthy with a transport marker, preserving the pending claim without an immediate retry |
| Missing ACK header | A missing ID remains healthy and unacknowledged |
| Structured logs | Post-KV metric keys survive and actual guest writes exclude credentials |

The application error handler also emits a closed `fastly_tick.dispatch_error`
warning with reason `timeout` or `transport`. That path has no complete outcome
counters; consumers must retain unknown values rather than invent zeros.

The work budget remains 4,000ms within a 5,000ms health check, leaving a 1,000ms
response reserve. Before send, the app reserves the ACK budget and 500ms for
local overhead. Fetches are bounded by beta.8, but the provider's fixed KV wait
still prevents a universal response-budget guarantee. No Pulse source, installed
package or generated Wasm is patched. The shipping receiver stays disabled while
an isolated enabled variant exercises the contracts.

## Focused verification

```sh
npm run verify
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native-dispatch-qualification
```

The default gate executes both emitted modules against injected Fastly ABIs,
including exact request/auth/claim rules, deadline boundaries, recoverable errors,
ACK body independence, lost-ACK redelivery and strict structured observations.

The optional Viceroy runner adds real loopback HTTP, independent receiver/worker
services and delayed headers/bodies. Its strict assertions remain intact; local
ABI success is not a deployed service-to-service smoke or latency measurement.
Logging stdio qualification remains separate from post-KV event-shape checks.

## Combined acceptance for the integrated provider fixes

The opt-in gate tests the integrated Pulse candidate for #246/#252 (missing
headers), #251 (transport recovery), #250 (fetch deadlines), and #254 (safe
structured logging). The default suite uses the published beta.8 pins; this
additional command checks explicit local package tarballs against real HTTP.

```sh
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:combined-acceptance -- \
  --packages /absolute/path/to/packed/pulse-release-manifest.json \
  --out /absolute/path/to/fresh/combined-results
```

First build and pack the integrated Pulse checkout with its normal pack command.
The application command requires Node 24 (or another supported Node with native
TypeScript test loading), npm, tar, and an explicit Viceroy binary. It copies the
application inputs to a temporary consumer, installs every local manifest
tarball with lifecycle scripts disabled, and compares installed Pulse files to
their packed bytes before and after execution. npm's `.gitignore` to `.npmignore`
extraction rename is recorded; no package content is patched. The enabled
receiver is an isolated source variant, compiled with those same packages.

The gate runs actual Native injected-ABI cases, all 14 receiver HTTP cases,
and strict Viceroy dispatch HTTP cases including unauthenticated worker input.
Missing auth must reject before persistence. Missing ACK ID must remain healthy
and unacknowledged. Reset and delayed headers must return healthy without
settlement or an immediate retry. Valid, timely 202 plus matching ID must ACK
without consuming the response body. Injected ABI cases also cover the exact
1,000ms boundary, retained pending leases, and parsing emitted structured log
bytes with all required counter keys intact.

The receiver handles only `PULSE_FETCH_NETWORK` and `PULSE_FETCH_TIMEOUT` during
the dispatch phase. It returns `x-tick-dispatch: unacknowledged` and
`x-tick-dispatch-error: transport|timeout`, leaving the existing delivery lease
pending because the worker may have received the attempt. The aborted sweep has
no complete counter observation: absent counters remain unknown, never zero.
Other errors retain their existing handling.

Each run requires a fresh output directory and retains terminal status, step
logs, case results, application input hashes, package hashes, Viceroy identity,
and the three emitted Wasm hashes. Failed attempts must be kept separately.
This is combined development acceptance, not a Pulse release seal or deployed
Fastly qualification. Live KV/CAS behavior, stdout log delivery, cadence, and
service-to-service smoke remain separate gates. Configure the actual backend
and secret and complete those gates before enabling shipping dispatch.
