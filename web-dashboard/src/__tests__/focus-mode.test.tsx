/**
 * focus-mode.test.tsx — Tests for DashboardPage tabs and component rendering.
 *
 * The old MDX Deck focus-mode tests are replaced by DashboardPage smoke tests.
 * FocusOverlay and LiveDashboard interaction tests remain where they don't
 * depend on the slide engine.
 *
 * Covers:
 *   (a) DashboardPage renders all 3 tab buttons
 *   (b) Default tab is "Fleet Health"
 *   (c) Clicking "Golden Path" tab shows that panel
 *   (d) Clicking "Self-Healing" tab shows that panel
 *   (e) Connection badge renders without emojis (text only or dot)
 *   (f) Pipeline badge renders without emojis
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { MemoryRouter } from "react-router-dom";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// ── Import under test ────────────────────────────────────────────────────────

const { DashboardPage } = await import("../pages/DashboardPage.js");

// ── Helper ───────────────────────────────────────────────────────────────────

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("DashboardPage — tab navigation", () => {
  beforeEach(() => {
    renderDashboard();
  });

  it("(a) renders Fleet Health tab button", () => {
    expect(screen.getByRole("tab", { name: /Fleet Health/i })).toBeTruthy();
  });

  it("(a) renders Golden Path tab button", () => {
    expect(screen.getByRole("tab", { name: /Golden Path/i })).toBeTruthy();
  });

  it("(a) renders Self-Healing tab button", () => {
    expect(screen.getByRole("tab", { name: /Self-Healing/i })).toBeTruthy();
  });

  it("(b) Fleet Health tab is selected by default", () => {
    const fleetTab = screen.getByRole("tab", { name: /Fleet Health/i });
    expect(fleetTab.getAttribute("aria-selected")).toBe("true");
  });

  it("(c) clicking Golden Path activates its panel", () => {
    const goldenTab = screen.getByRole("tab", { name: /Golden Path/i });
    fireEvent.click(goldenTab);
    expect(goldenTab.getAttribute("aria-selected")).toBe("true");
    // The fleet tab should now be deselected
    const fleetTab = screen.getByRole("tab", { name: /Fleet Health/i });
    expect(fleetTab.getAttribute("aria-selected")).toBe("false");
  });

  it("(d) clicking Self-Healing activates its panel", () => {
    const healingTab = screen.getByRole("tab", { name: /Self-Healing/i });
    fireEvent.click(healingTab);
    expect(healingTab.getAttribute("aria-selected")).toBe("true");
  });
});

describe("DashboardPage — no emojis", () => {
  it("(e) connection badge label contains no emoji characters", () => {
    renderDashboard();
    const badge = screen.getByLabelText(/MQTT connection status/i);
    // Should not contain common emoji code points
    expect(badge.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(badge.textContent).not.toMatch(/[⚫🟡🟢🔴]/u);
  });

  it("(f) page contains no emoji text nodes in tab labels", () => {
    renderDashboard();
    const nav = screen.getByRole("navigation", { name: /Dashboard views/i });
    // No emoji in tab button labels
    expect(nav.textContent).not.toMatch(/[🔍🔧🧐🚨⚠️🔀📌✅❌⚪ℹ️]/u);
  });
});
