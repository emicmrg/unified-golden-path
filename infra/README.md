# infra — CDK Infrastructure (Unified Golden Path)

CDK v2 TypeScript stack for the project's AWS infrastructure.

## Commands

```bash
pnpm install            # dependencies
pnpm build              # type-check (tsc)
pnpm test               # CDK assertion tests (jest, run-once)
pnpm synth              # synthesize CloudFormation into cdk.out/
pnpm diff               # diff against the deployed stack
```

> **`pnpm synth` / `pnpm diff` fail without GitHub context.** `SelfHealingStack` is
> **fail-closed**: with the `CHANGE-ME-ORG/CHANGE-ME-REPO` placeholders the trust policy of both
> OIDC roles would trust a repository anyone could register on GitHub, so synth aborts. Use one
> of the two forms:
>
> ```bash
> # Real values (the only form that may be deployed)
> pnpm synth -c ugp:githubOrg=<org> -c ugp:githubRepo=<repo>
>
> # Local synth / talk demo: explicit opt-in to the placeholders. NEVER deploy this template.
> pnpm synth -c ugp:allowPlaceholderRepo=true
> ```
>
> Pass context **without** `--`: `pnpm run <script> -- -c k=v` hands `cdk` a literal `--`, which
> turns the rest into positional stack selectors and silently drops the context.

> Deploy requires explicit confirmation and a bootstrapped account/region.
> See `.kiro/skills/aws-safe-ops/SKILL.md`.

## `UgpIotStack` — edge platform

| Resource | Type | Note |
|---|---|---|
| `ugp-cold-chain-gateway` | `AWS::IoT::ThingType` | searchable attributes: `mac`, `site`, `hardware` |
| `ugp-gateway-01` | `AWS::IoT::Thing` | ESP32-D0WD-V3 gateway |
| `ugp-cold-chain-gateway-least-privilege` | `AWS::IoT::Policy` | scoped by `${iot:Connection.Thing.ThingName}` |
| certificate + attachments | `AWS::IoT::Certificate`, `*PrincipalAttachment` | only if a CSR or ARN is passed (see below) |
| firmware bucket | `AWS::S3::Bucket` | versioned, SSE-S3, TLS≥1.2 enforced, `BLOCK_ALL` |
| `ugp_cold_chain_firmware` | `Custom::AWS` (`signer:PutSigningProfile`) | **OPTIONAL, not created by default** — only with `-c ugp:signingCertificateArn=<acm-arn>`. See "Code-signing (optional)" below |
| OTA role | `AWS::IAM::Role` | assumed by `iot.amazonaws.com`, least-privilege. **Zero `signer:*` permissions** unless code-signing is enabled |
| `ugp-cold-chain-ota` | `AWS::IoT::JobTemplate` | rollout/retry/abort schema only (see "Launching an OTA") |

### Code-signing (optional)

**Default: disabled.** `cdk deploy UgpIotStack` creates no signing profile, no custom resource
and no `signer:*` IAM statement anywhere in the stack (the default template has **zero**
statements with `Resource: "*"`). Two reasons, both load-bearing:

1. `AWSIoTDeviceManagement-SHA256-ECDSA` is a **bring-your-own-certificate** platform:
   `signer:PutSigningProfile` is rejected without `signingMaterial.certificateArn`, and the
   project has no code-signing certificate in ACM. The profile cannot be created without one, so
   an unconditional profile fails the deploy.
2. On-device signature verification is **Block-3 debt A1** (secure boot + signature checks in the
   firmware). Signing in the cloud while the device does not verify the signature adds no
   security, and it forces a `signer:PutSigningProfile` grant on `Resource: "*"` (that action has
   no resource-level permissions) into every deploy for no benefit.

**The OTA pipeline is fully functional without it.** The integrity chain on the default path is
(a) TLS 1.2+ on the S3 presigned URL — the bucket policy denies anything else — and (b) the
SHA-256 digest ESP-IDF appends to every app image, which `esp_ota_end()` validates before the new
partition is marked bootable, so a truncated or corrupted download never boots. What is missing
versus a signed OTA is *authenticity* (proof of origin), which is exactly what A1 adds.

Honest outputs: with code-signing disabled the stack emits **no** `SigningProfileArn` /
`SigningProfileName` (no dangling ARN to a profile that does not exist) and the job document omits
`firmware.signingProfile`. `CodeSigningStatus` always reports the deployed posture.

To enable it, import a SHA256-ECDSA code-signing certificate into ACM (self-signed is enough in
the sandbox) and pass the ARN:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out firmware-signing.key
openssl req -new -x509 -sha256 -days 365 -key firmware-signing.key \
  -out firmware-signing.crt -subj "/CN=ugp-firmware-signing" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"
CERT_ARN=$(aws acm import-certificate \
  --certificate fileb://firmware-signing.crt \
  --private-key fileb://firmware-signing.key \
  --query CertificateArn --output text)

pnpm diff -c ugp:signingCertificateArn=$CERT_ARN                      # read-only
pnpm exec cdk deploy UgpIotStack -c ugp:signingCertificateArn=$CERT_ARN   # ⚠️ needs confirmation
```

That path adds: the `Custom::AWS` profile resource (`putSigningProfile` with `signingMaterial`,
`AWSIoTDeviceManagement-SHA256-ECDSA`, 365-day signatures, cancelled via
`signer:CancelSigningProfile` on destroy), its **dedicated** provider execution role, and the OTA
role's scoped `signer:StartSigningJob` + `signer:GetSigningProfile` on the profile ARN. The
`AWS::Signer::SigningProfile` L1 is **not** used on either path: its CFN registry schema
hard-codes a stale `PlatformId` enum (`AWSLambda-SHA384-ECDSA`, `Notation-OCI-SHA384-ECDSA`),
rejects the IoT platform at Early Validation even though the Signer service accepts it, and cannot
express `signingMaterial`.

IAM split on the enabled path (the two documented wildcards, and the only ones in the stack):

| Action | Resource | Why |
|---|---|---|
| `signer:PutSigningProfile` | `*` | no resource types in the Signer authorization reference — the profile does not exist yet when the call is made. Isolated in its own statement, in its own role |
| `signer:GetSigningProfile`, `signer:CancelSigningProfile` | the profile ARN | both support the `signing-profile` resource type |
| `signer:StartSigningJob`, `signer:GetSigningProfile` (OTA role) | the profile ARN | AWS IoT can only sign with our profile |
| `signer:DescribeSigningJob` (OTA role) | `*` | the signing-job ARN only exists after the job is created |

> **Known trade-off (not a bug).** The `AwsCustomResource` provider Lambda is a **per-stack
> singleton**, so the dedicated role backs every `AwsCustomResource` in `UgpIotStack` — in
> practice the read-only `iot:DescribeEndpoint` resource when `ugp:resolveIotEndpoint=true`. All
> of them already run the same function code, so per-resource isolation is not achievable with
> the shared provider. What the dedicated role buys is an explicit, reviewable home for the
> wildcard, zero Signer permissions on the default path, and no Signer permissions in the IoT
> service role. The construct asserts at synth time that it was built before any other
> `AwsCustomResource` (otherwise CDK silently ignores the `role` prop).

### Device MQTT permissions

The IoT Policy uses no open `topic/*`. Every statement is resolved with the
`${iot:Connection.Thing.ThingName}` policy variable, so the certificate only works for its own
Thing:

| Action | Allowed resources |
|---|---|
| `iot:Connect` | `client/${thing}` + condition `iot:Connection.Thing.IsAttached = true` |
| `iot:Publish` | `ugp/telemetry/${thing}[/*]`, `$aws/things/${thing}/jobs/*`, `$aws/things/${thing}/streams/*` |
| `iot:Subscribe` | `topicfilter/` of `ugp/commands/${thing}[/*]`, `jobs/*`, `streams/*` |
| `iot:Receive` | the same topics as `Subscribe` |

### Provisioning the X.509 certificate

CloudFormation cannot generate a key pair. There are two supported paths:

```bash
# A) CSR (recommended): the private key never leaves your machine nor enters the repo
openssl req -new -newkey rsa:2048 -nodes \
  -keyout device.key -out device.csr -subj "/CN=ugp-gateway-01"
pnpm synth -c ugp:deviceCsrPath=./device.csr

# B) certificate already existing in the account
pnpm synth -c ugp:deviceCertificateArn=arn:aws:iot:us-east-1:<acct>:cert/<id>
```

With neither of the two, the stack still synthesizes (Thing + Policy) but without attachments,
and emits a warning.

### Available context

| Context | Effect |
|---|---|
| `ugp:deviceCsrPath` | path to a PEM CSR → creates `AWS::IoT::Certificate` + attachments |
| `ugp:deviceCertificateArn` | references an existing cert → attachments only |
| `ugp:signingCertificateArn` | ACM **code-signing** certificate ARN → enables the AWS Signer profile and the OTA role's Signer grants. Without it the OTA ships unsigned (see "Code-signing (optional)") |
| `ugp:resolveIotEndpoint=true` | adds a read-only custom resource (`iot:DescribeEndpoint`) and exposes the ATS endpoint as an output |

The account always comes from the active credentials (`CDK_DEFAULT_ACCOUNT`, never hardcoded).
The region uses `CDK_DEFAULT_REGION` and falls back to `us-east-1` **only as a synth default** so
that `pnpm synth` and the tests work without a profile; the deploy uses the region of the active
profile.

### Post-deploy steps (not declarative)

1. Associate Thing ↔ Thing Type (`AWS::IoT::Thing` does not support `ThingTypeName` in CFN):
   ```bash
   aws iot update-thing --thing-name ugp-gateway-01 \
     --thing-type-name ugp-cold-chain-gateway
   ```
2. Get the MQTT endpoint for the firmware:
   ```bash
   aws iot describe-endpoint --endpoint-type iot:Data-ATS
   ```

### Launching an OTA

`AWS::IoT::OTAUpdate` does not exist in CloudFormation: the OTA is an API call.

**Why the Job Template does not carry the firmware URL.** The final S3 key is only known at OTA
time — and with code-signing enabled AWS Signer writes the signed object to
`signed/<signingJobId>`, where `signingJobId` is a UUID that only exists after running the signing
job. It is not knowable at synth time, and `create-job --document-parameters` does not apply to
custom job templates (only to the AWS *managed templates*). That is why the `firmware.url` field
of the document is the explicit placeholder
`REPLACE_VIA_CREATE_OTA_UPDATE:signed-firmware-presigned-url`: if it reached the device
unreplaced, the OTA fails visibly instead of requesting a non-existent key (silent 404).
The Job Template provides **only the rollout schema** (timeout, rate limit, retry, abort) and the
shape of the document the firmware parses.

Recommended flow — `create-ota-update` generates its own job document with the real location:

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name UgpIotStack \
  --query "Stacks[0].Outputs[?OutputKey=='FirmwareBucketName'].OutputValue" --output text)
OTA_ROLE=$(aws cloudformation describe-stacks --stack-name UgpIotStack \
  --query "Stacks[0].Outputs[?OutputKey=='OtaServiceRoleArn'].OutputValue" --output text)
THING_ARN=$(aws cloudformation describe-stacks --stack-name UgpIotStack \
  --query "Stacks[0].Outputs[?OutputKey=='ThingArn'].OutputValue" --output text)
VERSION=1.0.1

# 1) binary
aws s3 cp build/ugp-gateway.bin "s3://$BUCKET/unsigned/$VERSION/ugp-gateway.bin"

# 2) OTA Update: IoT creates the MQTT stream and the IoT Job with the already resolved document.
#    DEFAULT PATH (code-signing disabled): NO `codeSigning` block in --files.
aws iot create-ota-update \
  --ota-update-id "ugp-ota-$VERSION" \
  --description "Cold chain OTA $VERSION" \
  --targets "$THING_ARN" \
  --target-selection SNAPSHOT \
  --protocols MQTT \
  --role-arn "$OTA_ROLE" \
  --aws-job-executions-rollout-config '{"maximumPerMinute":5}' \
  --aws-job-abort-config '{"abortCriteriaList":[{"failureType":"FAILED","action":"CANCEL","thresholdPercentage":100,"minNumberOfExecutedThings":1}]}' \
  --aws-job-timeout-config '{"inProgressTimeoutInMinutes":15}' \
  --files '[{
    "fileName":"ugp-gateway.bin",
    "fileType":0,
    "fileLocation":{"s3Location":{"bucket":"'"$BUCKET"'","key":"unsigned/'"$VERSION"'/ugp-gateway.bin"}}
  }]'

# 3) follow-up
aws iot get-ota-update --ota-update-id "ugp-ota-$VERSION"
```

Only when the stack was deployed with `-c ugp:signingCertificateArn=<acm-arn>`, add the inline
signing job to that `--files` entry (the profile name is the `SigningProfileName` output):

```json
"codeSigning":{"startSigningJobParameter":{
   "signingProfileName":"ugp_cold_chain_firmware",
   "destination":{"s3Destination":{"bucket":"<BUCKET>","prefix":"signed/"}}}}
```

Manual alternative (debugging): read the REAL key of the signed object and create the job with
the already resolved document. See the documentation block of `src/constructs/firmware-ota.ts`.

### Deferred to Block 3

| Topic | Status |
|---|---|
| **A1 — firmware signature verification** | the device does **not** verify an image signature yet (secure boot + `esp_ota_*` signature checks land in Block 3). Until then cloud-side code-signing is disabled by default: it would be theater. Integrity is covered by TLS 1.2+ and the SHA-256 app-image digest checked by `esp_ota_end()` |
| resolved `firmware.url` | set by `create-ota-update`; the template leaves a fail-loud placeholder |
| rollback health-check | the document declares the contract (`healthCheckSeconds: 120`); the firmware implementation (`esp_ota_mark_app_valid_cancel_rollback()`) arrives in Block 3 |
| `githubOrg` / `githubRepo` | consumed by `SelfHealingStack` via context (`-c ugp:githubOrg=... -c ugp:githubRepo=...`); not pinned in `cdk.json`. Without them synth **fails** unless `-c ugp:allowPlaceholderRepo=true` |

**Note on `abortConfig`.** With the demo's fleet of 1 device, `minNumberOfExecutedThings: 1` +
`thresholdPercentage: 100` implies fail-fast: one `FAILED` cancels the job, so the
`numberOfRetries: 2` only materializes with fleets > 1. This is deliberate. To consume the
retries before aborting, raise `minNumberOfExecutedThings` above the fleet size.

## `SelfHealingStack` — self-healing agent runner

| Resource | Type | Note |
|---|---|---|
| `ugp-self-healing-crew` | `AWS::ECR::Repository` | scan-on-push, keeps 10 images, `EmptyOnDelete` |
| `ugp-self-healing` | `AWS::ECS::Cluster` | Fargate; no Container Insights (minutes-long job) |
| `ugp-self-healing-crew` | `AWS::ECS::TaskDefinition` | `awsvpc`, 1 vCPU / 2 GB, no `portMappings` and no Service |
| `CrewTaskRole` | `AWS::IAM::Role` | Bedrock (1 model) + 1 secret + 3 DynamoDB actions |
| `CrewExecutionRole` | `AWS::IAM::Role` | pull scoped to *this* ECR repo + log writing |
| `ugp-self-healing-circuit-breaker` | `AWS::DynamoDB::Table` | `pk` = `owner/repo#runKey`, PAY_PER_REQUEST, TTL `expiresAt` |
| `GithubAppSecret` | `AWS::SecretsManager::Secret` | **placeholder**: the PEM is uploaded outside CDK |
| `ugp-ci-deploy-role` | `AWS::IAM::Role` | GitHub Actions OIDC, least-privilege (Runner 2: dispatch to Fargate) |
| `ugp-bedrock-ci-role` | `AWS::IAM::Role` | GitHub Actions OIDC, least-privilege (Runner 1: crew inside Actions) |
| `/aws/ecs/ugp-self-healing-crew` | `AWS::Logs::LogGroup` | 7 day retention |
| `CrewVpc` | `AWS::EC2::VPC` | 2 AZs, **0 NAT Gateways**, public subnets only, default SG closed |

### The real minimum of `bedrock:InvokeModel` with an inference profile

Claude Sonnet 4.5 **has no on-demand mode**: it is only invoked through the cross-region
inference profile `us.anthropic.claude-sonnet-4-5-20250929-v1:0`. When invoking it, Bedrock
authorizes the call **twice**:

1. against the requested resource — the `inference-profile/us.anthropic...` of *this* account and
   region;
2. against the `foundation-model/anthropic...` of the region the router sends the request to
   (`us-east-1`, `us-east-2` or `us-west-2`).

Allowing only (1) produces an intermittent `AccessDeniedException` (it fails when the router
picks a region whose foundation model ARN is not allowed). That is why the task role lists
**4 exact ARNs** — the profile and the three foundation models — and nothing else: no
`bedrock:*`, no `foundation-model/*`, no other regions. Foundation model ARNs carry an **empty**
account field (they are owned by the service).

### `ugp-ci-deploy-role` permissions

| Action | Resource | Condition |
|---|---|---|
| `sts:AssumeRoleWithWebIdentity` | — | `aud` = `sts.amazonaws.com` **and** `sub` = `repo:<org>/<repo>:ref:refs/heads/main` (`StringEquals`) |
| `ecs:RunTask` | `task-definition/ugp-self-healing-crew:*` | `ecs:cluster` = the crew cluster |
| `ecs:DescribeTasks` | `task/<cluster>/*` | `ecs:cluster` = the crew cluster |
| `iam:PassRole` | only the crew task role + execution role | `iam:PassedToService` = `ecs-tasks.amazonaws.com` |
| `logs:GetLogEvents`, `logs:DescribeLogStreams` | only the crew log group | — |

It cannot read the secret, nor invoke Bedrock, nor touch DynamoDB (there is a regression test).

**About the `sub`.** By default it is `StringEquals` with an exact value: a `sub` without
wildcards cannot be widened by accident. If assuming the role from pull requests were needed, the
variant is `StringLike` with `repo:<org>/<repo>:*` — **never** `repo:<org>/*`, because that lets
any repository in the organization (including a freshly created one) assume the role.

**The OIDC provider is imported, not created.** IAM only allows one `OpenIDConnectProvider` per
URL and the one for `token.actions.githubusercontent.com` already exists in the account:
declaring it in CloudFormation fails with `EntityAlreadyExists`, and a `cdk destroy` could delete
the provider shared by the rest of the pipelines. Both OIDC roles reference that **same imported**
provider.

### `ugp-bedrock-ci-role` permissions (Runner 1)

`.github/workflows/self-heal-gha.yml` runs the crew **inside the GitHub Actions runner** instead
of dispatching it to Fargate. It assumes this role via OIDC
(`role-to-assume: ${{ vars.BEDROCK_CI_ROLE_ARN }}`), so the role carries the permissions of the
crew *code* — and only the subset that mode needs.

| Action | Resource | Condition |
|---|---|---|
| `sts:AssumeRoleWithWebIdentity` | — | `aud` = `sts.amazonaws.com` **and** `sub` = `repo:<org>/<repo>:ref:refs/heads/main` (`StringEquals`) |
| `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` | the **same 4 exact ARNs** as the task role (1 inference profile + 3 foundation models) | — |
| `dynamodb:GetItem`, `dynamodb:UpdateItem` | only `ugp-self-healing-circuit-breaker` | — |

Two statements, zero `Resource: "*"`, no managed policies, `MaxSessionDuration` 1 h. The Bedrock
ARNs come from the same array the task role uses, and a test asserts both statements are deeply
equal so they cannot drift.

**No `secretsmanager:GetSecretValue` — this is the deliberate difference against the task role.**
Runner 1 sets `UGP_ALLOW_ENV_TOKEN=true` and hands the crew the workflow's native `GITHUB_TOKEN`
(`contents:write` + `pull-requests:write`, scoped to this repo, expiring with the job), so it
never signs a GitHub App JWT and never reads the PEM. Granting the secret here would give an
Actions runner a credential valid for the whole App installation. There is also no `ecs:*`
(Runner 1 launches no task) and no `logs:*` (it reads the CI log through the GitHub API).

**The trust `sub` is pinned to the branch and ignores `ugp:ciSubjectScope`.** The workflow
triggers on `workflow_run`, an event GitHub always evaluates on the default branch, so the token
`sub` is exactly `repo:<org>/<repo>:ref:refs/heads/main`. Widening it to `StringLike` would let a
pull-request workflow — whose content any contributor can propose — obtain Bedrock credentials.

### GitHub repository variables fed by the stack outputs

| Repository variable | Stack output | Used by |
|---|---|---|
| `BEDROCK_CI_ROLE_ARN` | `BedrockCiRoleArn` | `self-heal-gha.yml` (Runner 1) |
| `DDB_TABLE_NAME` | `CircuitBreakerTableName` | both runners |
| `BEDROCK_MODEL_ID` | `BedrockInferenceProfileArn` (profile id) | both runners |
| `CI_DEPLOY_ROLE_ARN` | `CiDeployRoleArn` | `self-heal-dispatch.yml` (Runner 2) |
| `CREW_CLUSTER_NAME` | `CrewClusterName` | `self-heal-dispatch.yml` (Runner 2) |
| `CREW_TASK_DEF_ARN` | `CrewTaskDefinitionArn` | `self-heal-dispatch.yml` (Runner 2) |
| `CREW_SUBNET_IDS` | `CrewSubnetIds` | `self-heal-dispatch.yml` (Runner 2) |
| `SELF_HEAL_MODE` | — (`gha` \| `fargate`) | selects the active runner |

### Before deploying

```bash
# githubOrg/githubRepo are REQUIRED: with the placeholders synth fails (fail-closed), because
# the trust policy of both OIDC roles would point at a repo anyone could register on GitHub.
pnpm synth SelfHealingStack -c ugp:githubOrg=<org> -c ugp:githubRepo=<repo>

# Local synth / demo without a repository (warning only, DO NOT deploy the result):
pnpm synth SelfHealingStack -c ugp:allowPlaceholderRepo=true

# After the deploy, replace the secret's random value with the real private key:
aws secretsmanager put-secret-value --secret-id <GithubAppSecretArn> \
  --secret-string "$(cat github-app.private-key.pem)"
```

Optional: reuse an existing secret with `-c ugp:githubAppSecretArn=<arn>` (the stack then creates
none).

### Available context

| Context | Effect |
|---|---|
| `ugp:githubOrg` / `ugp:githubRepo` | org/repo scoped in the `sub` of both OIDC roles. **Required**: without them synth throws |
| `ugp:allowPlaceholderRepo=true` | opts into the `CHANGE-ME-*` placeholders: synth succeeds with a warning. Local/demo only, never deploy it |
| `ugp:githubAppId` / `ugp:githubInstallationId` | GitHub App identifiers injected into the task definition (not secrets) |
| `ugp:githubAppSecretArn` | reuses an existing secret instead of creating the placeholder one |

### Cost at rest

Practically zero: ECR (storage), on-demand DynamoDB (no traffic), Secrets Manager
(~0.40 USD/month) and the log group. **No NAT Gateway** (~32 USD/month/AZ avoided): egress goes
through the Internet Gateway with a public IP assigned at `RunTask`; the security group allows no
ingress. Fargate only bills the minutes the job runs.

## `DashboardStack` — read-only backend of the `web-dashboard`

Public SPA with no login, with two data channels of different natures:

| Channel | Transport | Credential | Resource |
|-------|-----------|------------|---------|
| Live telemetry (push) | MQTT over WSS to IoT Core, from the browser | **guest** Cognito Identity Pool | `IotGuestIdentityPool` |
| Aggregated state (pull/polling) | HTTPS GET to a Lambda Function URL | none (`authType=NONE`) | `ugp-dashboard-status` |
| SPA hosting | Amplify Hosting, **manual deploy** (no git) | — | `CfnApp` + `CfnBranch` |

There is no API Gateway: an anonymous GET, without usage plans or WAF and with a single consumer,
does not justify the extra resource. There is no intermediate backend for the telemetry either:
the browser **is** the MQTT client.

### The two public surfaces (what to audit before the deploy)

**1. Guest role** — anyone who opens the dashboard receives temporary AWS credentials in their
browser. The `identityPoolId` is public by design, so this role is the only boundary:

| Action | Resource | Why |
|--------|---------|---------|
| `iot:Connect` | `client/ugp-dashboard-*` | the gateway client id (`ugp-gateway-01`) does NOT match the pattern: stolen credentials cannot impersonate it and kick it off the broker |
| `iot:Subscribe` | `topicfilter/ugp/telemetry/ugp-gateway-01` | exact topic, no wildcards (`ugp/telemetry/*` would expose the whole fleet) |
| `iot:Receive` | `topic/ugp/telemetry/ugp-gateway-01` | `Subscribe` goes against `topicfilter/` and `Receive` against `topic/`; mixing them up gives `AUTHORIZATION_FAILURE` |

Nothing else: no `iot:Publish` (it cannot send commands to the gateway), no shadow, no jobs, no
DynamoDB, no `cognito-sync`, no managed policies and no `Resource: "*"` whatsoever.
The trust policy requires `aud == <this pool>` and `ForAnyValue:StringLike amr == unauthenticated`.

> **CONTRACT with the frontend**: Amplify PubSub must connect with a `clientId` starting with
> `ugp-dashboard-` (output `MqttClientIdPrefix`). Otherwise the broker rejects the CONNECT.

**2. Function URL** (`authType=NONE`) — anonymous GET. Compensating controls:

- Its role only has `dynamodb:Scan` + `dynamodb:GetItem` on **one** table
  (`ugp-self-healing-circuit-breaker`), without `/index/*` nor `/stream/*`. **Zero writes.**
- Logs scoped to its own log group (no `AWSLambdaBasicExecutionRole`, which would grant
  `logs:*` over the whole account).
- `reservedConcurrentExecutions: 5`: a `curl` loop against a public URL turns into 429s, not into
  a bill.
- It does not return the raw DynamoDB item: it projects only what is needed and drops
  `expiresAt`/internal keys.
- **CORS is fail-closed**: there is no wildcard default. Synth **throws** unless an explicit
  origin is passed with `-c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com`.
  The `-c ugp:allowWildcardCors=true` escape hatch keeps CORS at `*` with a synth warning and is
  **LOCAL SYNTH / DEMO ONLY** — except for the bootstrap deploy described in
  [Two-phase deploy](#two-phase-deploy-the-origin-does-not-exist-yet), it must never be the
  deployed state.

### Data contract (`GET <StatusApiUrl>`)

```json
{
  "pipeline":      { "status": "unknown", "note": "pending CI (block 6)" },
  "circuitBreaker": [ { "runKey": "18234", "attempts": 2, "maxAttempts": 2, "escalated": true } ],
  "crew":          { "timeline": [ { "ts": "…", "runKey": "18234", "event": "escalated-to-human", "detail": "2/2" } ], "pr": null },
  "generatedAt":   "2026-10-06T15:02:46.908Z",
  "degraded":      null
}
```

`pipeline.status` is `"unknown"` on purpose: the CI workflow is block 6 and there is no source of
truth yet. `crew.timeline` is derived from the table's `created_at`/`last_updated`/`escalated`,
which is the only state the crew persists today; `crew.pr` is `null` because the PR URL is not
stored. If the table does not exist (SelfHealingStack not deployed), it responds 200 with
`degraded` explaining why, instead of breaking.

The handler goes **inline** in the template (`Code.ZipFile`, a hard limit of 4096 chars that the
stack validates at synth time): no dependencies to bundle and, above all, the full code shows up
in `cdk diff`, which is exactly what you need to be able to audit on an endpoint with no auth.

### Coupling with `SelfHealingStack`

The circuit breaker table is referenced **by name** (`ugp-self-healing-circuit-breaker`,
deterministic in `SelfHealingStack`) and the ARN is composed with `Arn.format`.
`Fn::ImportValue` is not used on purpose: an export/import creates a hard dependency —
`SelfHealingStack` could no longer be deleted nor have its output renamed while `DashboardStack`
exists, and the deploy order would become coupled. The price is that the table name is an
explicit contract between both stacks, documented in both.

### Available context

| Context | Effect |
|----------|--------|
| `ugp:dashboardAllowedOrigins` | comma-separated list of CORS origins. **Required**: without it synth fails closed |
| `ugp:allowWildcardCors=true` | escape hatch: keeps CORS at `*` and emits a warning. Local synth/demo, plus the bootstrap deploy of the [two-phase deploy](#two-phase-deploy-the-origin-does-not-exist-yet) |
| `ugp:iotEndpoint` | literal ATS endpoint, if already known. Validated against `^[a-z0-9-]+\.iot\.[a-z0-9-]+\.amazonaws\.com$`: synth throws otherwise (it goes into the CSP) |
| `ugp:resolveIotEndpoint=true` | resolves it with a read-only custom resource (`iot:DescribeEndpoint`) |
| `ugp:dashboardBasicAuthSecretArn` | ARN of a `{"username","password"}` secret to lock down the hosting during rehearsals |

```bash
# Before the final deploy: scoped CORS + resolved endpoint
pnpm synth DashboardStack \
  -c ugp:dashboardAllowedOrigins=https://main.d1abc2def3.amplifyapp.com \
  -c ugp:resolveIotEndpoint=true
```

#### Fail-closed CORS on the status Function URL

The Function URL is `authType=NONE`, so CORS is the only thing deciding **which pages** may read
it from their visitors' browsers. A wildcard that is also the *default* is a wildcard nobody
notices, so there is no default: synth **aborts** without an explicit origin (same pattern as the
OIDC guard in `SelfHealingStack`).

```bash
# ❌ aborts: no origin and no opt-in
pnpm synth DashboardStack
# Error: DashboardStack: the status Function URL has authType=NONE and no CORS origin was
# provided, so the template would let ANY website read this endpoint from its visitors'
# browsers. Pass the Amplify domain: -c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com

# ✅ deployable: CORS scoped to the Amplify domain (no warning)
pnpm synth DashboardStack -c ugp:dashboardAllowedOrigins=https://main.d1abc2def3.amplifyapp.com

# ⚠️  local synth / demo only: CORS stays at '*' and a warning is emitted. Do NOT deploy it.
pnpm synth DashboardStack -c ugp:allowWildcardCors=true
```

Passing `'*'` explicitly inside `ugp:dashboardAllowedOrigins` (alone or mixed with real origins)
hits the same guard: the wildcard makes the rest of the list irrelevant.

#### Two-phase deploy: the origin does not exist yet

The origin that CORS has to allow is the Amplify domain `https://main.<appId>.amplifyapp.com`,
and `<appId>` is generated **by this stack**: it does not exist before the first deploy. The
reverse direction cannot be shortcut either — the CSP `connect-src` embeds the status Function
URL, so the template cannot self-reference the origin to compute it. Hence the first deploy is a
bootstrap and the final state is reached on the second:

```bash
# 1. FIRST deploy — the Amplify domain does not exist yet, so the only way through the
#    fail-closed guard is the explicit opt-in. This template has CORS at '*': it is a
#    bootstrap, NOT the final state.
pnpm --dir infra exec cdk deploy DashboardStack -c ugp:allowWildcardCors=true

# 2. Read the domain the deploy just created.
ORIGIN="https://$(aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyDefaultDomain'].OutputValue" --output text)"
echo "$ORIGIN"   # https://main.d1abc2def3.amplifyapp.com

# 3. REDEPLOY with CORS scoped to it (add -c ugp:resolveIotEndpoint=true, or
#    -c ugp:iotEndpoint=..., to also tighten the CSP connect-src).
pnpm --dir infra exec cdk deploy DashboardStack \
  -c ugp:dashboardAllowedOrigins="$ORIGIN" \
  -c ugp:resolveIotEndpoint=true

# 4. VERIFY the wildcard is gone. Access-Control-Allow-Origin must echo the origin, never '*'.
STATUS_URL=$(aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='StatusApiUrl'].OutputValue" --output text)
curl -sI -H "Origin: $ORIGIN" "$STATUS_URL" | grep -i access-control-allow-origin
# access-control-allow-origin: https://main.d1abc2def3.amplifyapp.com   ✅
# access-control-allow-origin: *                                        ❌ step 3 was skipped
```

Step 4 is the acceptance criterion of the deploy: while the header answers `*`, any website can
read this endpoint from its visitors' browsers. Only steps 1–2 are allowed to run with
`ugp:allowWildcardCors=true`.

#### Resolving `VITE_IOT_ENDPOINT`

The ATS endpoint is **not** a CloudFormation attribute: `iot:DescribeEndpoint` has to be called.
It is stable per account+region and it is not a secret, but it is **never hardcoded** in the repo.
Three paths:

1. `-c ugp:iotEndpoint=<prefix>-ats.iot.<region>.amazonaws.com` — literal, zero extra resources.
   Get it with `aws iot describe-endpoint --endpoint-type iot:Data-ATS`. The value is validated
   at synth time (see the CSP note below): anything that is not an ATS host throws.
2. `-c ugp:resolveIotEndpoint=true` — read-only `AwsCustomResource` (`iot:DescribeEndpoint`, the
   only action in its policy), the same pattern `UgpIotStack` already uses. It adds a Lambda to
   the stack, which is why it is opt-in.
3. Neither — the `IotEndpoint` output stays
   `UNRESOLVED (pass -c ugp:iotEndpoint=... or -c ugp:resolveIotEndpoint=true)`, the CSP carries
   no IoT host, and synth warns. An honest placeholder beats a wrong value baked into
   `.env.production`.

#### Security headers served by Amplify

Amplify serves the SPA from its own CloudFront distribution and sends **no** CSP or HSTS by
default — which, on a public page that holds guest IoT credentials in memory, means an injected
script could exfiltrate them. The app carries `customHeaders` (pattern `**/*`) with:

| Header | Value |
|--------|-------|
| `Content-Security-Policy` | `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no `preload`: this is a demo domain) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (old-browser equivalent of `frame-ancestors 'none'`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `geolocation=(), camera=(), microphone=(), payment=(), usb=()` |

`connect-src` is the interesting directive: it is the exact allow-list of what the page may talk
to — `wss://<ats-endpoint>` (MQTT), `https://cognito-identity.<region>.amazonaws.com` (which
mints the guest credentials) and the status Function URL. The Function URL is a CloudFormation
token, so the header resolves to an `Fn::Join` and is always consistent with the URL this stack
creates. `'unsafe-inline'` is tolerated for **styles only** (React `style={{...}}` attributes);
scripts stay on `'self'`.

When the ATS endpoint is unresolved, `connect-src` carries **no IoT host at all**: the
`UNRESOLVED (...)` sentence is not a valid CSP source, and a region-wide
`wss://*.iot.<region>.amazonaws.com` pattern would allow **any** account's IoT endpoint in the
region — surface granted for nothing, since on that path `VITE_IOT_ENDPOINT` is the sentinel and
the SPA cannot open the MQTT connection anyway. Resolve the endpoint (paths 1 or 2 above) to get
the tight value; synth warns while it is missing.

A **literal** endpoint (path 1 / `iotEndpointAddress`) is validated against
`^[a-z0-9-]+\.iot\.[a-z0-9-]+\.amazonaws\.com$` and synth **throws** if it does not match. The
reason is this header: the value is interpolated into a double-quoted YAML scalar, where a `"`
closes the scalar and a `;` ends the CSP directive, so a typo (or a hostile
`-c ugp:iotEndpoint=...`) could otherwise inject an arbitrary directive into the page's CSP. The
resolved value (path 2) is a CloudFormation token and skips the check by construction.

The basic auth password never enters the template: it is injected as a *dynamic reference*
`{{resolve:secretsmanager:<arn>:SecretString:password}}` that CloudFormation resolves at deploy
time.

### Configuring the frontend build

Every output carries its `VITE_*` variable in the description, and `ViteEnvFile` joins them into
a pasteable block:

```bash
aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='ViteEnvFile'].OutputValue" \
  --output text > web-dashboard/.env.production
```

| Output | Variable |
|--------|----------|
| `IdentityPoolId` | `VITE_IDENTITY_POOL_ID` |
| `AwsRegion` | `VITE_AWS_REGION` |
| `IotEndpoint` | `VITE_IOT_ENDPOINT` |
| `TelemetryTopic` | `VITE_TELEMETRY_TOPIC` |
| `StatusApiUrl` | `VITE_STATUS_API_URL` |
| `MqttClientIdPrefix` | `VITE_MQTT_CLIENT_ID_PREFIX` |

### Manual deploy of the build to Amplify (no git)

The app has no `sourceCodeProvider`: the repository does not exist yet and connecting it would
require a GitHub token with `repo` scope stored in the account. Without a provider, Amplify works
in *manual deployment* mode (and no build minutes are paid):

```bash
APP_ID=$(aws cloudformation describe-stacks --stack-name DashboardStack \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyAppId'].OutputValue" --output text)

pnpm --dir web-dashboard run build
(cd web-dashboard/dist && zip -r ../dist.zip .)

read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment \
  --app-id "$APP_ID" --branch-name main \
  --query "[jobId, zipUploadUrl]" --output text)

curl -X PUT --upload-file web-dashboard/dist.zip "$UPLOAD_URL"
aws amplify start-deployment --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID"
```

The SPA rewrite (`/<*>` → `/index.html`, status `200`) is declared in `customRules`: without it,
reloading `/fleet` would return 404 because that object does not exist.

### Cost at rest

Practically zero: Lambda and the Function URL only bill invocations, the Identity Pool is free,
Amplify charges for build storage and transfer (cents) and there are no build minutes since it is
a manual deploy. The DynamoDB table is paid for by `SelfHealingStack`.

## Structure

```
infra/src/
├── app.ts                          CDK entry point (tags + context reading)
├── stacks/
│   ├── ugp-iot-stack.ts            edge platform: composition + outputs
│   ├── self-healing-stack.ts       crew runner: ECR + Fargate + DDB + OIDC
│   └── dashboard-stack.ts          dashboard: Cognito guest + Lambda/Function URL + Amplify
├── constructs/
│   ├── edge-device.ts              Thing Type + Thing + Policy + cert/attachments
│   ├── firmware-ota.ts             S3 bucket + Signer + OTA role + Job Template
│   ├── github-oidc-role.ts         role assumable by GitHub Actions (imported provider)
│   └── iot-guest-identity-pool.ts  guest Identity Pool + IoT-subscribe-only IAM role
└── lambda/
    └── dashboard-status-handler.ts inline handler of the status Lambda (string)
```
