# Deployment guide — Unified Golden Path

How to deploy this project to the **Slalom sandbox account `363509146455` / `us-east-1`**.

> **Nothing in this document has been executed.** It is the runbook to follow *when you choose
> to deploy*. Every `cdk bootstrap` / `cdk deploy` / `cdk destroy` / `put-secret-value` /
> `gh` command below is a **copy-paste candidate that requires your explicit confirmation**,
> because each one mutates AWS or the GitHub repository. The only commands that are safe to run
> unattended are `cdk synth`, `cdk list` and `cdk diff`.

The CDK app (`infra/src/app.ts`) defines **three independent stacks**:

| Stack | What it owns | Depends on |
|---|---|---|
| `UgpIotStack` | IoT Core registry (Thing / Thing Type / policy / optional cert) + OTA pipeline (S3 firmware bucket, OTA job template, OTA service role; Signer profile optional, off by default) | nothing |
| `SelfHealingStack` | ECR repo, ECS/Fargate cluster + task definition, DynamoDB circuit-breaker table, Secrets Manager secret for the GitHub App PEM, two OIDC roles, log group | nothing (the GitHub repo must exist) |
| `DashboardStack` | Guest Cognito Identity Pool (IoT subscribe only), status Lambda + Function URL, Amplify Hosting app (manual deploy) | *nothing at the CloudFormation level* — it references the circuit-breaker table **by name**, not via `Fn::ImportValue` |

Because there are **no cross-stack exports**, CloudFormation will not enforce an order. The order
below is the *operational* one: it is driven by which outputs you need in hand before the next
step, not by stack dependencies.

---

## 1. Prerequisites

| Requirement | Version / value | Notes |
|---|---|---|
| Node.js | `20.9.x` | matches `sample-service-ci.yml` (`node-version: 20`) |
| pnpm | `9.15.4` | pinned in the workflow; `corepack enable` is enough |
| AWS CDK CLI | `2.x` | available through `pnpm --dir infra exec cdk` (no global install needed) |
| AWS credentials | account **`363509146455`**, region **`us-east-1`**, profile **`innovlabs-gdl`** | the account is *never* hardcoded in the app: it comes from `CDK_DEFAULT_ACCOUNT` |
| GitHub repo | **`emicmrg/unified-golden-path`** — exists | required: the OIDC trust policies are scoped to it |
| Docker | any recent engine | needed to build the crew image for ECR (`linux/amd64`) |
| Amazon Bedrock | Claude Sonnet 4.5 access — **already enabled** | model: `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region inference profile; Sonnet 4.5 has **no** on-demand throughput) |
| ESP-IDF | `5.3.x` | firmware only, separate toolchain — see [`edge-firmware/README.md`](../edge-firmware/README.md) |
| Python | `3.11+` | crew image / local crew runs |
| `gh` CLI | authenticated as a repo admin | only for step 5 and 6 |

Shell setup used by every command in this guide:

```bash
export AWS_PROFILE=innovlabs-gdl
export AWS_REGION=us-east-1
export CDK_DEFAULT_REGION=us-east-1

# Confirm you are in the right account BEFORE anything else (read-only).
aws sts get-caller-identity --query Account --output text   # must print 363509146455
```

Install and build once:

```bash
pnpm install
pnpm build          # tsc for infra/
pnpm test           # CDK assertions
```

---

## 2. CDK bootstrap (one-time, per account+region)

> ⚠️ **REQUIRES YOUR CONFIRMATION — this creates resources.** Shown, not run.

```bash
pnpm --dir infra exec cdk bootstrap aws://363509146455/us-east-1
```

This is the **only** `cdk` command in this guide that needs no app context: with an explicit
`aws://<account>/<region>` target it does not synthesize `app.ts`, so the fail-closed guards of
§3 never run. Everything else does — see §4.0.

What it creates (the `CDKToolkit` stack):

- an **S3 staging bucket** (`cdk-hnb659fds-assets-363509146455-us-east-1`) for file assets,
- an **ECR repo** (`cdk-hnb659fds-container-assets-...`) for container assets,
- the **`cdk-hnb659fds-*` IAM roles** (deploy / file-publishing / image-publishing / lookup) and
  the `/cdk-bootstrap/hnb659fds/version` SSM parameter.

Why it is mandatory here, not optional — **for all three stacks**, regardless of assets:

- Every synthesized template carries a `BootstrapVersion` SSM parameter
  (`/cdk-bootstrap/hnb659fds/version`) and a **`CheckBootstrapVersion`** rule, and the manifest
  records `requiresBootstrapStackVersion: 6`. Without the toolkit stack that SSM parameter does
  not resolve and the deploy fails before creating anything. This alone makes bootstrap a hard
  prerequisite for `UgpIotStack`, `SelfHealingStack` **and** `DashboardStack`.
- On top of that, two stacks publish a real **file asset** to the staging bucket, both of them
  CDK-generated custom-resource handlers:
  - `UgpIotStack` → the `autoDeleteObjects` handler for the firmware bucket.
  - `SelfHealingStack` → the `restrictDefaultSecurityGroup` handler for the VPC default SG.
- `DashboardStack` publishes **no code asset**: its status Lambda is `lambda.Code.fromInline`
  (`Code.ZipFile`, capped at 4096 chars by CloudFormation — see
  `infra/src/lambda/dashboard-status-handler.ts`). It only gains an asset-backed Lambda when
  deployed with `-c ugp:resolveIotEndpoint=true`, which adds an `AwsCustomResource`. It still
  requires bootstrap because of the version rule above.

**Blast radius:** account-wide, but additive and **idempotent** — re-running it upgrades the
toolkit stack in place. It is **not** reverted by `cdk destroy` of the three app stacks; the
`CDKToolkit` stack stays until deleted explicitly. If the sandbox was already bootstrapped by
someone else, this is a no-op upgrade. Verify first (read-only):

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT BOOTSTRAPPED"
```

---

## 3. Context per stack (the fail-closed guards)

The app deliberately **aborts synth** rather than shipping an insecure default. Two guards exist.

> ### ⚠️ Every `cdk` command needs the context of **all** stacks — not just the one you name
>
> `infra/src/app.ts` instantiates **all three stacks at module load**, and the fail-closed guards
> run **inside the stack constructors**. The CDK CLI must execute the whole app to produce the
> cloud assembly *before* it can select a stack, so a guard that throws in **any** stack aborts
> **every** command — `synth`, `list`, `diff`, `deploy`, `destroy` — even when the failing stack
> is not the one on the command line.
>
> Naming a stack still scopes the *action* (`cdk deploy DashboardStack` deploys only that stack).
> It does **not** scope *synthesis*. So the context must satisfy all guards, always.
>
> Concrete gotcha — this looks correct and fails:
>
> ```bash
> pnpm --dir infra exec cdk synth DashboardStack -c ugp:allowWildcardCors=true
> # Error: SelfHealingStack: githubOrg/githubRepo are missing or still placeholders
> #   at new SelfHealingStack (infra/src/stacks/self-healing-stack.ts:160)
> #   at Object.<anonymous> (infra/src/app.ts:68)     <-- thrown at app load, not at stack selection
> ```
>
> The `DashboardStack` CORS guard was satisfied; the unrelated `SelfHealingStack` guard still
> killed the command. Use the shared `CTX_ALL` from §4 for **every** invocation.

### 3.1 `SelfHealingStack` — GitHub org/repo (hard requirement)

| Context key | Value for this deploy | Effect if missing |
|---|---|---|
| `ugp:githubOrg` | `emicmrg` | **synth throws** |
| `ugp:githubRepo` | `unified-golden-path` | **synth throws** |

Without them the stack falls back to the placeholders `CHANGE-ME-ORG/CHANGE-ME-REPO`, which would
put `repo:CHANGE-ME-ORG/CHANGE-ME-REPO:ref:refs/heads/main` in the trust policy of **both** OIDC
roles (`ugp-ci-deploy-role`, `ugp-bedrock-ci-role`) — a repo anybody could register on GitHub and
then assume the roles. Hence the guard.

```bash
-c ugp:githubOrg=emicmrg -c ugp:githubRepo=unified-golden-path
```

Escape hatch for a **local synth only**: `-c ugp:allowPlaceholderRepo=true`.
**Never deploy a template synthesized that way.**

Optional but needed for the Fargate runner to actually authenticate (otherwise synth only
*warns*, and the container would start and fail against the GitHub API):

| Context key | Purpose |
|---|---|
| `ugp:githubAppId` | GitHub App ID — becomes `GITHUB_APP_ID` in the task definition |
| `ugp:githubInstallationId` | Installation ID — becomes `GITHUB_INSTALLATION_ID` |
| `ugp:githubAppSecretArn` | Reuse an existing Secrets Manager secret instead of letting the stack create one |

### 3.2 `DashboardStack` — CORS on the public Function URL (hard requirement)

The status Function URL is `authType=NONE`, so **CORS is the only thing** deciding which pages may
read it from a visitor's browser. A wildcard that is also the default is a wildcard nobody
notices, so:

| Context key | Value | Effect |
|---|---|---|
| `ugp:dashboardAllowedOrigins` | `https://main.<appId>.amplifyapp.com` (comma-separate several) | final state |
| `ugp:allowWildcardCors=true` | — | explicit opt-in to `*`; **only** for local synth and the bootstrap deploy of the two-phase sequence (§4.4) |

Omitting both → **synth throws**. Passing `*` without the opt-in → **synth throws**.

### 3.3 Optional context (both stacks)

| Context key | Stack | Purpose |
|---|---|---|
| `ugp:deviceCsrPath=./device.csr` | `UgpIotStack` | PEM **CSR** read from disk; CDK registers the cert and attaches Thing + policy. Without it (or `ugp:deviceCertificateArn`) the policy is created but **nothing is attached**, and the firmware cannot connect (synth warns). The private key stays local — it never enters the repo nor the template. |
| `ugp:deviceCertificateArn=arn:aws:iot:...` | `UgpIotStack` | Attach an already-registered certificate instead of a CSR |
| `ugp:iotEndpoint=<prefix>-ats.iot.us-east-1.amazonaws.com` | `DashboardStack` | Literal ATS endpoint; validated at synth (a non-ATS host throws). Tightens the dashboard CSP `connect-src` and fills `VITE_IOT_ENDPOINT`. `UgpIotStack` does **not** read this key — it has no endpoint-address prop (see `app.ts`). |
| `ugp:resolveIotEndpoint=true` | `UgpIotStack`, `DashboardStack` | Resolve it at deploy time with a read-only `AwsCustomResource` (`iot:DescribeEndpoint`) instead of passing the literal |
| `ugp:dashboardBasicAuthSecretArn` | `DashboardStack` | Lock the Amplify hosting behind basic auth during rehearsals. Create the `{"username","password"}` secret manually; the password is resolved by CloudFormation at deploy time and never enters the repo. |

Generate the device CSR (local, no AWS call):

```bash
openssl req -new -newkey rsa:2048 -nodes \
  -keyout device.key -out device.csr -subj "/CN=ugp-gateway-01"
# device.key NEVER leaves the machine and is NEVER committed.
```

Get the ATS endpoint (read-only):

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
```

### 3.4 Synth check (safe, run it now)

This is the minimum context that satisfies **both** guards at once, so it is the command to reach
for whenever you just want to know that the app still builds:

```bash
pnpm --dir infra run synth \
  -c ugp:githubOrg=emicmrg -c ugp:githubRepo=unified-golden-path \
  -c ugp:dashboardAllowedOrigins=https://main.PLACEHOLDER.amplifyapp.com \
  -c ugp:iotEndpoint=example1234abcd-ats.iot.us-east-1.amazonaws.com
```

Verified: all three stacks synthesize — `UgpIotStack`, `SelfHealingStack`, `DashboardStack`.
Two expected warnings remain with that context: no device CSR/cert (`UgpIotStack`) and empty
`githubAppId`/`githubInstallationId` (`SelfHealingStack`).

The `PLACEHOLDER` origin is fine for a synth check — it only has to be a non-wildcard value to get
past the CORS guard. **Never deploy it**; use the real Amplify domain (§4.4).

---

## 4. Deploy order

> **Rule for every single step: `cdk diff <Stack>` first, read it, then `cdk deploy <Stack>`.**
> `cdk diff` is read-only. `cdk deploy` is the mutation that needs your go-ahead.

### 4.0 The shared context — `CTX_ALL`

Because every command synthesizes the whole app (§3), define the context **once** and reuse it
verbatim. This is what keeps a diff and its deploy from ever drifting apart, and it is the same
approach the root [`README.md`](../README.md) uses.

```bash
# Satisfies the SelfHealingStack OIDC guard. Not sufficient on its own: the DashboardStack CORS
# guard needs one more key, added per phase below. CTX_ALL is what you actually pass.
CTX_GUARDS="-c ugp:githubOrg=emicmrg -c ugp:githubRepo=unified-golden-path"

# PHASE 1 — before DashboardStack exists, the Amplify domain is unknown, so the CORS guard is
# satisfied with the explicit wildcard opt-in. Harmless while deploying the other two stacks:
# it only has to let synthesis through; no wildcard is deployed unless you deploy DashboardStack.
CTX_ALL="$CTX_GUARDS -c ugp:allowWildcardCors=true"

# PHASE 2 — once the Amplify domain exists (§4.4), switch to the real origin and KEEP it for
# every later command, including teardown. Never leave the wildcard in CTX_ALL after this point.
# CTX_ALL="$CTX_GUARDS -c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com"

# Per-stack extras, appended to CTX_ALL (never used on their own).
CTX_IOT="-c ugp:deviceCsrPath=./device.csr"
CTX_SELFHEAL="-c ugp:githubAppId=<appId> -c ugp:githubInstallationId=<installationId>"
```

Sanity-check the whole thing before any mutation (read-only):

```bash
pnpm --dir infra exec cdk list $CTX_ALL     # must print the three stacks, no throw
```

### 4.1 `UgpIotStack` — the edge platform

First because it is fully independent and it produces the IoT identity the firmware needs. Nothing
downstream blocks on it, so a failure here does not strand the other stacks.

```bash
pnpm --dir infra exec cdk diff   UgpIotStack $CTX_ALL $CTX_IOT      # read-only
pnpm --dir infra exec cdk deploy UgpIotStack $CTX_ALL $CTX_IOT      # ⚠️ needs confirmation
```

Outputs: `ThingName`, `ThingArn`, `ThingTypeArn`, `IotPolicyName`, `DeviceCertificateStatus`,
`FirmwareBucketName`, `CodeSigningStatus`, `OtaServiceRoleArn`, `OtaJobTemplateArn`, plus
`IotDataEndpointAddress` (with `resolveIotEndpoint=true`) or `IotDataEndpointHint`.

Firmware code-signing is **optional and off by default**: no AWS Signer profile, no custom
resource, no `signer:*` IAM. `CodeSigningStatus` reports `DISABLED:…`, and `SigningProfileArn` /
`SigningProfileName` are only emitted when the stack is deployed with
`-c ugp:signingCertificateArn=<acm-arn>`. See `infra/README.md` → "Code-signing (optional)" for
the rationale (Block-3 debt A1: the device does not verify signatures yet) and the enable steps.

### 4.2 `SelfHealingStack` — the crew runner

Second because everything after it consumes its outputs: the ECR URI (step 4.3), the GitHub repo
variables (§5), and the circuit-breaker table name that `DashboardStack` reads.

```bash
pnpm --dir infra exec cdk diff   SelfHealingStack $CTX_ALL $CTX_SELFHEAL
pnpm --dir infra exec cdk deploy SelfHealingStack $CTX_ALL $CTX_SELFHEAL   # ⚠️ needs confirmation
```

Creates: ECR `ugp-self-healing-crew` (scan-on-push, AES-256, `emptyOnDelete`), ECS cluster
`ugp-self-healing`, task family `ugp-self-healing-crew` (1 vCPU / 2 GB, container `crew`),
DynamoDB `ugp-self-healing-circuit-breaker`, log group `/aws/ecs/ugp-self-healing-crew`, the
GitHub App secret, and the roles `ugp-ci-deploy-role` + `ugp-bedrock-ci-role`.

Outputs: `CrewEcrRepositoryUri`, `CrewClusterName`, `CrewTaskDefinitionArn`, `CrewTaskRoleArn`,
`CrewExecutionRoleArn`, `CircuitBreakerTableName`, `GithubAppSecretArn`, `CiDeployRoleArn`,
`CiDeployRoleTrustedSubject`, `BedrockCiRoleArn`, `BedrockCiRoleTrustedSubject`,
`CrewLogGroupName`, `CrewSubnetIds`, `CrewSecurityGroupId`, `BedrockInferenceProfileArn`.

Dump them all (read-only):

```bash
aws cloudformation describe-stacks --stack-name SelfHealingStack \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
```

**Immediately after this deploy — load the real GitHub App PEM.** CDK created the secret with a
random throwaway value and will never overwrite it (a CloudFormation template is not a place for
secrets):

```bash
SECRET_ARN=$(aws cloudformation describe-stacks --stack-name SelfHealingStack \
  --query "Stacks[0].Outputs[?OutputKey=='GithubAppSecretArn'].OutputValue" --output text)

# ⚠️ MUTATION — needs confirmation. The PEM never enters the repo, a var, or a GitHub secret.
aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" \
  --secret-string "$(cat /secure/path/ugp-selfheal-app.private-key.pem)"
```

### 4.3 Build and push the crew image

The task definition pins `…/ugp-self-healing-crew:latest`. ECS resolves the tag **at task start**,
so pushing after the deploy requires no stack update — but a `RunTask` before the first push fails
with `CannotPullContainerError`.

```bash
ECR_URI=$(aws cloudformation describe-stacks --stack-name SelfHealingStack \
  --query "Stacks[0].Outputs[?OutputKey=='CrewEcrRepositoryUri'].OutputValue" --output text)

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "${ECR_URI%%/*}"

# Fargate is linux/amd64 — build for it explicitly (matters on Apple Silicon).
docker build --platform linux/amd64 -t ugp-self-healing-crew:latest ./self-healing-crew

SHA=$(git rev-parse --short HEAD)
docker tag ugp-self-healing-crew:latest "$ECR_URI:latest"
docker tag ugp-self-healing-crew:latest "$ECR_URI:$SHA"

# ⚠️ MUTATION (pushes into ECR) — needs confirmation.
docker push "$ECR_URI:latest"
docker push "$ECR_URI:$SHA"

aws ecr describe-images --repository-name ugp-self-healing-crew \
  --query 'imageDetails[].imageTags' --output json          # read-only verification
```

### 4.4 `DashboardStack` — two-phase deploy

The CORS origin is `https://main.<appId>.amplifyapp.com` and `<appId>` is generated **by this
stack**, so it does not exist before the first deploy. The reverse direction cannot be shortcut
either: the CSP `connect-src` embeds the status Function URL, so the template cannot self-reference
the origin. Hence the first deploy is a bootstrap and the final state is reached on the second.

```bash
# PHASE 1 — bootstrap. CORS is '*' here. This is NOT the final state.
# $CTX_ALL still carries ugp:allowWildcardCors=true at this point, plus the OIDC guard context
# that SelfHealingStack demands even though only DashboardStack is being deployed.
pnpm --dir infra exec cdk diff   DashboardStack $CTX_ALL
pnpm --dir infra exec cdk deploy DashboardStack $CTX_ALL   # ⚠️ confirm

# Read the domain the deploy just created.
ORIGIN="https://$(aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyDefaultDomain'].OutputValue" --output text)"
echo "$ORIGIN"      # e.g. https://main.d1abc2def3.amplifyapp.com

# PHASE 2 — redefine CTX_ALL for the WHOLE REST of the runbook (including teardown): real
# origin, no wildcard. Everything after this point reuses it unchanged.
CTX_ALL="$CTX_GUARDS -c ugp:dashboardAllowedOrigins=$ORIGIN"

# Redeploy with CORS scoped to that origin (and the CSP tightened).
pnpm --dir infra exec cdk diff   DashboardStack $CTX_ALL -c ugp:resolveIotEndpoint=true
pnpm --dir infra exec cdk deploy DashboardStack $CTX_ALL -c ugp:resolveIotEndpoint=true   # ⚠️ confirm

# ACCEPTANCE CRITERION — the wildcard must be gone.
STATUS_URL=$(aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='StatusApiUrl'].OutputValue" --output text)
curl -sI -H "Origin: $ORIGIN" "$STATUS_URL" | grep -i access-control-allow-origin
# access-control-allow-origin: https://main.d1abc2def3.amplifyapp.com   ✅
# access-control-allow-origin: *                                        ❌ phase 2 was skipped
```

While that header answers `*`, any website on the internet can read this endpoint from its
visitors' browsers. **Only phase 1 may run with `ugp:allowWildcardCors=true`.**

Outputs: `IdentityPoolId`, `GuestRoleArn`, `AwsRegion`, `IotEndpoint`, `TelemetryTopic`,
`MqttClientIdPrefix`, `StatusApiUrl`, `StatusFunctionRoleArn`, `CircuitBreakerTableNameRead`,
`AmplifyAppId`, `AmplifyDefaultDomain`, `AmplifyManualDeployCommands`, `ViteEnvFile`.

### 4.5 Build and deploy the web dashboard to Amplify

Amplify Hosting is configured for **manual deployment** (no repo connection), so the SPA is
uploaded as a zip. The build-time config comes straight from the stack outputs.

```bash
APP_ID=$(aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyAppId'].OutputValue" --output text)

# The ViteEnvFile output is the literal contents of web-dashboard/.env.production:
#   VITE_AWS_REGION, VITE_IDENTITY_POOL_ID, VITE_IOT_ENDPOINT,
#   VITE_TELEMETRY_TOPIC, VITE_STATUS_API_URL, VITE_MQTT_CLIENT_ID_PREFIX
aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='ViteEnvFile'].OutputValue" --output text \
  > web-dashboard/.env.production

pnpm --dir web-dashboard run build
(cd web-dashboard/dist && zip -r ../dist.zip .)

# ⚠️ MUTATIONS below — need confirmation.
DEPLOY=$(aws amplify create-deployment --app-id "$APP_ID" --branch-name main)
JOB_ID=$(echo "$DEPLOY"  | jq -r .jobId)
UPLOAD=$(echo "$DEPLOY"  | jq -r .zipUploadUrl)

curl -X PUT --upload-file web-dashboard/dist.zip "$UPLOAD"
aws amplify start-deployment --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID"

aws amplify get-job --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" \
  --query 'job.summary.status' --output text      # read-only; wait for SUCCEED
```

Then open `$ORIGIN` and confirm the SPA loads, the status panel resolves, and the browser console
shows no CSP or CORS violation. `.env.production` is build-time only — none of those values are
secrets, but do not commit the file.

### 4.6 Flash the ESP32 firmware and provision its certificate

Last, because the gateway needs the IoT Thing, policy and ATS endpoint from §4.1 to connect. Full
toolchain instructions in [`edge-firmware/README.md`](../edge-firmware/README.md); the short form:

```bash
. $HOME/esp/esp-idf/export.sh
cd edge-firmware
idf.py set-target esp32
idf.py build
idf.py -p /dev/cu.usbserial-0001 flash monitor      # Ctrl+] to exit
```

Certificate provisioning:

- If you deployed §4.1 with `-c ugp:deviceCsrPath=./device.csr`, the cert is already registered,
  **ACTIVE**, and attached to the Thing and the policy — `DeviceCertificateStatus` shows its ARN.
  Flash the device with that cert plus the matching `device.key` (kept local) and the Amazon root
  CA.
- If you deployed without a CSR, `DeviceCertificateStatus` reports that nothing is attached and
  the device **cannot connect**. Either redeploy `UgpIotStack` with the CSR, or register a cert
  out of band and pass `-c ugp:deviceCertificateArn=...`.
- The MQTT client id **must equal** `ThingName` (the IoT policy enforces it), and the gateway
  publishes to `ugp/telemetry/ugp-gateway-01` — the exact topic the dashboard subscribes to. That
  topic string is a contract duplicated in `UgpIotStack` and `DashboardStack`: change one, change
  both in the same commit.

---

## 5. Post-deploy wiring — GitHub repository configuration

All of these are **repository variables**, not secrets: they are ARNs and resource identifiers,
none of them confidential. Set at *Settings → Secrets and variables → Actions → Variables*, or
with `gh variable set`.

| Variable | Value / CDK output | Used by |
|---|---|---|
| `SELF_HEAL_MODE` | `gha` or `fargate` — the demo switch; the two runners are mutually exclusive, so only one reacts to a CI failure | both workflows |
| `CI_DEPLOY_ROLE_ARN` | `SelfHealingStack` → `CiDeployRoleArn` (`arn:aws:iam::363509146455:role/ugp-ci-deploy-role`) | `self-heal-dispatch.yml` |
| `BEDROCK_CI_ROLE_ARN` | `SelfHealingStack` → `BedrockCiRoleArn` (`arn:aws:iam::363509146455:role/ugp-bedrock-ci-role`) | `self-heal-gha.yml` |
| `CREW_CLUSTER_NAME` | `SelfHealingStack` → `CrewClusterName` (`ugp-self-healing`) | `self-heal-dispatch.yml` |
| `CREW_TASK_DEF_ARN` | `SelfHealingStack` → `CrewTaskDefinitionArn` | `self-heal-dispatch.yml` |
| `CREW_SUBNET_IDS` | `SelfHealingStack` → `CrewSubnetIds` (comma-separated) | `self-heal-dispatch.yml` |
| `CREW_SECURITY_GROUP_ID` | `SelfHealingStack` → `CrewSecurityGroupId` | `self-heal-dispatch.yml` |
| `DDB_TABLE_NAME` | `SelfHealingStack` → `CircuitBreakerTableName` (`ugp-self-healing-circuit-breaker`) | `self-heal-gha.yml` |
| `BEDROCK_MODEL_ID` | `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` — the `bedrock/` prefix is validated by `crew/config.py` | `self-heal-gha.yml` |
| `MAX_ATTEMPTS` | `2` — must match `maxAttempts` in `SelfHealingStack` (range 1–10 enforced on both sides) | `self-heal-gha.yml` |

Example commands (**shown, not run** — they mutate repo settings):

```bash
REPO=emicmrg/unified-golden-path
OUT() { aws cloudformation describe-stacks --stack-name SelfHealingStack \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

gh variable set SELF_HEAL_MODE         --repo "$REPO" --body "gha"
gh variable set CI_DEPLOY_ROLE_ARN     --repo "$REPO" --body "$(OUT CiDeployRoleArn)"
gh variable set BEDROCK_CI_ROLE_ARN    --repo "$REPO" --body "$(OUT BedrockCiRoleArn)"
gh variable set CREW_CLUSTER_NAME      --repo "$REPO" --body "$(OUT CrewClusterName)"
gh variable set CREW_TASK_DEF_ARN      --repo "$REPO" --body "$(OUT CrewTaskDefinitionArn)"
gh variable set CREW_SUBNET_IDS        --repo "$REPO" --body "$(OUT CrewSubnetIds)"
gh variable set CREW_SECURITY_GROUP_ID --repo "$REPO" --body "$(OUT CrewSecurityGroupId)"
gh variable set DDB_TABLE_NAME         --repo "$REPO" --body "$(OUT CircuitBreakerTableName)"
gh variable set BEDROCK_MODEL_ID       --repo "$REPO" \
  --body "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
gh variable set MAX_ATTEMPTS           --repo "$REPO" --body "2"
```

### Secrets — deliberately almost none

- **`GITHUB_TOKEN`** is injected automatically by Actions. Runner 1 (`gha` mode) uses it; no setup.
- **The GitHub App PEM is NOT a GitHub secret.** It lives in the Secrets Manager secret created by
  `SelfHealingStack` (`GithubAppSecretArn`) and is loaded with `put-secret-value` as shown in
  §4.2. The Fargate task role is the only principal allowed to read it; the crew uses the key
  only to sign a JWT and exchange it for a ~60-minute installation token, so no long-lived PAT is
  ever persisted.
- The App ID and Installation ID are **not** secrets either — they are baked into the task
  definition via `ugp:githubAppId` / `ugp:githubInstallationId` context.

The OIDC trust policies are scoped with `StringEquals` on
`repo:emicmrg/unified-golden-path:ref:refs/heads/main`; verify with the
`CiDeployRoleTrustedSubject` and `BedrockCiRoleTrustedSubject` outputs. If the repo is renamed or
moved, both roles must be redeployed with the new context or OIDC will silently stop working.

---

## 6. Branch protection on `main` — REQUIRED

**Do not enable either self-healing runner on a real repository until this is configured.**

The crew's "never push to main, always open a PR on `fix/*`" rule is currently enforced *only by
the crew's own code* (`crew/tools.py`, covered by `tests/test_anti_main.py`). That is a guardrail
inside the very component that an LLM is driving. Branch protection is the **defense in depth**
that moves the rule from application code to the platform — GitHub refuses the push regardless of
what the agent decides to do. This is the finding the security reviews kept raising (`B3-sec`).

Required settings (*Settings → Branches → Add branch protection rule → `main`*):

- ✅ Require a pull request before merging
- ✅ Require approvals — **minimum 1**
- ✅ Dismiss stale pull request approvals when new commits are pushed
- ✅ Require status checks to pass — **`Build and Test (@ugp/sample-service)`** (the job of
  `sample-service-ci.yml`)
- ✅ Require branches to be up to date before merging
- ✅ Block force pushes
- ✅ Block branch deletion
- ⛔ *Restrict who can push to matching branches* — **not available on a personal repository.**
  `emicmrg/unified-golden-path` is owned by a user account, not an org, so this box does not
  exist in the UI and `restrictions` **must be `null`** in the API payload (see below). The
  "the App cannot push to `main`" guarantee therefore comes from *required pull request reviews*
  + *do not allow bypassing*, not from a push allow-list. On an **organization** repo, do also
  restrict pushes to humans only and do **not** list the App.
- ✅ **Do not allow bypassing the above settings** — no admin, App or `GITHUB_TOKEN` exemption.
  This is the one that matters: an App listed as a bypass actor makes every other box decorative.

Equivalent API call (**shown, not run** — it changes repo settings):

> ⚠️ **`"restrictions"` must be `null` on a personal repository.** Push restrictions are an
> **organization-only** feature, so sending a `restrictions` object on a user-owned repo makes
> the API reject the whole call with **`422 Validation Failed`** — and no protection at all gets
> applied. The key is still **required** (it is not optional in this endpoint), so send it
> explicitly as `null`. On an org repo, replace it with
> `{"users": [], "teams": ["maintainers"], "apps": []}`.

```bash
gh api -X PUT repos/emicmrg/unified-golden-path/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Build and Test (@ugp/sample-service)"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

# Read-only verification afterwards. `.restrictions` is absent on a personal repo, so read the
# review requirement instead — that is what actually blocks a direct push from the App.
gh api repos/emicmrg/unified-golden-path/branches/main/protection \
  --jq '{admins:.enforce_admins.enabled, force:.allow_force_pushes.enabled,
         del:.allow_deletions.enabled,
         reviews:.required_pull_request_reviews.required_approving_review_count,
         dismiss:.required_pull_request_reviews.dismiss_stale_reviews,
         restrictions:(.restrictions // "n/a (personal repo)"),
         checks:.required_status_checks.contexts}'
```

With `restrictions` unavailable, **required PR reviews + `enforce_admins: true` are what stop the
crew's GitHub App from pushing to `main`**: the App holds only `contents:write` +
`pull_requests:write`, so it can create `fix/*` and open a PR, but a direct push to `main` is
refused because the branch requires a reviewed pull request and nobody — not even an admin — is
exempt. Verify `admins: true` and `reviews: 1` in the output above; if `enforce_admins` is false
on a personal repo, the owner can still push straight to `main` and the guardrail is cosmetic.

### GitHub App permissions — least privilege

The App the crew installs on the repo must have **only**:

| Scope | Level | Why |
|---|---|---|
| Contents | Read & write | create the `fix/*` branch and commit the patch |
| Pull requests | Read & write | open the PR |
| Actions | Read | download the failed run's logs |
| Metadata | Read | mandatory baseline |

**Never grant `workflows`** — with it the crew could rewrite `.github/workflows/**` and edit the
very checks that gate `main`, which routes around branch protection entirely. Also never grant
`administration`, `packages`, `deployments` or `secrets`.

---

## 7. Teardown

Tear down in reverse order. There are no CloudFormation exports between the stacks, so the order
is operational rather than enforced — but it keeps the dashboard from reading a table that is
mid-deletion.

```bash
# $CTX_ALL is the PHASE 2 definition from §4.4 (real origin, no wildcard). If you are starting a
# fresh shell, redefine it first — destroy synthesizes the app too and every guard still applies:
#   CTX_ALL="-c ugp:githubOrg=emicmrg -c ugp:githubRepo=unified-golden-path \
#     -c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com"

# ⚠️ ALL DESTRUCTIVE AND IRREVERSIBLE — each needs explicit confirmation.
pnpm --dir infra exec cdk destroy DashboardStack    $CTX_ALL
pnpm --dir infra exec cdk destroy SelfHealingStack  $CTX_ALL
pnpm --dir infra exec cdk destroy UgpIotStack       $CTX_ALL
```

Notes and manual cleanup:

- `cdk destroy` still needs the **full context** of §4.0 — the app is synthesized before anything
  is destroyed, so the guard of *any* stack throws before CloudFormation is ever called. This is
  the same trap as §3: `cdk destroy UgpIotStack` with no context fails on the `SelfHealingStack`
  OIDC guard and the `DashboardStack` CORS guard, neither of which you are touching.
- The **ECR repo** has `emptyOnDelete: true`, so the pushed images go with it. If deletion stalls,
  empty it manually: `aws ecr batch-delete-image --repository-name ugp-self-healing-crew --image-ids imageTag=latest`.
- The **firmware S3 bucket** (`FirmwareBucketName`) may be versioned and refuse to delete while
  non-empty. Clear it first (destructive): `aws s3 rm s3://<bucket> --recursive`, then purge
  remaining versions/delete-markers if versioning is on.
- The **GitHub App secret** has `RemovalPolicy.DESTROY` but Secrets Manager applies a recovery
  window; force immediate deletion with
  `aws secretsmanager delete-secret --secret-id <arn> --force-delete-without-recovery` if you need
  to redeploy under the same name right away.
- **IoT certificates** must be deactivated and detached before the policy/Thing go away; if the
  stack created the cert from a CSR, CDK handles it, but an out-of-band cert must be cleaned
  manually.
- The **`CDKToolkit`** bootstrap stack survives on purpose. Leave it unless you are decommissioning
  the sandbox.
- **Remove the GitHub repository variables too** (`gh variable delete ...`), otherwise the
  workflows keep pointing at ARNs that no longer resolve.

### Destroy after the talk

Two reasons, not one:

1. **Cost.** Idle spend is small (DynamoDB on-demand, a secret, log retention, Amplify hosting),
   but Bedrock Sonnet 4.5 invocations are the real variable — a looping crew is the expensive
   failure mode, which is exactly what `MAX_ATTEMPTS=2` and the circuit breaker exist to cap.
2. **Exposure.** The dashboard ships a **guest Cognito Identity Pool** (unauthenticated identities
   enabled) and a **public Function URL** (`authType=NONE`). Both are intentionally narrow — IoT
   `subscribe`-only on one topic, read-only Lambda with reserved concurrency 5 — but they are
   internet-reachable with no login. Leaving them up indefinitely after the demo is standing
   exposure with no owner watching it.

---

## 8. Security debt still open

Known, accepted-for-the-demo, and **not** to be carried into anything real. Cross-referenced in
[`.github/workflows/README.md`](../.github/workflows/README.md) and `infra/README.md`.

| ID | Debt | Recommended fix |
|---|---|---|
| **Bedrock cost control** | No spend guardrail on Bedrock. AWS Budgets is not available in this sandbox account, so the "runaway crew" blast radius is bounded only by `MAX_ATTEMPTS=2` and the DynamoDB circuit breaker — both *inside* the application. | Lower the per-model **service quota** (requests/tokens per minute) as the hard ceiling; add a **budget alarm** where Budgets is available; alarm on the CloudWatch `AWS/Bedrock` `InputTokenCount` / `OutputTokenCount` / `Invocations` metrics for the inference profile. |
| **M1-sec** | `ugp-ci-deploy-role` permits **arbitrary `--overrides` on `ecs:RunTask`**. The workflow only overrides env vars today, but whoever controls the workflow could inject container commands and borrow the task role. | Move the dispatch into a **Lambda or EventBridge rule with fixed overrides**, and drop `RunTask` override permissions from the CI role. |
| **Firmware hardening** | **Secure Boot v2 and NVS/flash encryption are not enabled.** The device cert and key sit in readable flash; firmware can be replaced over USB. | Enable Secure Boot v2 + flash/NVS encryption in `sdkconfig`, burn the eFuses, and store the private key in encrypted NVS (ideally generated on-device so it never leaves it). |
| **Dependency bump** | `sample-service` pins **vitest 2.1.8**; newer patches are available. | Bump vitest (and re-run `pnpm test`) in a dedicated PR. |
| **No WAF** | The status **Function URL has no WAF** in front of it. Protection is CORS + `reservedConcurrency: 5` + a read-only handler — enough to bound cost, not enough to stop abuse. | Put CloudFront + AWS WAF (rate-based rule) in front, or move the endpoint behind API Gateway with throttling and usage plans. |
| **B3-sec** | Branch protection on `main` — see §6. | **Configure it before enabling any self-healing runner.** |

---

## Quick reference

```bash
# The context EVERY command needs (§4.0) — all three stacks synthesize on every invocation.
CTX_ALL="-c ugp:githubOrg=emicmrg -c ugp:githubRepo=unified-golden-path \
  -c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com"
# Before the Amplify domain exists, swap the origin for: -c ugp:allowWildcardCors=true

# Safe (read-only) — run any time
pnpm --dir infra exec cdk list  $CTX_ALL
pnpm --dir infra exec cdk synth $CTX_ALL [Stack]
pnpm --dir infra exec cdk diff  $CTX_ALL [Stack]
aws cloudformation describe-stacks --stack-name <Stack> --query 'Stacks[0].Outputs'

# Requires explicit confirmation — mutates AWS or GitHub
cdk bootstrap · cdk deploy <Stack> $CTX_ALL · cdk destroy <Stack> $CTX_ALL
aws secretsmanager put-secret-value · docker push · aws amplify start-deployment
gh variable set · gh api -X PUT .../protection      # restrictions MUST be null on a personal repo
```

Omitting any part of `$CTX_ALL` aborts the command whatever stack you name — the guards run while
the app is being built, before the CLI picks a stack.

Related docs: [`infra/README.md`](../infra/README.md) ·
[`.github/workflows/README.md`](../.github/workflows/README.md) ·
[`self-healing-crew/README.md`](../self-healing-crew/README.md) ·
[`web-dashboard/README.md`](../web-dashboard/README.md) ·
[`edge-firmware/README.md`](../edge-firmware/README.md)
