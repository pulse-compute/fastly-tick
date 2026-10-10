# Terraform setup

Use `deploy/terraform/` to provision the current Fastly topology. Terraform owns
service configuration, package uploads and activation in this workflow. The
manual receiver deployment and `scripts/trigger.mjs` workflow remain alternatives;
choose one owner for each service to avoid version drift.

| Resource | Configuration |
| --- | --- |
| Compute receiver | Receiver domain, `uptime` static TLS backend, `tick_state` and `tick_secrets` resource links |
| KV Store | Registry, sweep admission and delivery state; destruction protected |
| Secret Store | Receiver secrets; destruction protected, values seeded separately |
| Dedicated VCL trigger | Separate domain, `tick_receiver` TLS backend and authenticated `tick_probe` health check every 15 seconds |

Both services start as **inactive drafts**. Receiver package upload is optional
for bootstrap. Domain association does not configure DNS or provision TLS
certificates. The existing external worker is not created by this setup.
Dispatch remains compiled off, and logging/live cadence validation remain deferred.

Use Terraform **1.9 or newer, below 2.0**. CI pins 1.13.5. The Fastly provider is
pinned to **9.8.0**, with its signed dependency lock committed. Run commands below
from the repository root after `npm ci --ignore-scripts`.

## 1. Provision inactive drafts

Copy the example and set your receiver, trigger and existing worker hostnames:

```sh
cp deploy/terraform/terraform.tfvars.example deploy/terraform/terraform.tfvars
```

Supply credentials from your secret manager/environment, without shell tracing.
The provider reads `FASTLY_API_KEY`; the Fastly CLI and existing trigger script
read `FASTLY_API_TOKEN`. A separate, dedicated probe token must contain 32–256
printable ASCII characters without whitespace.

```sh
export FASTLY_API_KEY="$FASTLY_API_TOKEN"
export TF_VAR_tick_probe_token="$TICK_PROBE_TOKEN"
terraform -chdir=deploy/terraform init -lockfile=readonly
terraform -chdir=deploy/terraform plan -out=bootstrap.tfplan
terraform -chdir=deploy/terraform apply bootstrap.tfplan
terraform -chdir=deploy/terraform output
```

Leave both activation flags false and `receiver_package` unset for this first
apply. Review the plan before applying it. Outputs provide the service/store IDs,
draft versions and receiver probe URL.

**The probe token is retained in Terraform state, saved plans and Fastly service
configuration**, because it is a health-check header. `sensitive` hides normal
display; it does not encrypt those files. Use an encrypted, access-controlled
remote state backend for shared operation, configured before the first apply.
The default local state is suitable only for protected local operation. State,
plans and local variable files are ignored and excluded from the npm kit. Avoid
debug logging with live credentials. Keep state backups for recovery.

## 2. Seed secrets and the registry

The provider creates and links stores; it does not manage their entry values.
Use the Fastly CLI's interactive secret prompts:

```sh
fastly secret-store-entry create \
  --store-id "$(terraform -chdir=deploy/terraform output -raw secret_store_id)" \
  --name TICK_PROBE_TOKEN
fastly secret-store-entry create \
  --store-id "$(terraform -chdir=deploy/terraform output -raw secret_store_id)" \
  --name UPTIME_TICK_TOKEN
```

Enter the same probe token supplied to Terraform. The worker token must be
separate, follow the same 32–256 character rule, and match the external worker's
secret. Do not use fixture tokens live. Rotate the receiver secret and trigger
header together; changing one side alone causes failed probes.

Keep an editable **raw** registry document in ignored `deploy/registry.local.json`:

```sh
cp deploy/registry.example.json deploy/registry.local.json
```

Edit it using the [registry rules](registry.md). Encode Pulse's conditional KV
wire envelope once, then create the newline-delimited JSON/base64 upload file
expected by `fastly kv-store-entry create --file`:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const { encodeConditionalKvValue } = createRequire(import.meta.url)('@pulse-compute/runtime/host')
const raw = JSON.parse(readFileSync('deploy/registry.local.json', 'utf8'))
const value = Buffer.from(encodeConditionalKvValue(raw)).toString('base64')
writeFileSync('deploy/registry.upload.local.json', JSON.stringify({
  key: 'fastly-tick-v1/workers', value,
}) + '\n')
JS
fastly kv-store-entry create \
  --store-id "$(terraform -chdir=deploy/terraform output -raw kv_store_id)" \
  --file deploy/registry.upload.local.json
```

Repeat encoding from the raw document for each whole-registry replacement. Do
not encode an existing envelope, upload plain registry JSON as the KV value, or
overwrite the sweep/delivery keys. The next admitted sweep reads the updated
registry. Entry updates stay operator-managed; this setup does not choose a
self-registration API or put runtime contents under Terraform ownership.

## 3. Upload, review and activate the receiver

If configuring a real worker origin, reconcile `worker_host` with both literal
fetch URLs in `src/index.ts` and the backend mapping in `.pulse/config.ts` before
building. Terraform does not rewrite compiled URLs. The current worker path is
`/__tick/run`. Keep `dispatchEnabled = false` pending the upstream Pulse fixes
and strict qualification described in the README.

Build and package the reviewed receiver:

```sh
npm run verify
(cd dist/bin && sha256sum -c main.wasm.sha256)
(cd dist && fastly compute pack --wasm-binary bin/main.wasm)
```

Set `receiver_package` in your local variables to the **absolute path** of
`dist/pkg/fastly-tick.tar.gz`. With both activation flags still false, run
`plan -out=upload.tfplan` and `apply upload.tfplan` using the same `-chdir` as
above. Terraform hashes the package and uploads it to the receiver draft; it
does not build it. Review the package, backend, store links and domain on that
draft.

Configure receiver DNS and TLS using Fastly's domain/TLS controls and your DNS
provider. Set `activate_receiver = true`, leaving `activate_trigger = false`.
Review and apply a new plan. Then perform one authenticated TLS smoke:

```sh
curl --fail --silent --show-error \
  --header "x-tick-probe-token: $TICK_PROBE_TOKEN" \
  --header 'x-tick-probe-kind: setup' \
  "$(terraform -chdir=deploy/terraform output -raw receiver_probe_url)"
```

Require **HTTP 200** and exactly **`healthy`**. This is receiver readiness, not
cadence proof. The protected `/__tick/status` endpoint uses the same probe token.

## 4. Activate the trigger explicitly

Configure the trigger domain's DNS and TLS. Only after the receiver smoke passes,
set `activate_trigger = true`, keeping `activate_receiver = true` and the
reviewed package path. Review and apply a new plan. Terraform rejects trigger
activation with the receiver flag false, but cannot prove a live smoke or TLS
readiness; those are operator prerequisites.

Keep applied flags and the package path in your local configuration. With
activation true, later versioned configuration/package changes activate on
apply. Set the relevant flags false when preparing a new draft for review.
Versionless settings and shared store entry updates can affect the active service
immediately even when activation is false.

Send one ordinary request to the trigger from each available regional vantage
point as described in [trigger warm-up](trigger.md#warm-up-and-redeploy-observations).
A 404 for `/` can initialize the service at that site; it is not heartbeat proof.
Do not introduce a polling loop. Live cadence, site coverage and redeploy behavior
remain deferred until the later live smoke.

## Existing resources and teardown

For an existing deployment, import resources instead of creating duplicates:

```sh
terraform -chdir=deploy/terraform import fastly_kvstore.tick_state "$KV_STORE_ID"
terraform -chdir=deploy/terraform import fastly_secretstore.tick_secrets "$SECRET_STORE_ID"
terraform -chdir=deploy/terraform import fastly_service_compute.receiver "$RECEIVER_SERVICE_ID@$RECEIVER_DRAFT_VERSION"
terraform -chdir=deploy/terraform import fastly_service_vcl.trigger "$TRIGGER_SERVICE_ID@$TRIGGER_DRAFT_VERSION"
```

Match variables to the imported configuration and inspect the next plan carefully;
import alone does not adopt arbitrary existing backend/VCL settings. Transfer
service ownership to Terraform before making changes. Use CLI `compute pack`
for packaging, then Terraform for upload/activation; CLI `compute deploy` and
`scripts/trigger.mjs apply` against those same services introduce drift.

Stores have `prevent_destroy` and KV `force_destroy = false`. Renaming a store
requires replacement and is blocked. For intentional decommissioning, unlink
stores from service versions in a separate apply first, then explicitly remove
the protection and review destruction. Removing resource blocks also removes
their lifecycle protection, so treat such plans as destructive changes.

## Checks and references

The independent CI **`terraform`** job performs these credential-free checks:

```sh
terraform -chdir=deploy/terraform fmt -check -recursive
terraform -chdir=deploy/terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=deploy/terraform validate -no-color
terraform -chdir=deploy/terraform test -no-color
```

Mock-provider plans check inactive bootstrap, package/activation ordering,
hostname loop guards and token validation. CI never applies infrastructure or
uses Fastly credentials. Require both **`verify`** and **`terraform`** in the main
branch rule; repository rules remain an administrator setting.

Pinned provider references: [Compute service](https://registry.terraform.io/providers/fastly/fastly/9.8.0/docs/resources/service_compute),
[VCL service](https://registry.terraform.io/providers/fastly/fastly/9.8.0/docs/resources/service_vcl),
[KV Store](https://registry.terraform.io/providers/fastly/fastly/9.8.0/docs/resources/kvstore),
[Secret Store](https://registry.terraform.io/providers/fastly/fastly/9.8.0/docs/resources/secretstore).
