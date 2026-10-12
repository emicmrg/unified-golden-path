# The Unified Golden Path

Demonstration project for the **Platform Engineering** talk: _"AI, IoT & Cloud: Building a Recovery Path from Edge to Cloud"_.

It shows how an internal platform can provide a unified golden path from embedded edge
firmware (ESP32 via ESP-IDF) to cloud infrastructure (AWS CDK v2), through serverless
services, a web dashboard, and an AI-based self-healing agent.

---

## Folder structure

```
unified-golden-path/
├── edge-firmware/          ESP32 firmware (ESP-IDF, C/C++)
│   ├── main/               Entry point + EnvironmentSource abstraction
│   └── partitions.csv      A/B partition table for OTA
├── infra/                  AWS infrastructure as code (CDK v2, TypeScript)
│   └── src/
│       ├── app.ts          CDK entry point
│       ├── constructs/     EdgeDevice (IoT registry) + FirmwareOtaPipeline
│       └── stacks/         UgpIotStack (edge platform)
├── self-healing-crew/      AI-based self-healing agent (Python / LangGraph)
├── sample-service/         Sample serverless service (Node.js / TypeScript)
├── web-dashboard/          Web dashboard (React / TypeScript)
├── docs/
│   ├── DEPLOYMENT.md       End-to-end deployment runbook (bootstrap → stacks → GitHub → teardown)
│   └── DEMO.md             Live Fargate self-healing demo runbook
├── .github/
│   └── workflows/          CI/CD with GitHub Actions
└── .kiro/                  Kiro agent harness (orchestrator + subagents)
```

---

## Requirements

| Tool        | Minimum version |
|-------------|-----------------|
| Node.js     | 20.9.x          |
| pnpm        | 9.x             |
| AWS CDK     | 2.x             |
| ESP-IDF     | 5.3.x           |
| Python      | 3.11+           |

---

## Quick start (monorepo)

```bash
# Install workspace dependencies
pnpm install

# Compile infra/ TypeScript
pnpm build

# Run the tests (infra/ CDK assertions)
pnpm test

# Synthesize CDK infrastructure. Two stacks are fail-closed:
#   - SelfHealingStack on the GitHub OIDC trust policy -> pass the real org/repo.
#   - DashboardStack on the CORS origin of its public Function URL -> pass the Amplify domain
#     (AmplifyDefaultDomain output; on the FIRST deploy it does not exist yet, see
#     infra/README.md "Two-phase deploy").
pnpm synth \
  -c ugp:githubOrg=<org> -c ugp:githubRepo=<repo> \
  -c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com

# Local synth without a repository: opt into the placeholders explicitly (never deploy that
# template). The CORS origin stays scoped: that one has no placeholder.
pnpm synth -c ugp:allowPlaceholderRepo=true \
  -c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com

# Show the CDK diff against the deployed stack (same context requirements)
pnpm diff -c ugp:allowPlaceholderRepo=true \
  -c ugp:dashboardAllowedOrigins=https://main.<appId>.amplifyapp.com
```

## Deployment

The end-to-end runbook for deploying to AWS lives in
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**: prerequisites, `cdk bootstrap`, the per-stack
context required by the fail-closed guards, the deploy order
(`UgpIotStack` → `SelfHealingStack` → push the crew image → `DashboardStack` two-phase →
Amplify web deploy → firmware flash), the GitHub repository variables mapped to CDK outputs, and the **required** branch protection on `main`, teardown, and the security debt still open. The self-healing OIDC trust subjects use the repository's versioned immutable GitHub owner/repository IDs; see `docs/DEPLOYMENT.md` for the deployed subject and guard details.

---

## Edge firmware

See [edge-firmware/README.md](edge-firmware/README.md) for instructions on building
and flashing the ESP32 firmware.

---

## Status

| Block | Description                              | Status            |
|--------|------------------------------------------|-------------------|
| 1     | Monorepo scaffold + base CDK + firmware  | ✅ Complete        |
| 2     | CDK stacks (IoT Core, self-healing runner, dashboard backend) | ✅ Complete — all 3 stacks deployed and healthy in the sandbox account (see `docs/DEPLOYMENT.md`) |
| 3     | edge-firmware + OTA                      | 🔄 WiFi + MQTT (mutual TLS) validated end-to-end on hardware; real DHT11 driver and OTA Jobs subscription still pending |
| 4     | sample-service + web-dashboard           | ✅ Complete — tested; includes the merged MDX presentation deck with 3 interactive diagrams (A: AWS architecture, B: CrewAI agents, C: Fargate self-healing flow), with Deck mode as the default and the original tab dashboard at `?mode=dashboard`; the injectable self-healing demo bug is documented in `sample-service/BUG.md` |
| 5     | self-healing-crew (AI agent)             | ✅ Complete — Fargate mode exercised end-to-end successfully: failed CI → `workflow_run` → `self-heal-dispatch` Fargate guard → OIDC assume of `ugp-ci-deploy-role` → fire-and-forget `ecs run-task` → Bedrock Claude Sonnet 4.5 RCA → DynamoDB circuit breaker → GitHub App token from Secrets Manager → automatic `fix/*` PR |
| 6     | CI/CD GitHub Actions                     | ✅ Complete — all 3 workflows implemented; `main` branch protection is active with required `Build and Test (@ugp/sample-service)` and `Build and Test (@ugp/web-dashboard)` checks, `enforce_admins`, and `dismiss_stale_reviews` |


## License

This project is licensed under the [MIT License](LICENSE).
