/**
 * hooks-unconfigured.test.tsx — Graceful degradation tests when VITE_* variables are not configured.
 * Each test file has its own config mock to avoid interfering with other tests.
 * Does NOT call real AWS.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// ---- Mock config WITHOUT any variables configured ----
vi.mock("../config.js", () => ({
  config: {
    mqttConfigured: false,
    statusApiConfigured: false,
    awsRegion: "us-east-1",
    identityPoolId: undefined,
    iotEndpoint: undefined,
    telemetryTopic: undefined,
    statusApiUrl: undefined,
    mqttClientIdPrefix: "ugp-dashboard-",
  },
}));

// Also mock aws-amplify and pubsub just in case
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/pubsub", () => ({
  PubSub: vi.fn().mockImplementation(() => ({ subscribe: vi.fn() })),
}));

// Import AFTER the mocks
const { useStatus } = await import("../hooks/useStatus.js");
const { useTelemetry } = await import("../hooks/useTelemetry.js");

describe("Graceful degradation — no configuration", () => {
  it("useStatus returns error mentioning VITE_STATUS_API_URL when not configured", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const { result } = renderHook(() => useStatus());

    await waitFor(
      () => {
        expect(result.current.error).not.toBeNull();
      },
      { timeout: 2000 }
    );

    expect(result.current.error).toContain("VITE_STATUS_API_URL");
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    // fetch must NOT have been called
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("useTelemetry returns a missing-config warning without crashing when not configured", async () => {
    const { result } = renderHook(() => useTelemetry());

    await waitFor(
      () => {
        expect(result.current.error).not.toBeNull();
      },
      { timeout: 2000 }
    );

    expect(result.current.error).toContain("VITE_IDENTITY_POOL_ID");
    expect(result.current.connectionStatus).toBe("disconnected");
    expect(result.current.latest).toBeNull();
  });
});
