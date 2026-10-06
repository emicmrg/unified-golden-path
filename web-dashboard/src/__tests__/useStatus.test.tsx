/**
 * useStatus.test.tsx — Tests for the useStatus hook with fetch mocked.
 * Does NOT call real AWS; uses vi.stubGlobal to mock fetch.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { StatusResponse } from "../types.js";

// ---- Mock the config module BEFORE importing the hook ----
vi.mock("../config.js", () => ({
  config: {
    statusApiConfigured: true,
    statusApiUrl: "https://mock-function-url.lambda-url.us-east-1.on.aws/",
    mqttConfigured: false,
    awsRegion: "us-east-1",
    identityPoolId: undefined,
    iotEndpoint: undefined,
    telemetryTopic: undefined,
    mqttClientIdPrefix: "ugp-dashboard-",
  },
}));

// Import the hook AFTER the mock
const { useStatus } = await import("../hooks/useStatus.js");

/** Canonical shape as emitted by the handler (M2) */
const MOCK_STATUS: StatusResponse = {
  pipeline: {
    status: "passing",
    lastRun: { id: "42", conclusion: "success", url: "https://github.com/actions/runs/42" },
  },
  circuitBreaker: [
    { runKey: "run-001", attempts: 2, maxAttempts: 3, escalated: false },
  ],
  crew: {
    timeline: [
      {
        ts: "2026-10-06T14:00:00.000Z",
        runKey: "run-001",
        event: "first-attempt",
      },
      {
        ts: "2026-10-06T14:05:00.000Z",
        runKey: "run-001",
        event: "attempt-recorded",
        detail: "2/3",
      },
    ],
    pr: { url: "https://github.com/pr/5", branch: "fix/auto-repair-001" },
  },
  generatedAt: "2026-10-06T14:10:00.000Z",
  degraded: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useStatus", () => {
  it("starts with loading=true, data=null", () => {
    // Fetch that never resolves — captures the initial state
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    const { result } = renderHook(() => useStatus());
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("updates data with the API response when fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_STATUS),
      })
    );

    const { result } = renderHook(() => useStatus());

    await waitFor(
      () => {
        expect(result.current.loading).toBe(false);
        expect(result.current.data).not.toBeNull();
      },
      { timeout: 3000 }
    );

    expect(result.current.data?.pipeline.status).toBe("passing");
    expect(result.current.data?.circuitBreaker).toHaveLength(1);
    expect(result.current.data?.crew.pr?.branch).toBe("fix/auto-repair-001");
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).not.toBeNull();
  });

  it("exposes crew.timeline with the real handler shape (ts, runKey, event)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_STATUS),
      })
    );

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.data).not.toBeNull(), { timeout: 3000 });

    const timeline = result.current.data?.crew.timeline ?? [];
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      ts: "2026-10-06T14:00:00.000Z",
      runKey: "run-001",
      event: "first-attempt",
    });
    expect(timeline[1]).toMatchObject({
      event: "attempt-recorded",
      detail: "2/3",
    });
  });

  it("propagates degraded when it is not null (M3)", async () => {
    const degradedStatus: StatusResponse = {
      ...MOCK_STATUS,
      degraded: "SelfHealingStack no desplegada: la tabla del circuit breaker no existe",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(degradedStatus),
      })
    );

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.data).not.toBeNull(), { timeout: 3000 });

    expect(result.current.data?.degraded).toBe(
      "SelfHealingStack no desplegada: la tabla del circuit breaker no existe"
    );
  });

  it("rejects response with crew=null (#7)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            pipeline: { status: "unknown" },
            circuitBreaker: [],
            crew: null, // invalid
          }),
      })
    );

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 3000 });
    expect(result.current.error).toContain("expected format");
  });

  it("rejects circuitBreaker item without maxAttempts (#7 — avoids NaN% in progress bar)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            pipeline: { status: "unknown" },
            circuitBreaker: [
              { runKey: "run-x", attempts: 1, escalated: false }, // missing maxAttempts
            ],
            crew: { timeline: [], pr: null },
          }),
      })
    );

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 3000 });
    expect(result.current.error).toContain("expected format");
  });

  it("rejects circuitBreaker with maxAttempts=0 (#7 — avoids division by zero)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            pipeline: { status: "unknown" },
            circuitBreaker: [
              { runKey: "run-x", attempts: 0, maxAttempts: 0, escalated: false },
            ],
            crew: { timeline: [], pr: null },
          }),
      })
    );

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 3000 });
    expect(result.current.error).toContain("expected format");
  });

  it("reports error when fetch fails with status 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const { result } = renderHook(() => useStatus());

    await waitFor(
      () => {
        expect(result.current.error).not.toBeNull();
      },
      { timeout: 3000 }
    );

    expect(result.current.error).toContain("HTTP 500");
    expect(result.current.data).toBeNull();
  });

  it("reports error when fetch throws a network exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    const { result } = renderHook(() => useStatus());

    await waitFor(
      () => {
        expect(result.current.error).not.toBeNull();
      },
      { timeout: 3000 }
    );

    expect(result.current.error).toContain("Network error");
  });

  it("reports error when response does not match the expected format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ unexpected: "shape" }),
      })
    );

    const { result } = renderHook(() => useStatus());

    await waitFor(
      () => {
        expect(result.current.error).not.toBeNull();
      },
      { timeout: 3000 }
    );

    expect(result.current.error).toContain("expected format");
  });
});
