# FT-02 — conditional sweep admission

The receiver implements admission using Pulse `1.0.0-beta.7` Native KV. It does
not read a worker registry or dispatch work yet. **Deployed conditional-write
proof remains open before distributed dispatch may depend on this gate.**
Logging and live heartbeat cadence are separately deferred by the owner.

## State and control flow

Attach one KV store to the receiver using resource-link name **`tick_state`**.
The app namespace `tick` maps to that link in `.pulse/config.ts`. All receiver
versions and instances coordinating this scheduler must use the same store and
key. The app owns **`fastly-tick-v1/sweep`**; do not share it with another writer,
delete it between requests, or add a TTL.

Its application value is `{ version: 1, nextSweepAtMs: <integer UTC ms> }`, wrapped
in Pulse's conditional KV wire format by the provider. Leave the key absent on
first use. Do not manually seed unwrapped JSON. The schema validates object and
numeric types; the handler validates version, integer range, and due time.
Unknown/corrupt state skips without repair or overwrite.

| Step | Behavior |
| --- | --- |
| Authenticate | Missing, wrong, empty, duplicate, or excessive headers return 401 before KV |
| Select PoP | `all` participates; any other static mode skips before KV while identity is unavailable |
| Sample time | An unavailable clock skips before KV |
| Read versioned state | Failed read skips; a future timestamp skips without a write |
| Claim | Absent state uses `insertIfAbsent`; due state uses `compareAndSwap` with the exact opaque generation |
| Confirm | Only `stored`, followed by a valid in-budget clock sample, reaches `admitted` |

One heartbeat performs at most one versioned read and one conditional mutation.
There is no immediate retry, unconditional `put`, lease renewal, or election.
Each successful write sets `nextSweepAtMs = beforeClaimTime + resolutionMs`.
The static settings near the top of the authenticated handler default to 15,000ms
resolution and a 1,500ms elapsed-work fence; changes require a rebuild. Resolution
below 15 seconds is rejected. A stale read may attempt a claim, but a stale
generation must lose at the write authority. `conflict`, `not-stored`, and
`unknown` never authorize work. Do not infer success by reading back an uncertain
write: another request may have written it.

A request can die after its claim commits. Its sweep remains advanced and that
opportunity is lost; a later heartbeat can claim once the timestamp is due.
An uncertain write can likewise have committed. Never clear or roll it back.
This is best-effort admission, not exactly-once dispatch or an exclusion lease
covering arbitrary work duration. Clock skew can change sweep spacing; stale
reads and conflicts can delay progress. Future dispatch still needs bounded
per-worker delivery claims.

## Trusted PoP identity is deferred

The pinned Pulse context exposes no execution-location/environment accessor, and
its Native provider has no executing-PoP hostcall mapping. `ctx.config.get()` is
Config Store, not runtime environment metadata. The supported default is
`popMode = 'all'`. An operator changing it to `allowlist` currently makes every
authenticated request skip with `pop-unavailable`; there is no working allowlist
configuration to populate yet. Receiver PoP observations remain `null`.

Caller headers such as `fastly-pop`, `x-tick-pop`, and `x-served-by` never select
a participant. The test builds a separate filtering-mode Wasm and verifies even
forged location headers cause zero KV calls.

## Inspecting a probe without logs

Authenticated application outcomes return `200 healthy`, `Cache-Control: no-store`,
and `x-tick-admission`. `admitted` is the sole authorization outcome. Only that
outcome includes `x-tick-next-sweep-at-ms`, identifying the committed timestamp.
Skips include `not-due`, `pop-unavailable`, `clock-unavailable`, `read-failed`,
`invalid-state`, `conflict`, `not-stored`, `unknown`, `budget-exhausted`,
`claimed-too-late`, and `invalid-settings`. No storage generation or token is
returned. These headers support inspection while Native logging is deferred;
a caller-supplied probe kind remains descriptive only.

## Provider timing limitation

**The five-second health-check timeout is not yet guaranteed during slow KV.**
The pinned provider fixes each KV effect timeout at 10 seconds and exposes no
per-effect timeout option. A whole-request `fastly.maxDurationMs` is not a healthy
skip solution: expiry returns a terminal 504 before application continuation.
The app therefore does not configure it as a pretend KV budget.

Elapsed-time checks after the read and after a confirmed write prevent starting
more work after the 1,500ms budget or a backwards clock sample. They cannot
interrupt an already pending hostcall. A late read never starts a claim; a late
confirmed write remains committed but does not admit work. Ordinary returned KV
errors produce a healthy skip, possibly after the trigger has already timed out.
Pulse needs a supported bounded KV deadline that returns an outcome before the
health-check reserve is exhausted. Resolve and validate this before enabling
dispatch under the current five-second health-check budget. No compiler/provider
or generated-Wasm patch is included here.

## Proof and remaining gate

```sh
npm run verify
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native-admission
```

`test:admission` runs the **actual emitted Wasm** with an injected Fastly ABI and
shared atomic authority. It checks stale-observation contention, full-width
generations, malformed data, failures before and after remote commit, elapsed
fences, and crash recovery. Deterministic stale reads model competing snapshots;
they do not prove Fastly's backend implementation. `test:native-admission` uses
concurrent HTTP requests and fresh real Viceroy stores for create and CAS. It
retains strict one-winner assertions and fails on duplicate winners.

Implementation run on 2026-10-09: `verify` passed (5 setup tests, 10 canonical
fixtures, 13 injected-ABI admission tests); Viceroy 0.21.1 passed 11 HTTP cases.
One strict 16-request Viceroy create burst **failed**: 2 admitted, 4 conflicts,
10 not-due. Its CAS burst had 1 admitted, 3 conflicts, 12 not-due. A final replay
after a source-comment edit produced one winner in each burst. All responses
were healthy. The intermittent duplicate remains a failed local arbitration
qualification; a passing replay cannot erase it or prove deployed behavior.
Keep the assertions intact; no timestamp-only substitute or retry workaround is
valid. The final Native artifact is 109,164 bytes, SHA-256
`311fe9e8de4a62940a4f8b49dba34f607a3a03165885996f05dd8cef35fba799`.

Fastly documents [generation-conditional modifications](https://www.fastly.com/documentation/reference/api/services/resources/kv-store-item/)
and [eventually consistent edge data](https://www.fastly.com/documentation/guides/compute/edge-data-storage/about-edge-data-stores/).
These justify using a conditional mutation instead of trusting a read. They are
not a measurement of this app's deployed cross-location coordination. The pinned
Pulse project also records [Viceroy CAS discrepancies](https://github.com/pulse-compute/pulse/blob/main/wasm/test/kv/K4.md).
A local passing schedule cannot erase those discrepancies or qualify live scope.

For the deployed trial, use an isolated receiver and store shared by its instances,
with the trigger disabled during the controlled burst. Record the artifact hash,
service version, store binding, and independently verified execution locations.
Run concurrent authenticated probes while the key is absent, then again once the
persisted timestamp is due. Repeat from multiple execution locations against the
same key. Collect HTTP admission headers, then inspect persisted state after each
burst. Require one confirmed winner per due sweep; zero winners is inconclusive,
not a passing race. Any duplicate winner stops dependent dispatch work. Do not
use a caller-supplied location tag as evidence of where a request executed.

No deployed trial was run during FT-02 implementation: no Fastly credentials or
receiver deployment were available. The missing live proof and bounded healthy
KV timeout remain explicit correctness/operational gates. Native log delivery
and live heartbeat cadence remain deferred, independently of these checks.
