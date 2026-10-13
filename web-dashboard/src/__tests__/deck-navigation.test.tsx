/**
 * deck-navigation.test.tsx — Smoke tests for ScrollDeck rendering.
 *
 * The old MDX Deck + slides.ts navigation tests are replaced by these
 * scroll-deck smoke tests. The core scroll mechanics (selectStep / navigateStep
 * hysteresis + keyboard nav) are covered in detail by scroll-proto.test.ts.
 *
 * Covers:
 *   (a) ScrollDeck renders without crashing
 *   (b) All 9 section headings are present in the document
 *   (c) ArchitectureDiagram is rendered (section-architecture present)
 *   (d) CrewDiagram is rendered (section-agents present)
 *   (e) SelfHealingDiagram is rendered (section-self-healing present)
 *   (f) Nav dots are present with correct count (9)
 *   (k) section-client is in the document
 *   (l) section-agenda is in the document
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MemoryRouter } from "react-router-dom";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../hooks/useStatus.js", () => ({
  useStatus: () => ({
    loading: false,
    data: null,
    error: null,
    lastUpdated: null,
  }),
}));

vi.mock("../hooks/useTelemetry.js", () => ({
  useTelemetry: () => ({
    connectionStatus: "disconnected" as const,
    latest: null,
    history: [],
    error: null,
  }),
}));

vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));
vi.mock("../presentation/assets/crew-agents.svg", () => ({
  default: "/test-asset-crew-agents.svg",
}));
vi.mock("../presentation/assets/self-healing-flow.svg", () => ({
  default: "/test-asset-self-healing-flow.svg",
}));

vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));
vi.mock("../presentation/ScrollDeck.css", () => ({}));
vi.mock("../presentation/theme-light.css", () => ({}));

// ── Import under test ────────────────────────────────────────────────────────

const { ScrollDeck } = await import("../presentation/ScrollDeck.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderDeck() {
  return render(
    <MemoryRouter>
      <ScrollDeck />
    </MemoryRouter>,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("ScrollDeck — smoke tests", () => {
  it("(a) renders without crashing", () => {
    const { container } = renderDeck();
    expect(container.querySelector("[data-testid='scroll-deck']")).toBeTruthy();
  });

  it("(b) Cover section heading is present", () => {
    renderDeck();
    expect(screen.getByText(/Building a Recovery Path/i)).toBeTruthy();
  });

  it("(c) Platform section heading is present", () => {
    renderDeck();
    // Multiple "Unified Golden Path" instances expected (header + section heading)
    const matches = screen.getAllByText(/Unified Golden Path/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("(d) section-firmware is in the document", () => {
    const { container } = renderDeck();
    expect(container.querySelector("#section-firmware")).toBeTruthy();
  });

  it("(e) section-architecture is in the document", () => {
    const { container } = renderDeck();
    expect(container.querySelector("#section-architecture")).toBeTruthy();
  });

  it("(f) section-agents is in the document", () => {
    const { container } = renderDeck();
    expect(container.querySelector("#section-agents")).toBeTruthy();
  });

  it("(g) section-self-healing is in the document", () => {
    const { container } = renderDeck();
    expect(container.querySelector("#section-self-healing")).toBeTruthy();
  });

  it("(h) section-closing is in the document", () => {
    const { container } = renderDeck();
    expect(container.querySelector("#section-closing")).toBeTruthy();
  });

  it("(k) section-client is in the document", () => {
    const { container } = renderDeck();
    expect(container.querySelector("#section-client")).toBeTruthy();
  });

  it("(l) section-agenda is in the document", () => {
    const { container } = renderDeck();
    expect(container.querySelector("#section-agenda")).toBeTruthy();
  });

  it("(i) nav dots are present — 9 section dots", () => {
    const { container } = renderDeck();
    const dots = container.querySelectorAll(".deck-nav-dot");
    expect(dots.length).toBe(9);
  });

  it("(j) keyboard hint is present in a diagram section", () => {
    renderDeck();
    const hints = screen.getAllByText(/Arrow keys/i);
    // At least 3 diagram sections (firmware, architecture, agents, self-healing)
    expect(hints.length).toBeGreaterThanOrEqual(3);
  });
});
