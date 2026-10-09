# fastly-tick

A small Pulse → Fastly Native Wasm receiver for best-effort heartbeat scheduling.
The authoritative [v0.1 specification](docs/spec.md) defines the full scope.

**FT-00 implements only the authenticated receiver and build proof.** Trigger
wiring, PoP/KV admission, registry scheduling, and worker delivery follow in
FT-01–FT-06. The existing `pulse-compute/tick` project is independent.

## Build and verify

Use Node 22.14+ within the 22.x line, or Node 24.x. Pulse packages are pinned to
`1.0.0-beta.7`; install the committed npm lockfile.

```sh
npm ci --ignore-scripts
npm run verify
```

This runs TypeScript validation, the focused provider fixture, the Native build,
and JSON/HTML reports. `.pulse/config.ts` explicitly selects `host: 'fastly'`
and `target: 'native'`. There is no automatic JavaScript fallback.

| Generated output | Purpose |
| --- | --- |
| `dist/bin/main.wasm` | Actual deployable Fastly Native module |
| `dist/bin/main.wasm.sha256` | SHA-256 of that exact module |
| `dist/pulse-build.json` | Build target, binding, and compiler provenance |
| `dist/fastly.toml` | Generated deployment package manifest |
| `dist/report.json`, `dist/report.html` | Pulse reports matched to the module digest |

Build products stay out of git. `npm run report` reads the completed build,
checks its Native identity and actual imports, and requires its final artifact
hash and byte count to match the report. Run it again after each build.

## Probe contract

`GET /__tick/probe` requires `x-tick-probe-token` to equal the nonempty
`TICK_PROBE_TOKEN` secret in the Fastly Secret Store bound as **`tick_secrets`**.
The resource and secret must be provisioned before deployment; a symbolic binding
does not create them. Never use the public fixture token in a deployed service.

Successful authentication returns `200 healthy` with `Cache-Control: no-store`.
Missing, incorrect, empty, or duplicate tokens return `401 unauthorized`.
Header names are case-insensitive. The receiver rejects more than 64 header
pairs, including host-supplied request headers. Unknown routes and unsupported
methods return 404. No token values are returned or logged.

Health means only that the receiver accepted an authenticated probe. It does
not mean a sweep ran, a worker accepted work, or work completed.

## Execute the emitted Wasm locally

`npm test` uses Pulse's provider-owned canonical fixture. To execute the actual
Fastly host ABI, install Viceroy separately (validated with **0.21.1**) and run:

```sh
npm run build
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native
```

The native test reuses the same probe cases, starts temporary loopback servers
with fixture Secret Stores, and cleans up afterward. A missing Viceroy executable
fails the command; it never silently skips or substitutes JavaScript.

For manual HTTP inspection with the Fastly CLI:

```sh
fastly compute serve --file dist/bin/main.wasm
curl -i -H 'x-tick-probe-token: fixture-only-not-a-credential' \
  http://127.0.0.1:7676/__tick/probe
```

The root `fastly.toml` is a local fixture manifest. The generated `dist/fastly.toml`
is the deployment manifest and contains no fixture credentials. Local conformance,
Viceroy execution, and live Fastly deployment are distinct proof levels. FT-00
does not configure or activate a remote service.

### Pinned-provider workaround

Viceroy exposed a beta.7 discrepancy: direct `ctx.req.header()` lookup of an
absent header produced an empty HTTP 200, while the Pulse fixture returned the
intended 401. This app uses the supported normalized `ctx.req.headers` list with
a literal scan bound instead. Both runners verify missing-header rejection.
No Pulse compiler or provider code is patched. Retain the regression test when
upgrading Pulse.

The raw canonical fixture also preserves supplied header-name casing, whereas
the emitted Fastly header-list adapter normalizes names to lowercase. Local
fixture cases therefore use Fastly-normalized names; an additional Viceroy case
verifies mixed-case HTTP header names against the emitted module.
