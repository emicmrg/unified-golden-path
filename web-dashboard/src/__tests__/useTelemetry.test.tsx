/**
 * useTelemetry.test.tsx — Tests for the useTelemetry hook with PubSub mocked.
 * Does NOT call real AWS; mocks aws-amplify and @aws-amplify/pubsub.
 * "Not configured" coverage is in hooks-unconfigured.test.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { PubSub } from "@aws-amplify/pubsub";

// ---- Types for the mocks ----
type SubscriptionObserver = {
  next: (data: unknown) => void;
  error: (err: unknown) => void;
  complete: () => void;
};

type SubscriptionLike = { unsubscribe: () => void };

// ---- Mock aws-amplify (Amplify.configure is a no-op in tests) ----
vi.mock("aws-amplify", () => ({
  Amplify: {
    configure: vi.fn(),
  },
}));

// ---- Mock @aws-amplify/pubsub ----
let capturedObserver: SubscriptionObserver | null = null;
let capturedClientId: string | null = null;
const mockUnsubscribe = vi.fn();

const mockSubscribeInner = vi.fn((observer: SubscriptionObserver): SubscriptionLike => {
  capturedObserver = observer;
  return { unsubscribe: mockUnsubscribe };
});

const mockSubscribe = vi.fn(() => ({
  subscribe: mockSubscribeInner,
}));

vi.mock("@aws-amplify/pubsub", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PubSub: vi.fn().mockImplementation(function (this: unknown, options?: any) {
    capturedClientId = (options?.clientId as string | undefined) ?? null;
    return { subscribe: mockSubscribe };
  }),
}));

// ---- Mock config with MQTT configured ----
vi.mock("../config.js", () => ({
  config: {
    mqttConfigured: true,
    statusApiConfigured: false,
    awsRegion: "us-east-1",
    identityPoolId: "us-east-1:mock-identity-pool-id",
    iotEndpoint: "acyee6rss1oux-ats.iot.us-east-1.amazonaws.com",
    telemetryTopic: "ugp/telemetry/ugp-gateway-01",
    statusApiUrl: undefined,
    mqttClientIdPrefix: "ugp-dashboard-",
  },
}));

// Import the hook AFTER the mocks
const { useTelemetry } = await import("../hooks/useTelemetry.js");

describe("useTelemetry", () => {
  beforeEach(() => {
    capturedObserver = null;
    capturedClientId = null;
    mockUnsubscribe.mockReset();
    mockSubscribe.mockClear();
    mockSubscribeInner.mockClear();
    vi.mocked(PubSub).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // C1: the clientId must have the correct prefix to pass the IoT guest role
  it("C1: PubSub is created with a clientId starting with the ugp-dashboard- prefix", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(
      () => {
        expect(["connecting", "connected"]).toContain(result.current.connectionStatus);
      },
      { timeout: 2000 }
    );

    expect(vi.mocked(PubSub)).toHaveBeenCalledTimes(1);
    expect(typeof capturedClientId).toBe("string");
    expect(capturedClientId!.startsWith("ugp-dashboard-")).toBe(true);
  });

  it("C1: the clientId has a random UUID suffix (avoids collisions between visitors)", async () => {
    // Render two independent instances
    const { result: r1, unmount: u1 } = renderHook(() => useTelemetry());
    await waitFor(
      () => expect(["connecting", "connected"]).toContain(r1.current.connectionStatus),
      { timeout: 2000 }
    );
    const id1 = capturedClientId ?? "";
    u1();

    // Reset for the second instance
    capturedClientId = null;
    vi.mocked(PubSub).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (PubSub as any).mockImplementation(function (options?: any) {
      capturedClientId = (options?.clientId as string | undefined) ?? null;
      return { subscribe: mockSubscribe };
    });

    const { result: r2, unmount: u2 } = renderHook(() => useTelemetry());
    await waitFor(
      () => expect(["connecting", "connected"]).toContain(r2.current.connectionStatus),
      { timeout: 2000 }
    );
    const id2 = capturedClientId ?? "";
    u2();

    expect(id1).not.toBe(id2); // different suffixes
    expect(id1.startsWith("ugp-dashboard-")).toBe(true);
    expect(id2.startsWith("ugp-dashboard-")).toBe(true);
  });

  it("reaches connecting state on mount", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(
      () => {
        expect(["connecting", "connected"]).toContain(result.current.connectionStatus);
      },
      { timeout: 2000 }
    );
  });

  it("updates latest and history when a valid MQTT message arrives", async () => {
    const { result } = renderHook(() => useTelemetry());

    // Wait for the observer to be registered
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    const mockMessage = {
      deviceId: "ugp-gateway-01",
      temperatureCelsius: 5.2,
      humidityPercent: 45,
      timestamp: "2026-10-06T14:00:00.000Z",
    };

    act(() => {
      capturedObserver?.next(mockMessage);
    });

    await waitFor(() => {
      expect(result.current.latest).not.toBeNull();
    });

    expect(result.current.latest?.temperatureCelsius).toBe(5.2);
    expect(result.current.latest?.humidityPercent).toBe(45);
    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].status).toBe("OK");
  });

  it("classifies out-of-range temperature as ALARM in the history", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    act(() => {
      capturedObserver?.next({
        deviceId: "ugp-gateway-01",
        temperatureCelsius: -5,
        humidityPercent: 45,
        timestamp: "2026-10-06T14:01:00.000Z",
      });
    });

    await waitFor(() => expect(result.current.history).toHaveLength(1));
    expect(result.current.history[0].status).toBe("ALARM");
  });

  it("accumulates multiple readings in the history", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    act(() => {
      capturedObserver?.next({
        deviceId: "gw",
        temperatureCelsius: 5,
        humidityPercent: 45,
        timestamp: "2026-10-06T14:00:00Z",
      });
      capturedObserver?.next({
        deviceId: "gw",
        temperatureCelsius: 6,
        humidityPercent: 46,
        timestamp: "2026-10-06T14:00:05Z",
      });
      capturedObserver?.next({
        deviceId: "gw",
        temperatureCelsius: 7,
        humidityPercent: 47,
        timestamp: "2026-10-06T14:00:10Z",
      });
    });

    await waitFor(() => expect(result.current.history).toHaveLength(3));
    expect(result.current.latest?.temperatureCelsius).toBe(7);
  });

  it("ignores messages with non-numeric temperature", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    act(() => {
      capturedObserver?.next({
        deviceId: "gw",
        temperatureCelsius: "not-a-number",
        humidityPercent: 45,
        timestamp: "2026-10-06T14:00:00Z",
      });
    });

    // history must not grow
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.history).toHaveLength(0);
    expect(result.current.latest).toBeNull();
  });

  // #6: NaN/Infinity must be discarded, not classified as WARN
  it("#6: ignores messages with NaN temperature (do not classify 'NaN °C' as WARN)", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    act(() => {
      capturedObserver?.next({
        deviceId: "gw",
        temperatureCelsius: NaN,
        humidityPercent: 45,
        timestamp: "2026-10-06T14:00:00Z",
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.history).toHaveLength(0);
    expect(result.current.latest).toBeNull();
  });

  it("#6: ignores messages with Infinity humidity", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    act(() => {
      capturedObserver?.next({
        deviceId: "gw",
        temperatureCelsius: 5.0,
        humidityPercent: Infinity,
        timestamp: "2026-10-06T14:00:00Z",
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.history).toHaveLength(0);
    expect(result.current.latest).toBeNull();
  });

  it("reports error state when the observable emits an error", async () => {
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    act(() => {
      capturedObserver?.error(new Error("Connection refused"));
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("error");
    });

    expect(result.current.error).toContain("Connection refused");
  });

  it("calls unsubscribe when the component unmounts", async () => {
    const { result, unmount } = renderHook(() => useTelemetry());
    await waitFor(() => expect(capturedObserver).not.toBeNull(), { timeout: 2000 });

    act(() => {
      capturedObserver?.next({
        deviceId: "gw",
        temperatureCelsius: 5,
        humidityPercent: 45,
        timestamp: "2026-10-06T14:00:00Z",
      });
    });
    await waitFor(() => expect(result.current.latest).not.toBeNull());

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
