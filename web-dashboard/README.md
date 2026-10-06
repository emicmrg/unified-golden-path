# web-dashboard — The Unified Golden Path Dashboard

Read-only **SPA** (React + Vite + TypeScript) for the Platform Engineering demo.

## Views

| View | Description |
|------|-------------|
| 🌡️ **Fleet Health** | Live IoT gateway telemetry (temp + humidity) via MQTT/Amplify PubSub. Green/Yellow/Red based on ranges [2–8°C] / [30–60%RH]. In-memory mini-sparkline. |
| 🏆 **Golden Path** | Status of the last CI pipeline run and the last IoT Job. Honest: shows 'unknown' if no data is available (never fakes 'passing'). |
| 🤖 **Self-Healing** | Auto-repair crew timeline (log-analyst → fix-engineer → reviewer), generated PR, and circuit breaker per runKey. |

## Data sources

- **MQTT Telemetry**: `@aws-amplify/pubsub` with Cognito Identity Pool guest (no login).  
  Config: `VITE_IDENTITY_POOL_ID`, `VITE_IOT_ENDPOINT`, `VITE_TELEMETRY_TOPIC`.

- **System status**: GET polling every ~5s to a read-only Lambda Function URL.  
  Config: `VITE_STATUS_API_URL`.  
  Response shape: see `src/types.ts` → `StatusResponse`.

## Configuration

```bash
cp .env.example .env.local
# Edit .env.local with the CDK outputs (DashboardStack)
```

Required variables:

| Variable | Description |
|----------|-------------|
| `VITE_IDENTITY_POOL_ID` | Cognito Identity Pool ID for guest credentials |
| `VITE_AWS_REGION` | AWS Region (default: `us-east-1`) |
| `VITE_IOT_ENDPOINT` | IoT Core ATS endpoint (without protocol) |
| `VITE_TELEMETRY_TOPIC` | Gateway MQTT topic (e.g. `ugp/telemetry/ugp-gateway-01`) |
| `VITE_STATUS_API_URL` | Lambda Function URL |

If variables are missing the app **does not crash**: it shows a "not configured" notice in the corresponding view.

## Commands

```bash
# Install dependencies
pnpm --dir web-dashboard install

# Production build (run-once, no watch mode)
pnpm --dir web-dashboard run build

# Typecheck
pnpm --dir web-dashboard run typecheck

# Tests (run-once)
pnpm --dir web-dashboard run test

# Preview the build (optional, do not use in CI)
pnpm --dir web-dashboard run preview
```

## Architecture

```
src/
├── main.tsx          React entry point
├── App.tsx           Shell with tab navigation
├── types.ts          Data contract (StatusResponse, TelemetryMessage, ...)
├── config.ts         import.meta.env reading with validation
├── classify.ts       OK/WARN/ALARM classification logic (consistent with sample-service)
├── styles.css        Styles (dark theme, status colors)
├── test-setup.ts     Vitest setup
├── hooks/
│   ├── useTelemetry.ts  PubSub subscribe/unsubscribe with cleanup
│   └── useStatus.ts     Polling with AbortController and cleanup
└── components/
    ├── FleetHealth.tsx  View 1: live telemetry
    ├── GoldenPath.tsx   View 2: pipeline status
    └── SelfHealing.tsx  View 3: crew + circuit breaker
```

## Security

- No hardcoded credentials. Everything via `import.meta.env` (build-time variables).
- `.env.local` is in `.gitignore`.
- `VITE_IDENTITY_POOL_ID` is for guest access with minimal permissions (IoT subscribe only).
- Tests mock PubSub and fetch; they never call AWS.

## Key dependencies

| Package | Version | Usage |
|---------|---------|-------|
| react / react-dom | 18.3.1 | UI framework |
| aws-amplify | 6.9.0 | Amplify v6 (Cognito + PubSub) |
| vite | 5.4.14 | Bundler |
| vitest | 2.1.8 | Test runner |
| @testing-library/react | 16.0.0 | Component tests |
