# The Unified Golden Path

Demonstration project for the **Platform Engineering** talk: _"The Unified Golden Path"_.

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

# Synthesize CDK infrastructure
pnpm synth

# Show the CDK diff against the deployed stack
pnpm diff
```

## Edge firmware

See [edge-firmware/README.md](edge-firmware/README.md) for instructions on building
and flashing the ESP32 firmware.

---

## Status

| Block | Description                              | Status            |
|--------|------------------------------------------|-------------------|
| 1     | Monorepo scaffold + base CDK + firmware  | ✅ Complete        |
| 2     | CDK stacks (IoT Core, Lambda, DynamoDB)  | 🔄 IoT Core + OTA ready; Lambda/DynamoDB missing |
| 3     | Complete edge-firmware + OTA             | ⏳ Pending         |
| 4     | sample-service + web-dashboard           | ⏳ Pending         |
| 5     | self-healing-crew (AI agent)             | ⏳ Pending         |
| 6     | CI/CD GitHub Actions                     | ⏳ Pending         |
