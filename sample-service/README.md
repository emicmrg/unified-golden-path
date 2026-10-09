# sample-service — Clinical Cold Chain Monitoring

Package `@ugp/sample-service` of the **unified-golden-path** monorepo.

Implements the domain logic for **clinical cold chain monitoring**
(safe range: 2–8 °C, 30–60 %RH), with a full test suite and an
**injectable bug** documented for the `self-healing-crew` demo.

---

## What does it do?

- `validateTemperature(celsius)` — validates that a temperature is within the safe clinical range [2, 8] °C.
- `validateHumidity(pct)` — validates that a relative humidity is within [30, 60] %RH.
- `classifyReading(reading)` — classifies a reading as `OK` / `WARN` / `ALARM`.
- `evaluateBatch(readings[])` — aggregates a batch: OK/WARN/ALARM counts and worst status.
- `handler(event)` — Lambda-style handler that receives `{ readings: [] }` and returns the evaluation.

---

## Structure

```
sample-service/
├── src/
│   ├── coldChain.ts          Domain logic (pure functions, types)
│   ├── index.ts              Entry point + Lambda-compatible handler
│   └── __tests__/
│       └── coldChain.test.ts Test suite (vitest)
├── BUG.md                    Injectable bugs for the self-healing demo
├── package.json
└── tsconfig.json
```

---

## Requirements

| Tool        | Version |
|-------------|---------|
| Node.js     | ≥ 20.9  |
| pnpm        | ≥ 9.0   |
| TypeScript  | 5.7.3   |
| vitest      | 2.1.8   |

---

## How to run the tests

```bash
# From the monorepo root:
pnpm --dir sample-service install
pnpm --dir sample-service run build
pnpm --dir sample-service run test
```

Tests must finish **green** (codebase without bugs).

---

## Injectable bug — Self-healing demo

The [`BUG.md`](./BUG.md) file documents two reproducible bugs with exact diffs.

### Bug A (recommended for the demo)

Change **one line** in `src/coldChain.ts` (operator `>=` → `>`):

```diff
-  return celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C;
+  return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;
```

**Effect:** At least 2 tests fail with clear messages:
- `AssertionError: expected false to be true` (temperature 2.0 °C rejected)
- `AssertionError: expected 'WARN' to be 'OK'` (wrong classification at boundary)

This triggers the CI pipeline that activates the `self-healing-crew` to
diagnose and propose the fix on a `fix/*` branch.

### Revert

Restore `>=` and run the tests again → green.

See [`BUG.md`](./BUG.md) for the full diff and exact steps.

---

## Context within the project

```
edge-firmware (ESP32)
      ↓ MQTT / IoT Core
  infra/UgpIotStack
      ↓ events
  sample-service  ← this package (domain logic + CI target)
      ↓ bug injected → CI fails
  self-healing-crew  ← diagnoses + proposes fix
```

---

## Self-healing crew integration (Block 5)

`sample-service` is the primary CI target of the self-healing demo. The `.github/workflows/`
directory contains two relevant workflows:

| Workflow | Trigger | Purpose |
|---|---|---|
| `sample-service-ci.yml` | push / PR touching `sample-service/**` | Builds and tests this package; failure starts the self-healing chain |
| `self-heal-dispatch.yml` | `workflow_run` (on `sample-service-ci.yml` failure) | Dispatches the ECS Fargate self-healing crew task |

### How the automatic self-healing cycle works

1. A bug is injected into `src/coldChain.ts` (or any change that breaks tests).
2. The `sample-service-ci.yml` CI check fails.
3. `self-heal-dispatch.yml` fires automatically: it resolves the failed commit SHA, the
   broken branch, and the failing test output, then submits an ECS `RunTask` request to
   launch the `self-healing-crew` Fargate task.
4. The crew (LangGraph, GPT-4o) analyzes the CI logs, identifies the defective file and
   line, applies the patch via a `git` tool, and opens a `fix/*` PR targeting the broken branch.
5. A human reviews and merges the PR; CI turns green.

### Fail-closed guards (implemented as of this PR)

The crew now enforces the following safety invariants before applying any patch:

- **Path guard**: the FILE field extracted from the LLM output must resolve to a path
  inside the repository root (no path traversal, no absolute paths outside the repo).
- **Regex FILE extraction**: a dedicated regex parser handles multi-line prose in the FILE
  field, stripping markdown fences and trailing whitespace before passing the path to tools.
- **Context injection**: the failed branch name is passed as the PR base so fixes always
  target the branch where the bug lives, never `main`.
- **Monorepo path resolution**: file paths without a leading `sample-service/` prefix are
  automatically resolved against the known monorepo layout before the patch is applied.

---

## Related: edge firmware OTA support

The `edge-firmware` component now supports over-the-air updates via **AWS IoT Jobs**
(`esp_https_ota` + A/B partition rollback). When the self-healing crew patches and merges
a firmware fix, the OTA pipeline can push the new binary to the device without manual
reflashing. See [`edge-firmware/README.md`](../edge-firmware/README.md) and
[`edge-firmware/main/ota_jobs.c`](../edge-firmware/main/ota_jobs.c) for details.

---

## Related: web-dashboard as a presentation tool

The `web-dashboard` package doubles as a **MDX slide deck** for the Platform Engineering
talk. It includes an interactive bento-layout slide that embeds the live dashboard (real
Amplify-hosted data) directly inside the presentation, so the sample-service CI pipeline
and self-healing demo can be shown in context without switching windows. The slide engine
supports keyboard navigation (arrow keys, 1–9 shortcuts, dot-nav) and an accessible
focus-mode overlay for zooming into individual bento tiles.
