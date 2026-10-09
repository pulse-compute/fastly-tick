# FT-01 — trigger setup and live proof

Status: setup code and local HTTP proof are implemented. **Live arrivals,
site coverage, redeploy behavior, and Native log delivery are not verified.**
No Fastly account credentials were available during implementation.

## Receiver and dedicated trigger

1. Build the receiver with `npm ci --ignore-scripts && npm run verify`.
   Deploy the reviewed `dist/` candidate to a Compute service using the Fastly
   deployment workflow. Attach the Secret Store using resource-link name
   `tick_secrets`, containing a strong `TICK_PROBE_TOKEN` value. Configure a
   receiver domain with working TLS and DNS. This setup must precede the trigger.
2. Create a **separate dedicated CDN/VCL service** for the trigger in Fastly.
   Add its distinct domain on an inactive, unlocked draft version. Use the default
   generated VCL and no unrelated backends; existing custom VCL must not reroute
   requests to a different origin. The setup script does not create services,
   domains, certificates, Secret Stores, or activate versions.
3. Copy `deploy/trigger.example.json` to ignored `deploy/trigger.local.json`.
   Set the two service IDs, the trigger draft version, and both DNS hostnames.
   Keep credentials out of this file.
4. Preview without credentials or network calls:

   ```sh
   node scripts/trigger.mjs plan deploy/trigger.local.json
   ```

5. Supply `FASTLY_API_TOKEN` and `TICK_PROBE_TOKEN` through your environment or
   secret manager. The API token must be allowed to read the receiver and modify
   the trigger draft. Then run:

   ```sh
   node scripts/trigger.mjs apply deploy/trigger.local.json
   ```

The script checks the draft and separate receiver domain, performs one direct
authenticated receiver smoke (requires both HTTP 200 and `healthy`), creates or
updates only `tick_probe` and `tick_receiver`, reads back critical settings, and
asks Fastly to validate the draft. It never activates it. Partial draft changes
can remain after an API error; rerun against the same draft or discard the draft.

Custom health-check headers are stored in Fastly's service configuration; they
cannot reference the receiver Secret Store directly. Inject the same dedicated
probe token at apply time, protect access to service configuration, and rotate
both sides together. The script prints no token, request body, or API response
body; avoid shell tracing and verbose API logging with real credentials.

Review and activate the trigger draft through Fastly's control panel. Check
its backend health status and the saved values before recording live proof.

## Timing and routing

| Setting | Initial value |
| --- | --- |
| Probe | `GET /__tick/probe`, HTTP/1.1, expected 200 |
| Health-check interval | 15,000 ms |
| Health-check timeout | 5,000 ms |
| Planned future KV / two ACK waits / overhead | 1,500 / 2,000 / 500 ms |
| Response reserve | 1,000 ms |
| Health window / threshold / initial successes | 5 / 3 / 3 |
| Address, Host override, TLS SNI and certificate name | Receiver hostname |
| Transport | TLS, port 443, certificate verification enabled |

The budget is a configuration constraint, **not measured latency or a runtime
deadline implementation**. FT-03/FT-06 must enforce bounded waits and validate
the budget under failure. The health-check API documents a 1-second to 1-hour
interval range; it documents timeout units but no general maximum. The selected
5-second timeout still requires account-side validation. Do not silently reduce
it if Fastly rejects it; reconcile the work budget first.

## Warm-up and redeploy observations

After activation, send a single ordinary request to the **trigger** domain from
each available regional vantage point, for example `curl -i https://TRIGGER/`.
The default backend may return 404 for `/`; that is sufficient to initiate a
service request, but it is not itself heartbeat proof. Record time, vantage point,
service version, status, and any platform-supplied site metadata. One location
does not initialize every site. Do not run a polling loop as the heartbeat.

Fastly initializes a service at a site on its first end-user request. Health
checks then operate periodically; idle operation is the specified mechanism.
`initial = threshold` avoids requiring successful probes before the backend is
initially considered healthy. This setting does not prove receiver readiness.

Observe a bounded window (start with three minutes) after warm-up, then repeat
around a receiver redeploy and a trigger backend/health-check change. Record the
exact versions and artifact digest. Fastly documents that backend changes reset
health state; unchanged backend/health-check configuration preserves it. Compare
the observations with those expectations, including gaps and duplicates.

## Observation and current Native logging blocker

The receiver emits an authenticated `fastly_tick.probe` event with a provider
wall-clock sample, receiver name, and probe kind. The trigger supplies
`x-tick-probe-kind: healthcheck`; direct setup/manual requests are kept separate.
Kind is caller-supplied metadata, **not proof of source or authorization**.
Receiver PoP is explicitly `null`: FT-02 owns actual identity access. Never use a
caller header or a warming client's location as executing-PoP evidence.

**Pulse beta.7 currently prevents these Native logs from being delivered in
Viceroy 0.21.1.** Its generated `host_log` calls
`fastly_log.endpoint_get("stdout")`; Viceroy rejects that reserved endpoint with
InvalidArgument. Pulse then disables logging for that request. No error reaches
the application. `--log-stdout` does not change the endpoint lookup rule.
No provider code is patched in this repository. The failing gate is explicit:

```sh
PULSE_VICEROY_BIN=/absolute/path/to/viceroy npm run test:native-logs
```

`npm run test:native` verifies HTTP behavior only and passes independently.
Do not report telemetry as working until the gate above passes on a corrected
Pulse version and the deployed receiver is checked separately.

After a provider fix establishes stdout delivery, collect a short receiver
`fastly log-tail --service-id RECEIVER_SERVICE_ID` session, stop it after the
observation window, and feed the resulting plain stdout lines to:

```sh
node scripts/observe.mjs deployed < receiver.log
```

The summarizer retains at most 10,000 matching events, emits only aggregate
counts/timestamps/gaps, excludes manual probes from cadence calculations, and
never claims the live gate passed automatically. Gaps describe merged arrivals,
not a 15-second per-site guarantee; log loss, multiple sites/IPs, and clock skew
affect them. An empty sample has unknown gaps, not zero gaps. Preserve a concise
summary plus deployment identities and delete raw observation logs afterward.

FT-01 closes only after actual live arrivals, warm-up, and redeploy observations
are recorded. Until then, the implementation PR must not auto-close the ticket.

## References checked for this implementation

- [Health-check behavior and site initialization](https://www.fastly.com/documentation/guides/concepts/healthcheck/)
- [Health-check API](https://www.fastly.com/documentation/reference/api/services/healthcheck/)
- [Backend API and TLS fields](https://www.fastly.com/documentation/reference/api/services/backend/)
- [Fastly SDK form serialization](https://github.com/fastly/go-fastly/blob/main/fastly/client.go)
- [Viceroy reserved logging endpoints](https://github.com/fastly/Viceroy/blob/v0.21.1/src/wiggle_abi/log_impl.rs)
