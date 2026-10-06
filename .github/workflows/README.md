# GitHub Actions Workflows — Unified Golden Path

This directory contains the CI/CD workflows for the monorepo. They are designed
for the demo of the talk **Platform Engineering: "The Unified Golden Path"**,
showing the complete AI-driven self-healing cycle.

---

## Files

| File | Role |
|---|---|
| `sample-service-ci.yml` | Main CI pipeline — the one that can fail |
| `self-heal-gha.yml` | Runner 1: self-healing crew inside Actions |
| `self-heal-dispatch.yml` | Runner 2: dispatches the crew to Fargate via OIDC |

---

## End-to-end flow

```
push to any branch with changes in sample-service/**
        │
        ▼
┌─────────────────────────┐
│   sample-service-ci     │  Job: build + vitest run
│   (ubuntu-latest)       │  ← FAILS if Bug A is injected
└─────────────────────────┘
        │
        │ conclusion == 'failure'
        │ (workflow_run event)
        │
        ├──────────────────────────────────────────────────────────┐
        ▼                                                          ▼
┌─────────────────────────┐                    ┌─────────────────────────────┐
│   self-heal-gha         │                    │   self-heal-dispatch        │
│   Runner 1 — SIMPLE     │                    │   Runner 2 — ISOLATED       │
│                         │                    │                             │
│ 1. Checkout             │                    │ 1. OIDC → ugp-ci-deploy-role│
│ 2. OIDC → Bedrock role  │                    │ 2. aws ecs run-task Fargate  │
│ 3. pip install crew     │                    │    (fire-and-forget)         │
│ 4. ugp-selfheal         │                    │                             │
└─────────────────────────┘                    └─────────────────────────────┘
        │                                                          │
        │                                                          │ (async)
        ▼                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     ugp-selfheal (Python crew)                              │
│                                                                             │
│  1. DynamoDB circuit breaker — already attempted MAX_ATTEMPTS times? → escalate │
│  2. Download CI log of the failed run (GitHub API)                          │
│  3. log-analyst (Bedrock) → diagnose the root cause                        │
│  4. fix-engineer (Bedrock) → generate correction diff                      │
│  5. reviewer (Bedrock) → validate the patch                                │
│  6. If APPLY: create fix/* branch and open PR                              │
│  7. If REJECT or circuit breaker: escalate to human                        │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────┐
│  PR on fix/* branch     │  ← Requires human review and approval
│  (NEVER push to main)   │    to merge to main
└─────────────────────────┘
```

---

## The two runners: comparison for the talk

### Active runner selection (`SELF_HEAL_MODE`)

The repository variable `vars.SELF_HEAL_MODE` acts as the **demo switch**:
it determines which of the two self-healing runners is activated when
`sample-service-ci` fails.

| Value | Active runner | Workflow triggered |
|---|---|---|
| `gha` | Runner 1 — inside Actions | `self-heal-gha.yml` |
| `fargate` | Runner 2 — isolated in Fargate | `self-heal-dispatch.yml` |

Both workflows have the condition `vars.SELF_HEAL_MODE == '<mode>'`, so
**they are never triggered at the same time**: no collision in the DynamoDB
circuit breaker and no 2 PRs created for the same failure.

> **For the talk:** change the value of `SELF_HEAL_MODE` between `gha` and
> `fargate` to compare the two runners live without modifying any code.

### Runner 1 — `self-heal-gha.yml` (simple / coupled)

The crew is installed and executed **inside the same GitHub Actions runner**.

**Advantages:**
- No additional infrastructure (does not need Fargate running).
- Minimal setup: `pip install ./self-healing-crew` + `ugp-selfheal`.
- Crew logs visible directly in the GitHub Actions UI.

**Disadvantages:**
- The healer runs in the **same ecosystem that may be failing** — if the
  Actions runner has an environment problem, the healer also fails.
- Requires AWS credentials (Bedrock + DynamoDB) in the runner via OIDC.
- LLM execution time counts against the 6h per-job limit.
- Does not scale well when there are many simultaneous failures.

### Runner 2 — `self-heal-dispatch.yml` (isolated / fault-tolerant)

The workflow only dispatches a Fargate task. The crew runs **outside the
failed system**, in a completely isolated container.

**Advantages:**
- **Full isolation**: if the Actions runner fails, the crew on Fargate is
  unaffected.
- The Actions workflow is minimal (only `ecs run-task`): finishes in seconds.
- The Fargate task role is not exposed to the Actions runner.
- Scales easily (ECS can run multiple tasks in parallel).

**Disadvantages:**
- Requires the `SelfHealingStack` CDK deployed and running.
- Fargate container cold start (~30-60s additional latency).
- Logs in CloudWatch, not directly in the GitHub Actions UI.

### When to use which?

| Criterion | Runner 1 (Actions) | Runner 2 (Fargate) |
|---|---|---|
| Quick demo / PoC | ✅ Ideal | Requires infra |
| Production | ⚠️ Viable with limits | ✅ Recommended |
| CI runner failure | ❌ Affects the healer | ✅ Isolated |
| Log visibility | ✅ Actions UI | ⚠️ CloudWatch |
| Extra infrastructure | Minimal (only AWS role) | SelfHealingStack CDK |

---

## Variables and secrets to configure

Values marked with `(CDK output)` are obtained from the **outputs of
`SelfHealingStack`** after running `cdk deploy SelfHealingStack`.

```bash
# View CDK outputs:
aws cloudformation describe-stacks \
  --stack-name SelfHealingStack \
  --query 'Stacks[0].Outputs' \
  --region us-east-1
```

### Repository variables (`vars.*`)

Configure at: _Settings → Secrets and variables → Actions → Variables_

| Variable | Description | Source |
|---|---|---|
| `CI_DEPLOY_ROLE_ARN` | OIDC role ARN for RunTask | CDK output: `CiDeployRoleArn` |
| `CREW_CLUSTER_NAME` | ECS cluster name for the crew | CDK output: `CrewClusterName` |
| `CREW_TASK_DEF_ARN` | Crew task definition ARN | CDK output: `CrewTaskDefinitionArn` |
| `CREW_SUBNET_IDS` | Subnets for the task (comma-separated list) | CDK output: `CrewSubnetIds` |
| `CREW_SECURITY_GROUP_ID` | Task security group | CDK output: `CrewSecurityGroupId` |
| `BEDROCK_CI_ROLE_ARN` | OIDC role ARN for Bedrock (Runner 1) | Manual IAM |
| `DDB_TABLE_NAME` | DynamoDB circuit breaker table name | CDK output: `CircuitBreakerTableName` |
| `BEDROCK_MODEL_ID` | Bedrock model ID | e.g. `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `MAX_ATTEMPTS` | Maximum attempts per run_key before escalating | Default: `2` |

### Repository secrets (`secrets.*`)

Configure at: _Settings → Secrets and variables → Actions → Secrets_

> ⚠️ `GITHUB_TOKEN` is automatic (provided by GitHub Actions). Additional
> secrets are only needed if using a GitHub App instead of GITHUB_TOKEN.

| Secret | Description | Used in |
|---|---|---|
| _(automatic)_ `GITHUB_TOKEN` | Workflow token for GitHub API | Runner 1 |
| `GITHUB_APP_ID` | GitHub App ID (if using App instead of GITHUB_TOKEN) | Fargate (task env, via Secrets Manager) |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (RS256) | Fargate (task env, via Secrets Manager) |

---

## Security debts

### B3-sec — Branch protection on `main` (PENDING)

> ⚠️ **The "never push directly to main" guardrail is enforcement-only**
> (implemented in the crew) until branch protection is configured.

To enable real protection, configure in GitHub:
_Settings → Branches → Branch protection rules → main_

Recommended rules:
- ✅ Require a pull request before merging
- ✅ Require approvals (minimum 1)
- ✅ Dismiss stale pull request approvals when new commits are pushed
- ✅ Require status checks to pass before merging (`sample-service-ci / Build and Test`)
- ✅ Require branches to be up to date before merging
- ✅ Do not allow bypassing the above settings

### M1-sec — Arbitrary overrides in ECS RunTask (block 2 debt)

The `ugp-ci-deploy-role` allows passing arbitrary `--overrides` in
`ecs:RunTask`. In production, move this step to a **Lambda or EventBridge rule**
with fixed overrides to avoid exposing the task role to command injection.
See `TODO M1-sec` comment in `self-heal-dispatch.yml`.

---

## Conventions

- **Actions pinned to stable major version**: `@v4` (not `@latest`).
- **Minimum permissions per workflow**: only strictly necessary ones.
- **No hardcoded secrets**: everything via `vars.*` or `secrets.*`.
- **No direct push to main**: the crew always opens a PR on `fix/*`.
- **Concurrency**: `sample-service-ci` cancels previous runs for the same branch.
