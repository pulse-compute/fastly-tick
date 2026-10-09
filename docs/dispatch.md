# FT-03 — fixed worker dispatch and exact ACK

The static transport and worker fixture are implemented. **Dispatch is disabled
by default because Pulse beta.7 cannot yet satisfy the required Native failure
and timeout behavior.** This is separate from the accepted, nonblocking Viceroy
KV/CAS discrepancies. Logging, live cadence, and deployed smoke remain deferred.

## Fixed descriptor

An admitted sweep has one compiled POST call to
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

This stable invocation is a transport example, not a production schedule. FT-04
will provide due selection and slot IDs; FT-05 will persist pending delivery and
bounded redelivery. The current path does not persist an ACK or retry a failed
attempt. No incoming header can replace any protocol/auth header.

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

Its entire fixture work is durably recording the authenticated, validated fixed
invocation under `fastly-tick-fixture/uptime:slot:0`. It returns 202 only after a
confirmed insert, or after checking an existing matching receipt for a duplicate.
Failed or uncertain persistence returns 503 without an ACK. Invalid auth/protocol
or payload is rejected before persistence. A conflicting/corrupt receipt cannot
authorize acceptance.

This fixture does not start work after returning or pretend a background promise
survives Compute request termination. Real workers must take responsibility for
their actual work before ACKing.

## Native capability blockers

| Required behavior | Reproduced beta.7 behavior |
| --- | --- |
| Bound ACK wait at 1,000ms | `timeoutMs` is accepted but not read by Native fetch lowering; delayed headers blocked for about 1,400ms |
| Return healthy after transport failure | Send/wait failures are fatal transport errors; a reset returned an empty 200 instead of `healthy` |
| Return healthy for 202 without matching ID | Missing response-header lookup produced an empty 200 in Viceroy, while the injected host returned the intended healthy unacknowledged outcome |

Installed `provider-fastly/src/build/native-platform-capabilities.js` parses
method, headers, body/JSON, and backend for fetch, then directly calls
`pending_req_wait`; it never uses `init.timeoutMs`. Nonzero send/wait status
sets transport error 1006 at stage 77/81. `native-application-errors.js` does not
route transport failures through `app.error`. Missing-header behavior is related
to the existing [Pulse #246](https://github.com/pulse-compute/pulse/issues/246)
direct request-header report; this session additionally reproduced it on a
response header without asserting that the underlying causes are identical.

The app passes `timeoutMs: 1000` to express the contract and rejects a measured
late ACK after the wait. That elapsed check cannot interrupt a pending request.
Backend timeouts may limit the network wait, but their transport failures still
need application recovery. A whole-request budget is not a substitute: it returns
a terminal 504 and cannot preserve a healthy probe response.

The work budget remains 4,000ms within a 5,000ms health check, leaving a 1,000ms
response reserve. Before send, the app also reserves 1,000ms for ACK and 500ms
for local overhead. These fences stop new work after slow preparation; the
existing 10-second KV wait and ignored fetch timeout prevent claiming the total
budget is enforced. No second dispatch is added.

The smallest prerequisite is supported Native per-fetch timeout and recoverable
transport/header failure outcomes. No Pulse source, installed package, generated
Wasm, or alternate runtime is patched here. `dispatchEnabled = false` in the
receiver keeps this incomplete capability from changing deployed probe health.
The test builds an isolated enabled variant to prove available behavior.

## Focused verification

```sh
npm run verify
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native-dispatch-qualification
```

The dispatch tests execute both emitted Wasm modules against injected Fastly
ABIs. They cover the exact request, reserved headers, auth and claim gates, bogus
ACKs, ignored bodies, elapsed-budget fences, and receipt ownership. A diagnostic
asserts the known fatal transport behavior; that assertion passing does not
qualify healthy error recovery.

The Viceroy runner executes real loopback HTTP, including dispatch between two
independent Native services and an origin with delayed body delivery. In the
implementation run, the independent worker ACK took about 3ms; this is a local
sample, not deployed latency. The strict qualification run returned **6/9**:
missing ACK ID, bounded header wait, and healthy transport recovery failed as
described above. Strict assertions remain unchanged. No live Fastly service-to-
service smoke or latency measurement was performed.

`verify` passed: typecheck, 5 setup tests, 10 canonical fixtures, 13 admission
tests, 11 dispatch/worker tests, both builds, and receiver report identity.
The default receiver also passed all 11 Viceroy HTTP regressions. Receiver
Wasm is 118,811 bytes; the independent fixture is 111,989 bytes. Generated
reports and artifacts remain ignored and reproducible.

After the provider gaps are fixed, rerun the strict diagnostic, configure the
actual backend/secret, replace the fixed invocation with FT-04 scheduling, and
perform the deferred live smoke before claiming deployed behavior.
