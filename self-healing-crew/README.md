# Self-Healing Crew

CI/CD self-healing agent for the **Unified Golden Path** project.

Detects GitHub Actions failures, analyzes the root cause, generates a patch,
and opens a Pull Request automatically — all without human intervention and with
guardrails that make it impossible to compromise protected branches.

---

## What does it do?

When a CI/CD pipeline fails, this crew:

1. **Analyzes** the failed execution log to identify the root cause.
2. **Generates** a minimal patch that resolves the problem.
3. **Reviews** the patch before applying it (the _reviewer_ agent decides APPLY/REJECT).
4. **Applies** the patch by creating a `fix/*` branch and opening a draft Pull Request.

If the reviewer rejects the patch, or if the maximum number of attempts is exceeded,
the crew **escalates to human** without retrying.

---

## The 3 crew roles

| Role | Name | Responsibility |
|------|------|----------------|
| 🔍 Analyst | `log-analyst` | Reads the CI log and produces a structured diagnosis: error type, file/line, root cause. |
| 🔧 Engineer | `fix-engineer` | Generates a minimal unified diff based on the analyst's diagnosis. |
| ✅ Reviewer | `reviewer` | Validates the patch against quality and security criteria. Emits `VERDICT: APPLY` or `VERDICT: REJECT`. |

All 3 agents use **Amazon Bedrock** (Claude Sonnet via cross-region inference profile)
with low temperature (0.1) for deterministic results.

---

## Critical guardrails

### 🚫 Never push to main/master

This restriction is **impossible to bypass by design**:

- `_validate_branch_name()` validates that the target branch starts with `fix/`
  and raises `MainBranchProtectionError` if it detects `main`, `master`, or any
  protected component in the path.
- Validation runs **before** any GitHub API call.
- If validation fails, the crew stops completely with an error code.

The crew can only write to `fix/selfheal-<hash>` branches and open draft PRs.

### 🔑 GitHub authentication modes

| Mode | Key variable | When used |
|------|-------------|-----------|
| **Fargate / GitHub App** (DEFAULT) | `GITHUB_APP_ID` + `GITHUB_INSTALLATION_ID` + `GITHUB_TOKEN_SECRET_ARN` | Deployment on ECS Fargate. The PEM private key lives in Secrets Manager; the crew obtains a JWT RS256 installation token (~1 h). This is the secure default mode. |
| **Runner 1 / GitHub Actions** | `UGP_ALLOW_ENV_TOKEN=true` + `GITHUB_TOKEN` | Execution inside a GitHub Actions workflow (`self-heal-gha.yml`). Uses the native ephemeral token of the workflow (already scoped with `contents:write` + `pull-requests:write`). |

> **Golden security rule**: `UGP_ALLOW_ENV_TOKEN` must never be in the
> Fargate Task Definition. Its absence (default `false`) guarantees that the
> GitHub App flow stays active in production.

### ⚡ Circuit Breaker (DynamoDB)

Maximum **2 automatic attempts** per failure (configurable with `MAX_ATTEMPTS`):

- The counter is persisted in DynamoDB with **atomic increment**
  (`UpdateItem` with `ConditionExpression`) → no race condition.
- If 2 attempts are reached: the crew marks the failure as escalated and
  **does not trigger again** for that run/commit.
- The escalation record persists in DynamoDB (`escalated = true`).

### 🔑 Ephemeral GitHub token

- The token is a **GitHub App installation token** with a maximum lifetime of 1 hour.
- It is read at runtime from **AWS Secrets Manager** (never hardcoded).
- The token value is **never printed in logs** (not even in debug mode).
- Required scopes: `contents:write`, `pull_requests:write`.

---

## Execution

### Local (development)

```bash
# 1. Create virtual environment
python -m venv .venv
source .venv/bin/activate

# 2. Install dependencies (includes dev extras)
pip install -e ".[dev]"

# 3. Configure minimum environment variables
export AWS_REGION=us-east-1
export DDB_TABLE_NAME=ugp-selfheal-circuit-breaker
export GITHUB_APP_ID=123456
export GITHUB_INSTALLATION_ID=78901234
export GITHUB_REPO=my-org/my-repo
export GITHUB_TOKEN_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret/ugp/github-token
export MAX_ATTEMPTS=2

# 4a. With log from file
ugp-selfheal --run-id 9876543210 --run-key "9876543210-abc1234" \
             --log-text "$(cat /tmp/ci-failure.log)"

# 4b. With log from GitHub API (requires real permissions)
ugp-selfheal --run-id 9876543210 --run-key "9876543210-abc1234"
```

For local testing without Secrets Manager, you can export the token directly
(development only, **never in production**):

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

### In Fargate (production)

Environment variables are injected into the ECS **Task Definition**.
AWS credentials come from the **Task IAM role** (no hardcoded keys).

```bash
# The image is built and pushed to ECR via CI/CD
docker build -t ugp-self-healing-crew .

# Equivalent execution to what Fargate does (for image testing)
docker run --rm \
  -e AWS_REGION=us-east-1 \
  -e DDB_TABLE_NAME=ugp-selfheal-circuit-breaker \
  -e GITHUB_APP_ID=123456 \
  -e GITHUB_INSTALLATION_ID=78901234 \
  -e GITHUB_REPO=my-org/my-repo \
  -e GITHUB_TOKEN_SECRET_ARN=arn:aws:secretsmanager:... \
  -e UGP_RUN_ID=9876543210 \
  -e UGP_RUN_KEY=9876543210-abc1234 \
  -e GITHUB_TOKEN=ghp_xxx \  # local image testing only
  ugp-self-healing-crew
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_REGION` | No | `us-east-1` | AWS region for DynamoDB, Secrets Manager, and Bedrock. |
| `BEDROCK_MODEL_ID` | No | `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock model via LiteLLM. |
| `DDB_TABLE_NAME` | **Yes** | — | DynamoDB table for the circuit breaker. |
| `GITHUB_APP_ID` | **Yes** | — | Numeric ID of the GitHub App. |
| `GITHUB_INSTALLATION_ID` | **Yes** | — | GitHub App installation ID. |
| `GITHUB_REPO` | **Yes** | — | Target repository (`org/repo`). |
| `GITHUB_TOKEN_SECRET_ARN` | **Yes** | — | ARN of the secret containing the GitHub App installation token. |
| `MAX_ATTEMPTS` | No | `2` | Maximum automatic attempts before escalating. |
| `LLM_TEMPERATURE` | No | `0.1` | LLM temperature (0.0–1.0). |
| `UGP_RUN_ID` | **Yes** | — | Failed GitHub Actions run ID. |
| `UGP_RUN_KEY` | No | same as `UGP_RUN_ID` | Circuit breaker key (PK in DynamoDB). |
| `UGP_LOG_TEXT` | No | — | Log text in stub mode (useful for tests). |
| `UGP_BASE_BRANCH` | No | `main` | PR base branch. |
| `GITHUB_TOKEN` | No | — | Local token for development (do not use in production). |

---

## Tests

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests (run-once, no watch)
pytest -q

# With coverage
pytest -q --cov=crew --cov-report=term-missing
```

Tests use **moto** to simulate DynamoDB without a real AWS connection.
No calls are made to Bedrock or GitHub in the tests.

---

## Code structure

```
self-healing-crew/
├── pyproject.toml          Fixed dependencies + ugp-selfheal entry point
├── Dockerfile              Fargate image (python:3.11-slim, non-root user)
├── .dockerignore
├── README.md               This file
├── crew/
│   ├── __init__.py
│   ├── config.py           Configuration from ENV (Pydantic Settings)
│   ├── agents.py           3 CrewAI agents (log-analyst, fix-engineer, reviewer)
│   ├── tasks.py            3 chained tasks + parse_verdict + extract_diff
│   ├── tools.py            fetch_ci_log, create_branch_and_commit, open_pull_request
│   ├── circuit_breaker.py  Atomic CircuitBreaker over DynamoDB
│   └── main.py             Orchestrator + ugp-selfheal entry point
└── tests/
    ├── test_circuit_breaker.py   Tests with moto (simulated DynamoDB)
    └── test_anti_main.py         Anti-main guardrail and parse_verdict tests
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success: patch applied and PR opened. |
| `1` | Error: failure in some step (see logs). |
| `2` | Escalated: circuit breaker exhausted, human team notified. |
