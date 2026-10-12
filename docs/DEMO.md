# Live Demo Runbook — Fargate Self-Healing

Live demo for **AI, IoT & Cloud: Building a Recovery Path from Edge to Cloud**. The demo uses the `fargate` runner: a failed `sample-service-ci` run triggers `self-heal-dispatch`, which launches the crew on ECS Fargate. The crew analyzes the failure with Bedrock, records the attempt in DynamoDB, and opens a draft `fix/*` PR with the RCA.

## Pre-flight

Run from the repository root. The deployed sandbox is account `363509146455`, region `us-east-1`, repository `emicmrg/unified-golden-path`.

```bash
export AWS_PROFILE=innovlabs-gdl
export AWS_REGION=us-east-1
export REPO=emicmrg/unified-golden-path

aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output table
# Account must be 363509146455
```

- **Runner switch:** in GitHub repository variables, confirm `SELF_HEAL_MODE=fargate` (not `gha`).

  ```bash
  gh variable list --repo "$REPO"
  ```

- **Deck:** open <https://main.d2nznld4keqy10.amplifyapp.com> (already deployed; `AmplifyDefaultDomain` output of `DashboardStack`).

  The deck is the default app mode. The original tab dashboard is available at `?mode=dashboard`.

  If the Amplify deployment was redeployed and the URL changed, obtain the current URL from the stack output:

  ```bash
  aws cloudformation describe-stacks \
    --stack-name DashboardStack \
    --query "Stacks[0].Outputs[?OutputKey=='AmplifyDefaultDomain'].OutputValue" \
    --output text
  ```

- **Circuit breaker:** `MAX_ATTEMPTS=2` is the configured limit. Do not replay an old failed run; use a new commit and push below so GitHub creates a fresh workflow run ID and therefore a fresh `run_key`.

  ```bash
  gh variable list --repo "$REPO" | grep -E 'MAX_ATTEMPTS|SELF_HEAL_MODE'
  ```

- **Crew image:** verify that the `latest` image is present and recent in ECR. ECS resolves `latest` when the task starts.

  ```bash
  aws ecr describe-images \
    --repository-name ugp-self-healing-crew \
    --query 'sort_by(imageDetails,&imagePushedAt)[-5:].[imageTags,imageDigest,imagePushedAt]' \
    --output table
  ```

- **Fargate wiring:** verify the deployed task and outputs before the talk.

  ```bash
  aws cloudformation describe-stacks \
    --stack-name SelfHealingStack \
    --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
    --output table
  aws ecs describe-task-definition \
    --task-definition ugp-self-healing-crew \
    --query 'taskDefinition.[family,revision,status]' \
    --output table
  ```

## Demo flow

### 1. Start with the deck

Open the deck at <https://main.d2nznld4keqy10.amplifyapp.com> and navigate to **Diagram C — Self-Healing Flow — GitHub ↔ AWS**. Set up the story: CI fails, GitHub Actions assumes `ugp-ci-deploy-role` through OIDC, and the workflow dispatches an isolated Fargate job. Mention that Diagram A is the AWS architecture and Diagram B is the CrewAI agent collaboration; return to Diagram C for the live sequence.

### 2. Inject Bug A and push it

Create a disposable branch and apply the exact Bug A change from [`sample-service/BUG.md`](../sample-service/BUG.md): change the lower-bound comparison from `>=` to `>` so the exact `2.0 °C` boundary fails.

```bash
DEMO_BRANCH="demo/live-self-healing-$(date +%Y%m%d-%H%M)"
git switch -c "$DEMO_BRANCH"

python3 - <<'PY'
from pathlib import Path

path = Path("sample-service/src/coldChain.ts")
text = path.read_text()
old = "return celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C;"
new = "return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;"
if text.count(old) != 1:
    raise SystemExit("Expected exactly one green Bug A line; aborting")
path.write_text(text.replace(old, new))
PY

git diff -- sample-service/src/coldChain.ts
git add sample-service/src/coldChain.ts
git commit -m "demo: inject temperature boundary bug"
git push -u origin "$DEMO_BRANCH"
```

Point out that this is the **only write** in the live failure setup. The normal codebase remains green on `main`.

### 3. Watch the CI failure

The push triggers `sample-service-ci` because the branch changes `sample-service/**`. The two boundary tests should fail: `2.0 °C` is reported as `false`/`WARN` instead of `true`/`OK`.

```bash
RUN_ID=$(gh run list --repo "$REPO" \
  --workflow sample-service-ci.yml \
  --branch "$DEMO_BRANCH" \
  --limit 1 --json databaseId --jq '.[0].databaseId')
echo "sample-service-ci run: $RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO"
gh run view "$RUN_ID" --repo "$REPO" --log-failed
```

On the deck, use Diagram C to narrate the red CI node and the `workflow_run` event. The failed run is expected; do not retry it, because the run ID is the circuit-breaker key.

### 4. Show the Fargate dispatch

After `sample-service-ci` completes, `self-heal-dispatch` runs from the default branch. Its guard requires the failed conclusion, `SELF_HEAL_MODE=fargate`, and the failure originating in this repository. It assumes `ugp-ci-deploy-role` with GitHub OIDC and executes `aws ecs run-task` with `--launch-type FARGATE`; the workflow does not wait for the crew.

```bash
gh run list --repo "$REPO" \
  --workflow self-heal-dispatch.yml \
  --limit 5
```

Select the new `self-heal-dispatch` run associated with the just-failed CI run, then inspect its log. The last step prints the ECS task ARN returned by `run-task`.

```bash
DISPATCH_RUN_ID=<self-heal-dispatch-run-id>
gh run view "$DISPATCH_RUN_ID" --repo "$REPO" --log
```

Copy the printed task ARN into `TASK_ARN` for the next step:

```bash
TASK_ARN=<task-arn-printed-by-ecs-run-task>
TASK_ID="${TASK_ARN##*/}"
echo "$TASK_ID"
```

Call out Diagram C steps: **OIDC → `ugp-ci-deploy-role` → ECS Fargate `run-task`**. The dispatch workflow is fire-and-forget by design; the crew is isolated from the failed Actions runner.

### 5. Follow the ECS task and CloudWatch logs

The task family and cluster are fixed by `SelfHealingStack`. The task runs with the `crew` container and writes to `/aws/ecs/ugp-self-healing-crew` with the `crew/crew/<task-id>` stream prefix.

```bash
aws ecs describe-tasks \
  --cluster ugp-self-healing \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].[lastStatus,desiredStatus,stoppedReason,containers[0].exitCode]' \
  --output table

# Wait for this short-lived job to finish, if it is still RUNNING.
aws ecs wait tasks-stopped \
  --cluster ugp-self-healing \
  --tasks "$TASK_ARN"

aws ecs describe-tasks \
  --cluster ugp-self-healing \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].[lastStatus,stoppedReason,containers[0].exitCode]' \
  --output table

aws logs tail /aws/ecs/ugp-self-healing-crew --since 15m
```

For a precise stream, use:

```bash
aws logs describe-log-streams \
  --log-group-name /aws/ecs/ugp-self-healing-crew \
  --log-stream-name-prefix "crew/crew/$TASK_ID" \
  --query 'logStreams[].logStreamName' --output table

aws logs get-log-events \
  --log-group-name /aws/ecs/ugp-self-healing-crew \
  --log-stream-name "crew/crew/$TASK_ID" \
  --start-from-head \
  --query 'events[].message' --output text
```

While logs arrive, point to Diagram C: the crew obtains the GitHub App installation token from the Secrets Manager PEM, uses Bedrock Claude Sonnet 4.5 for the RCA/fix/review sequence, and reads/writes the DynamoDB circuit breaker. Do not expose token or PEM values on screen.

### 6. Show the generated PR and RCA

The crew creates a **draft** PR from `fix/selfheal-<hash>-attempt<N>` to the failed demo branch. Its body includes the run key, structured RCA diagnosis, and the display diff computed from the actual file contents.

```bash
PR_NUMBER=$(gh pr list --repo "$REPO" --state open --limit 20 \
  --json number,headRefName,baseRefName,createdAt \
  --jq '[.[] | select(.headRefName | startswith("fix/"))] | sort_by(.createdAt) | last | .number')
echo "Generated PR: #$PR_NUMBER"

gh pr view "$PR_NUMBER" --repo "$REPO" \
  --json url,title,isDraft,headRefName,baseRefName,body \
  --jq '{url,title,isDraft,head: .headRefName,base: .baseRefName,body}'
gh pr diff "$PR_NUMBER" --repo "$REPO"
```

Open the PR in the browser and show the RCA, the two failing boundary assertions, the `>=` correction, and the draft/human-review guardrail. The generated branch always starts with `fix/`; the crew never commits directly to `main`.

**Known presentation detail:** the full-file patch can leave the file without a final newline, so the display may show two hunks or a `\\ No newline at end of file` marker. Frame that as a formatting artifact of the generated patch; the meaningful repair is restoring `>=` for the inclusive lower boundary.

### 7. Optional: close the loop with PR CI

The fix PR can run the required checks. Show the checks turning green after the repair:

```bash
gh pr checks "$PR_NUMBER" --repo "$REPO"
```

The active required checks on `main` are `Build and Test (@ugp/sample-service)` and `Build and Test (@ugp/web-dashboard)`. Merging requires a PR and passing required checks (enforced for admins too); required approvals are currently 0, so merges are not gated on a human approval. Branch protection also uses strict status checks, dismisses stale reviews, and blocks force-pushes and branch deletion.

> **Documentation debt:** comments in `.github/workflows/self-heal-dispatch.yml` still describe the classic OIDC subject format, while the deployed stack uses immutable GitHub owner/repository IDs.

## Timing

The rehearsed push-to-PR cycle took approximately **2 minutes 20 seconds**. While it runs, narrate the isolation boundary, the OIDC role handoff, the circuit breaker, and the three CrewAI roles rather than waiting silently.

## Contingency / Plan B

- If Bedrock or the Fargate task is slow or fails, show the previous rehearsal **PR #11** (or a prepared screenshot) and explain that it is the same RCA-to-PR path.
- If the logs report the circuit breaker at `attempts 2/2`, do not retry that failed run. Push a new commit so GitHub creates a new workflow run ID and a fresh `run_key`.
- If OIDC, GitHub, or AWS calls fail unexpectedly, refresh the temporary AWS credentials and re-run the pre-flight identity check. Do not print credentials or secret values.
- If the dispatch workflow is absent, skipped, or not using Fargate, stop the live injection and use the PR/screenshot fallback rather than switching runners during the demo.

## Cleanup

Close the generated draft PR, delete its `fix/*` branch, then delete the disposable demo branch. Run only after the presentation:

```bash
gh pr close "$PR_NUMBER" --repo "$REPO" --delete-branch

git switch main
git push origin --delete "$DEMO_BRANCH"
git branch -D "$DEMO_BRANCH"
```

Do not merge the generated PR during the demo. The deployed AWS resources and repository variables are managed separately by [`DEPLOYMENT.md`](DEPLOYMENT.md).
