# fastly-tick

A small Pulse → Fastly Native Wasm receiver that turns distributed health checks
into best-effort worker invocations. This private, independent repository imports
no `pulse-compute/tick` source. The [v0.1 specification](docs/spec.md) defines scope.

**Dispatch is compiled off** pending deployed qualification. Pulse beta.8 fixes
the Native timeout, transport recovery, missing-header and structured-log issues;
the normal Wasm gate now checks those contracts in an isolated enabled build.
The shipped receiver prepares delivery records but sends nothing. Live cadence,
trusted PoP filtering and live KV / service-to-service smoke remain deferred;
documented Viceroy failures do not block implementation. Native stdio delivery
for `ctx.log` / Fastly log-tail still requires
[Pulse #309](https://github.com/pulse-compute/pulse/issues/309). This is a build
candidate, not a deployed scheduler claim.

## Build, test and retrieve a candidate

Use **Node 24.19.0** (CI version; Pulse also supports Node 22.14+ on 22.x).
Pulse, CLI and Fastly provider are pinned to **1.0.0-beta.8** in the npm lockfile.
No Fastly account, CLI or Viceroy is needed for the normal verification gate.

```sh
npm ci --ignore-scripts
npm run verify
```

`verify` runs `check` (package/lock metadata, types, trigger configuration/behavior and canonical app
fixtures) before `verify:native` (receiver/worker builds, injected Fastly ABI
fixtures and reports). The dispatch, registry, retry and operations suites share
one freshly built enabled receiver, including combined beta.8 acceptance;
admission additionally builds its distinct
fail-closed PoP variant. Standalone `test:dispatch`, `test:registry`,
`test:redelivery` and `test:observability` commands still build their own variant.
`.pulse/config.ts` explicitly selects Fastly **Native**, with no JS fallback.

The single [CI workflow](.github/workflows/verify.yml) uses these same commands on
PRs and main, followed by the npm tarball gate. It needs no deployment credentials and retains one successful
candidate per run for **seven days**. Download it from that private Actions run,
unzip into an empty directory, and retain its `dist/` layout and lockfile. PR
artifacts identify the tested merge commit; they are not automatically promoted.
Access follows repository/Actions permissions. Regenerate expired candidates
from the reviewed commit. The tarball is also included in this private candidate;
publication is a separate manual action.

| Candidate file | Purpose |
| --- | --- |
| `dist/bin/main.wasm`, `dist/bin/main.wasm.sha256` | Exact receiver module and SHA-256 |
| `dist/fastly.toml` | Deployment manifest, without local fixture credentials |
| `dist/pulse-build.json` | Native target, compiler and binding provenance |
| `dist/report.json`, `dist/report.html` | Reports matched to final Wasm digest and bytes |
| `dist/artifact.json`, `package-lock.json` | Commit/dirty state, Node/tool versions and seven distributed file hashes; pinned dependency graph |
| `dist/pulse-compute-fastly-tick-<version>.tgz` | Validated npm application kit |

`report` checks the actual module's host imports, Native identity and final report
hash/size before writing these files. Run it after every build. An exported
checkout has unknown Git identity; a dirty local tree is labeled dirty. Generated
files are ignored and never committed. The worker and enabled-test artifacts are
not included in the receiver candidate. These hashes tie files together; they
are not a signature or proof of live behavior.

For separate local HTTP proof, install **Viceroy 0.21.1** and run
`PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native` after verification.
Missing Viceroy fails rather than skipping. Strict KV/dispatch qualification
commands and their known failures remain in [admission](docs/admission.md) and
[dispatch](docs/dispatch.md), outside the normal CI gate. For manual inspection,
`fastly compute serve --file dist/bin/main.wasm` uses the root local fixture
manifest and public fixture token; never deploy that manifest or credential.

## npm package and manual publication

**`@pulse-compute/fastly-tick`** packages the receiver source/configuration, focused
tests, worker fixture source, setup examples, docs and the actual Native Wasm /
digest / build provenance / JSON and HTML reports. Its allowlist excludes local
settings, credentials, compiler caches, canonical intermediate builds and worker
test binaries. The root `fastly.toml` remains a public-token local fixture;
deploy only `dist/fastly.toml`. The Actions-only `dist/artifact.json` is not part
of the npm kit because it references the repository lockfile layout.

After `npm run verify`, run `npm run pack:release` to create and check the tarball.
It ships the reviewed lockfile as `npm-shrinkwrap.json`. To work from the downloaded
kit in an empty directory, extract it with `tar -xzf <tarball> --strip-components=1`,
then run `npm ci --ignore-scripts` and `npm run verify`. Installing it into another
project also makes its precompiled deployment files available under
`node_modules/@pulse-compute/fastly-tick/dist/`. Dispatch and live proof retain the
same restrictions as the source checkout.

PR/main CI exposes the stable **`verify`** check, including metadata/lock agreement,
Native fixtures/report identity and actual tarball contents/Wasm checks. Require
`verify` and the independent **`terraform`** check in the main branch rule to
enforce the merge gates. Repository rules are
an administrator setting, separate from the workflow file.

To publish, merge the version/name/lock changes first, then run **Publish npm
application kit** from Actions on **main**. Enter the exact committed version
(currently `0.1.0`), choose `latest`, `beta` or `next`, and select npm access.
Access defaults to **restricted**; selecting **public** exposes the kit contents
regardless of repository visibility. Private scoped packages require an npm plan
that supports them. Bump versions in a reviewed PR; the workflow never invents
or rewrites a version, creates tags, or publishes on pushes. It validates/builds
once and publishes that same checked tarball.

Use the GitHub environment **`npm`**. For first-package bootstrap, choose `token`
and configure a publish-capable **`NPM_TOKEN`** secret there. Once the package
exists, configure its npm [trusted publisher](https://docs.npmjs.com/trusted-publishers/)
as owner **`pulse-compute`**, repository **`fastly-tick`**, workflow **`publish.yml`**,
environment **`npm`**, with direct publishing allowed; then choose `trusted`.
The pinned Node version provides an OIDC-capable npm CLI. npm provenance is
unavailable for a private source repository, including public-package publishes;
eligible trusted publishes generate it automatically once the repo is public.
No publication or repository visibility change occurs when this PR is merged.

## Receiver and worker setup

For infrastructure as code, use the [Terraform setup](docs/terraform.md). It
provisions the receiver, stores and dedicated VCL trigger as inactive drafts,
with explicit package upload and staged activation instructions. Secret values
and registry contents remain operator-managed. Choose Terraform or the manual
deployment/trigger workflow below as the service owner.

For eventual deployment, install the [Fastly CLI](https://www.fastly.com/documentation/reference/tools/cli/)
and use an account with Compute, KV and Secret Store access. Create a Compute
receiver service and a receiver domain with TLS/DNS. On its deployment draft,
provision resources and attach these **resource-link names**, which need not be
the resources' display names:

| Resource | Binding / required content |
| --- | --- |
| Receiver Secret Store | `tick_secrets`: strong dedicated `TICK_PROBE_TOKEN`; also `UPTIME_TICK_TOKEN` for future enabled dispatch |
| Receiver KV Store | `tick_state`: registry, conditional sweep and per-worker delivery state |
| Receiver static backend | `uptime`: actual worker address, Host override, TLS SNI/certificate name, verification enabled and short connect/first-byte timeouts |
| Independent worker fixture, if used | Separate Compute service; `tick_worker_secrets` with the same worker token, and independent `worker_state` KV |

The worker token must be 32–256 printable, non-whitespace ASCII characters and
separate from the probe token. Bindings do not provision resources. Never use
fixture tokens live. Supply account/probe credentials through your secret manager
or environment; keep tokens out of git and debug output.

The two literal fetch URLs in `src/index.ts` and their `.pulse/config.ts` binding
use **`uptime.example.com` as a placeholder**. Replace both sites and the binding
with the real worker origin when configuring an enabled deployment. Keep
`dispatchEnabled = false` until the strict qualification and deployed smoke pass;
then update the mirrored status settings and rebuild/review the candidate.
A registry cannot authorize a new destination or dynamic backend.

Copy `deploy/registry.example.json` to ignored `deploy/registry.local.json` and
edit the raw document. The example schedules `uptime` every 60,000ms with a
1,000ms ACK budget and at most three attempts. Before uploading it, convert the
raw document to Pulse's conditional KV wire envelope **once**:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const { encodeConditionalKvValue } = createRequire(import.meta.url)('@pulse-compute/runtime/host')
const path = 'deploy/registry.local.json'
writeFileSync(path, Buffer.from(encodeConditionalKvValue(JSON.parse(readFileSync(path, 'utf8')))))
JS
```

Upload that file as the KV value at **`fastly-tick-v1/workers`** using Fastly's KV
console or API. Plain JSON is not a valid Pulse KV wire value. Do not double-wrap
an existing envelope. IDs must be unique lowercase ASCII letters/digits/`_`/`-`
(1–32 characters); at most eight workers, intervals 15,000–86,400,000ms in
15,000ms multiples, ACK budget 1–1,000ms and attempts 1–3. No custom headers.
All entries currently select the same fixed POST `/__tick/run` destination and
secret. See [registry](docs/registry.md) for invalid-state and rotation behavior.

A worker must authenticate the dedicated bearer token, validate its owned ID /
slot, and durably take responsibility **before** returning **202** with the exact
`x-tick-invocation-id` received. Tick ignores the response body. A generic 200,
missing/mismatched ID or late ACK does not close delivery. Workers own deduplication,
work execution, retention, completion and failures after acceptance. The separate
[worker fixture](fixtures/worker) only records receipts; it is not a background
execution engine.

After reviewing the candidate and configuring the receiver service, check
`(cd dist/bin && sha256sum -c main.wasm.sha256)` and package the precompiled module
from the deployment directory:

```sh
cd dist
fastly compute pack --wasm-binary bin/main.wasm
fastly compute deploy --service-id "$RECEIVER_SERVICE_ID" --package pkg/fastly-tick.tar.gz
```

[Pack](https://www.fastly.com/documentation/reference/cli/compute/pack/) uses
`dist/fastly.toml`; [deploy](https://www.fastly.com/documentation/reference/cli/compute/deploy/)
is an explicit operator deployment/activation step, with `FASTLY_API_TOKEN` in the
environment. Review bindings/domain on the target version and the package before
activation. CI does not deploy. The fixture worker can be packaged separately
from `fixtures/worker/dist` after `build:worker`, using its generated manifest.

## Trigger, warm-up and budgets

Create a **separate dedicated CDN/VCL service** with a distinct trigger domain,
default generated VCL and no unrelated backends. Copy `deploy/trigger.example.json`
to ignored `deploy/trigger.local.json`; set both service IDs, an inactive unlocked
trigger draft version and both hostnames. From the repository root:

```sh
node scripts/trigger.mjs plan deploy/trigger.local.json
# With FASTLY_API_TOKEN and the receiver's TICK_PROBE_TOKEN supplied securely:
node scripts/trigger.mjs apply deploy/trigger.local.json
```

Apply checks the receiver's authenticated `200 healthy`, updates only
`tick_probe` / `tick_receiver`, reads settings back and validates the draft. It
never activates it. Review then activate through Fastly. The health-check header
contains the same dedicated probe token in service configuration; protect that
configuration and rotate it together with the receiver Secret Store value.

| Timing | Shipped value |
| --- | --- |
| Health-check interval / upstream timeout | 15,000 / 5,000ms |
| Sweep resolution / KV elapsed fence | 15,000 / 1,500ms |
| Maximum sends / each ACK wait | 2 / at most 1,000ms |
| Planned overhead / response reserve | 500 / 1,000ms |
| Work fence | 4,000ms |

The planned KV + ACK + overhead + reserve total must fit the upstream timeout.
Elapsed fences stop new work, but **cannot interrupt** the provider's fixed KV
wait. Beta.8 bounds individual fetches and exposes recoverable transport/timeout
errors; slow KV still prevents a universal five-second response guarantee.
These values are not a measured latency guarantee.

After activation, send one ordinary request to the **trigger domain** from each
available regional vantage. A 404 can initialize a site; it does not prove a
heartbeat. One vantage does not warm every site. Observe a bounded idle window
and repeat after redeploy; do not introduce a polling loop as the scheduler.
[Trigger setup](docs/trigger.md) describes the eventual cadence/coverage check.

## Status, semantics and remaining proof

`GET /__tick/probe` requires `x-tick-probe-token`; missing, wrong, empty or
duplicate tokens are rejected with 401. Header names are case-insensitive and
at most 64 pairs are accepted. Success is `200 healthy`, no-store: health means
probe acceptance, not a worker send or completed work. The normalized-list
workaround for [Pulse #246](https://github.com/pulse-compute/pulse/issues/246)
retains missing-header regressions in both local runners.

`GET /__tick/status` uses the same auth and optionally `x-tick-worker-id: uptime`.
It reads the sweep and at most one worker record without claiming, writing or
sending. Probe headers expose per-request admission/send/ACK/budget observations.
`acked` is persisted acceptance, not completion; stale state is not liveness.
[Operations](docs/operations.md) documents all fields and bounded summaries.

The receiver already uses `ctx.log.info` for `fastly_tick.probe` arrivals and
`fastly_tick.outcome` summaries, plus a closed `ctx.log.warn` event for recoverable
dispatch errors. After the Native stdio fix in Pulse #309 is available and the
receiver is rebuilt, watch the deployed service with:

```sh
fastly log-tail --service-id "$RECEIVER_SERVICE_ID" --stream stdout --timestamps
```

Confirm arrival and outcome events before relying on the stream. The
[production observation procedure](docs/operations.md#production-log-tail-and-report)
shows a short idle test and the existing JSON summarizer. Until delivery is
qualified, `/__tick/status` provides read-only state; missing logs mean unknown.

| Symptom | Check |
| --- | --- |
| 401 | Resource link, nonempty matching probe secret and duplicate/header count |
| Healthy but no sends | Shipped dispatch gate; then admission, registry, due slot, credential and remaining budget |
| Read failure / invalid state | KV binding, conditional envelope and schema; do not overwrite state as a guessed repair |
| Empty 200, late ACK or hanging failure | Check deployed package/version, exact ACK contract and strict HTTP qualification; slow KV still has a separate budget gap |
| Missing or rejected logs | Native stdio delivery still needs Pulse #309; beta.8 fixes post-KV shape corruption. Use HTTP status/headers until tailing is qualified |

Scheduling is **best effort**, approximate and without catch-up. Only the latest
UTC slot is considered; missed slots are dropped. Lost ACKs may redeliver the
same logical ID on later heartbeats, bounded by deadlines and attempts. Delivery
is at-least-once in character (duplicates possible), with no guarantee every
slot is delivered and no exactly-once or timing SLA. All PoPs currently participate;
trusted executing-PoP selection is deferred. Tick owns acceptance tracking,
not worker completion.

The [seven specification DoD items](docs/spec.md#11-definition-of-done) are reviewed
below. Implementation completion does not close the deferred
[FT-06 live gates](https://github.com/pulse-compute/fastly-tick/issues/7).

| Item | Evidence / remaining gate |
| --- | --- |
| 1. Independent repository | Implemented; no Tick source imports |
| 2. Genuine Native Wasm | Build/import/report identity checked on emitted module |
| 3. Healthy autonomous trigger | Authenticated local HTTP and setup tests; live idle cadence/warm-up/redeploy pending |
| 4. Resolution, conditional claim, optional PoP | Injected-Wasm arbitration/fences verified; live KV and trusted PoP pending |
| 5. Registered worker and authentic ACK | Two-module fixtures verified; dispatch compiled off, live integration pending |
| 6. Lost ACK → bounded same-ID redelivery | Independent-store recovery fixtures verified; live lost-ACK proof pending |
| 7. README, actual report, focused tests | Implemented with private bounded CI artifacts; unproven behavior labeled |

Keep the repository private. Public launch, showcase and broader report comparison
are separate future work.

## Integrated candidate acceptance

Step 6 combines the Fastly provider fixes with the strict application dispatch
fixture using local Pulse package tarballs. Run `npm run test:combined-acceptance
-- --packages /absolute/path/pulse-release-manifest.json --out /fresh/results`
with `PULSE_VICEROY_BIN` set. See [combined acceptance](docs/dispatch.md#combined-acceptance-for-the-integrated-provider-fixes)
for prerequisites, evidence, and remaining live gates. This opt-in application
check does not publish Pulse or enable shipping dispatch.
