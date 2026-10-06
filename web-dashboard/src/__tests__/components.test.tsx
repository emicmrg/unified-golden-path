/**
 * components.test.tsx — Smoke tests for the 3 main components.
 * Mocks hooks to avoid calling AWS.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ---- Hook mocks ----
vi.mock("../hooks/useTelemetry.js", () => ({
  useTelemetry: vi.fn(() => ({
    connectionStatus: "disconnected" as const,
    latest: null,
    history: [],
    error: null,
  })),
}));

vi.mock("../hooks/useStatus.js", () => ({
  useStatus: vi.fn(() => ({
    loading: false,
    data: null,
    error: null,
    lastUpdated: null,
  })),
}));

// Import components after mocks
const { FleetHealth } = await import("../components/FleetHealth.js");
const { GoldenPath } = await import("../components/GoldenPath.js");
const { SelfHealing } = await import("../components/SelfHealing.js");
const { useTelemetry } = await import("../hooks/useTelemetry.js");
const { useStatus } = await import("../hooks/useStatus.js");

describe("FleetHealth", () => {
  it("renders the title", () => {
    render(<FleetHealth />);
    expect(screen.getByText(/Fleet Health/i)).toBeInTheDocument();
  });

  it("shows the MQTT connection status", () => {
    render(<FleetHealth />);
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
  });

  it("shows a waiting message when there is no telemetry data", () => {
    render(<FleetHealth />);
    expect(screen.getByText(/no telemetry data/i)).toBeInTheDocument();
  });

  it("shows temperature and humidity cards when data is available", () => {
    vi.mocked(useTelemetry).mockReturnValueOnce({
      connectionStatus: "connected",
      latest: {
        deviceId: "ugp-gateway-01",
        temperatureCelsius: 5.2,
        humidityPercent: 45,
        timestamp: "2026-10-06T14:00:00.000Z",
      },
      history: [
        {
          timestamp: "2026-10-06T14:00:00.000Z",
          temperatureCelsius: 5.2,
          humidityPercent: 45,
          status: "OK" as const,
        },
      ],
      error: null,
    });

    render(<FleetHealth />);
    expect(screen.getByText(/temperature/i)).toBeInTheDocument();
    expect(screen.getByText(/humidity/i)).toBeInTheDocument();
    expect(screen.getByText("5.2")).toBeInTheDocument();
    expect(screen.getByText("45.0")).toBeInTheDocument();
  });

  it("shows the MQTT error notice when connectionStatus is error", () => {
    vi.mocked(useTelemetry).mockReturnValueOnce({
      connectionStatus: "error",
      latest: null,
      history: [],
      error: "MQTT error: Connection refused",
    });

    render(<FleetHealth />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/MQTT error/i)).toBeInTheDocument();
  });

  // M4: the sparkline has 2 points so the safe band is rendered
  it("M4: sparkline renders when there are enough history points", () => {
    vi.mocked(useTelemetry).mockReturnValueOnce({
      connectionStatus: "connected",
      latest: {
        deviceId: "ugp-gateway-01",
        temperatureCelsius: 5.0,
        humidityPercent: 45,
        timestamp: "2026-10-06T14:00:05.000Z",
      },
      history: [
        {
          timestamp: "2026-10-06T14:00:00.000Z",
          temperatureCelsius: 4.5,
          humidityPercent: 44,
          status: "OK" as const,
        },
        {
          timestamp: "2026-10-06T14:00:05.000Z",
          temperatureCelsius: 5.0,
          humidityPercent: 45,
          status: "OK" as const,
        },
      ],
      error: null,
    });

    render(<FleetHealth />);
    // Sparklines should have aria-label with "2 points"
    const sparklines = screen.getAllByRole("img");
    expect(sparklines.some((el) => el.getAttribute("aria-label")?.includes("2 points"))).toBe(true);
  });
});

describe("GoldenPath", () => {
  it("renders the title", () => {
    render(<GoldenPath />);
    expect(screen.getByText(/Golden Path/i)).toBeInTheDocument();
  });

  it("shows unknown status and placeholder when there is no data", () => {
    render(<GoldenPath />);
    expect(screen.getAllByText(/unknown/i).length).toBeGreaterThan(0);
  });

  it("shows 'Passing' badge when pipeline status is passing", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: {
        pipeline: {
          status: "passing",
          lastRun: { id: "42", conclusion: "success", url: "https://github.com/42" },
        },
        circuitBreaker: [],
        crew: { timeline: [], pr: null },
      },
      error: null,
      lastUpdated: "2026-10-06T14:00:00.000Z",
    });

    render(<GoldenPath />);
    expect(screen.getByText(/passing/i)).toBeInTheDocument();
  });

  it("shows block 6 note when pipeline is unknown", () => {
    render(<GoldenPath />);
    expect(screen.getByText(/Block 6/i)).toBeInTheDocument();
  });

  it("shows an alert when there is an API error", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: null,
      error: "Status API not configured. Check VITE_STATUS_API_URL.",
      lastUpdated: null,
    });

    render(<GoldenPath />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("SelfHealing", () => {
  it("renders the title", () => {
    render(<SelfHealing />);
    expect(screen.getByText(/Self-Healing/i)).toBeInTheDocument();
  });

  it("M2: shows the 3 crew roles as a static context block", () => {
    render(<SelfHealing />);
    expect(screen.getByText(/Log Analyst/i)).toBeInTheDocument();
    expect(screen.getByText(/Fix Engineer/i)).toBeInTheDocument();
    expect(screen.getByText(/Reviewer/i)).toBeInTheDocument();
  });

  it("M2: shows 'no per-step crew telemetry' note in the roles block", () => {
    render(<SelfHealing />);
    expect(screen.getByText(/no per-step crew telemetry/i)).toBeInTheDocument();
  });

  it("M2: shows real events with the handler shape (ts, runKey, event)", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: {
        pipeline: { status: "unknown" },
        circuitBreaker: [],
        crew: {
          timeline: [
            {
              ts: "2026-10-06T14:00:00.000Z",
              runKey: "run-001",
              event: "first-attempt" as const,
            },
            {
              ts: "2026-10-06T14:05:00.000Z",
              runKey: "run-001",
              event: "escalated-to-human" as const,
              detail: "2/2",
            },
          ],
          pr: null,
        },
        degraded: null,
      },
      error: null,
      lastUpdated: "2026-10-06T14:10:00.000Z",
    });

    render(<SelfHealing />);
    expect(screen.getByText(/First attempt recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/Escalated to human/i)).toBeInTheDocument();
    // runKey visible
    expect(screen.getAllByText(/run-001/i).length).toBeGreaterThan(0);
  });

  it("M2: does not filter by e.step — shows all events even if not from a known step", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: {
        pipeline: { status: "unknown" },
        circuitBreaker: [],
        crew: {
          timeline: [
            {
              ts: "2026-10-06T14:00:00.000Z",
              runKey: "run-999",
              event: "attempt-recorded" as const,
              detail: "1/3",
            },
          ],
          pr: null,
        },
        degraded: null,
      },
      error: null,
      lastUpdated: "2026-10-06T14:10:00.000Z",
    });

    render(<SelfHealing />);
    expect(screen.getByText(/Crew attempt/i)).toBeInTheDocument();
    expect(screen.getByText(/run-999/i)).toBeInTheDocument();
  });

  it("M3: renders degraded banner with role=status when degraded is not null", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: {
        pipeline: { status: "unknown" },
        circuitBreaker: [],
        crew: { timeline: [], pr: null },
        degraded: "SelfHealingStack no desplegada: la tabla del circuit breaker no existe",
      },
      error: null,
      lastUpdated: "2026-10-06T14:10:00.000Z",
    });

    render(<SelfHealing />);
    const banner = screen.getByRole("status");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain("SelfHealingStack no desplegada");
  });

  it("M3: does NOT render degraded banner when degraded is null", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: {
        pipeline: { status: "unknown" },
        circuitBreaker: [],
        crew: { timeline: [], pr: null },
        degraded: null,
      },
      error: null,
      lastUpdated: "2026-10-06T14:10:00.000Z",
    });

    render(<SelfHealing />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the PR when it is available", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: {
        pipeline: { status: "unknown" },
        circuitBreaker: [],
        crew: {
          timeline: [],
          pr: { url: "https://github.com/pr/5", branch: "fix/auto-repair-001" },
        },
        degraded: null,
      },
      error: null,
      lastUpdated: "2026-10-06T14:00:00.000Z",
    });

    render(<SelfHealing />);
    expect(screen.getByText("fix/auto-repair-001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pull request/i })).toHaveAttribute(
      "href",
      "https://github.com/pr/5"
    );
  });

  it("shows 'escalated to human' badge when a circuit breaker is escalated", () => {
    vi.mocked(useStatus).mockReturnValueOnce({
      loading: false,
      data: {
        pipeline: { status: "unknown" },
        circuitBreaker: [
          { runKey: "run-001", attempts: 3, maxAttempts: 3, escalated: true },
        ],
        crew: { timeline: [] , pr: null},
        degraded: null,
      },
      error: null,
      lastUpdated: "2026-10-06T14:00:00.000Z",
    });

    render(<SelfHealing />);
    expect(screen.getByText(/Escalated to human/i)).toBeInTheDocument();
  });
});
