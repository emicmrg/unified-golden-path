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
| `ugp_cold_chain_firmware` | `AWS::Signer::SigningProfile` | `AWSIoTDeviceManagement-SHA256-ECDSA` |
| OTA role | `AWS::IAM::Role` | assumed by `iot.amazonaws.com`, least-privilege |
| `ugp-cold-chain-ota` | `AWS::IoT::JobTemplate` | rollout/retry/abort schema only (see "Launching a signed OTA") |

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
pnpm synth -- -c ugp:deviceCsrPath=./device.csr

# B) certificate already existing in the account
pnpm synth -- -c ugp:deviceCertificateArn=arn:aws:iot:us-east-1:<acct>:cert/<id>
```

With neither of the two, the stack still synthesizes (Thing + Policy) but without attachments,
and emits a warning.

### Available context

| Context | Effect |
|---|---|
| `ugp:deviceCsrPath` | path to a PEM CSR → creates `AWS::IoT::Certificate` + attachments |
| `ugp:deviceCertificateArn` | references an existing cert → attachments only |
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

### Launching a signed OTA

`AWS::IoT::OTAUpdate` does not exist in CloudFormation: the OTA is an API call.

**Why the Job Template does not carry the signed binary URL.** AWS Signer writes the signed
object to `signed/<signingJobId>`, where `signingJobId` is a UUID that only exists after running
the signing job. It is not knowable at synth time, and `create-job --document-parameters` does
not apply to custom job templates (only to the AWS *managed templates*). That is why the
`firmware.url` field of the document is the explicit placeholder
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

# 1) UNSIGNED binary (Signer input)
aws s3 cp build/ugp-gateway.bin "s3://$BUCKET/unsigned/$VERSION/ugp-gateway.bin"

# 2) OTA Update: IoT signs with our profile, leaves the signed binary in signed/<signingJobId>,
#    creates the MQTT stream and the IoT Job with the already resolved document.
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
    "fileLocation":{"s3Location":{"bucket":"'"$BUCKET"'","key":"unsigned/'"$VERSION"'/ugp-gateway.bin"}},
    "codeSigning":{"startSigningJobParameter":{
       "signingProfileName":"ugp_cold_chain_firmware",
       "destination":{"s3Destination":{"bucket":"'"$BUCKET"'","prefix":"signed/"}}}}
  }]'

# 3) follow-up
aws iot get-ota-update --ota-update-id "ugp-ota-$VERSION"
```

Manual alternative (debugging): read the REAL key of the signed object and create the job with
the already resolved document. See the documentation block of `src/constructs/firmware-ota.ts`.

### Deferred to Block 3

| Topic | Status |
|---|---|
| resolved `firmware.url` | set by `create-ota-update`; the template leaves a fail-loud placeholder |
| rollback health-check | the document declares the contract (`healthCheckSeconds: 120`); the firmware implementation (`esp_ota_mark_app_valid_cancel_rollback()`) arrives in Block 3 |
| `githubOrg` / `githubRepo` | consumed by `SelfHealingStack` via context (`-c ugp:githubOrg=... -c ugp:githubRepo=...`); not pinned in `cdk.json` |

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
| `ugp-ci-deploy-role` | `AWS::IAM::Role` | GitHub Actions OIDC, least-privilege |
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
the provider shared by the rest of the pipelines.

### Before deploying

```bash
# githubOrg/githubRepo are placeholders: without them nobody can assume the trust policy
# (the stack emits a synth WARNING).
pnpm synth -- SelfHealingStack -c ugp:githubOrg=<org> -c ugp:githubRepo=<repo>

# After the deploy, replace the secret's random value with the real private key:
aws secretsmanager put-secret-value --secret-id <GithubAppSecretArn> \
  --secret-string "$(cat github-app.private-key.pem)"
```

Optional: reuse an existing secret with `-c ugp:githubAppSecretArn=<arn>` (the stack then creates
none).

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
- **Open debt**: CORS defaults to `*` and the stack emits a synth WARNING. Before the final
  deploy it must be narrowed to the Amplify domain (see below).

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
| `ugp:dashboardAllowedOrigins` | comma-separated list of CORS origins (defaults to `*` + warning) |
| `ugp:iotEndpoint` | literal ATS endpoint, if already known |
| `ugp:resolveIotEndpoint=true` | resolves it with a read-only custom resource (`iot:DescribeEndpoint`) |
| `ugp:dashboardBasicAuthSecretArn` | ARN of a `{"username","password"}` secret to lock down the hosting during rehearsals |

```bash
# Before the final deploy: scoped CORS + resolved endpoint
pnpm synth DashboardStack \
  -c ugp:dashboardAllowedOrigins=https://main.d1abc2def3.amplifyapp.com \
  -c ugp:resolveIotEndpoint=true
```

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
