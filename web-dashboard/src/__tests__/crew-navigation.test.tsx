/**
 * crew-navigation.test.tsx — Tests for Deck + CrewDiagram sub-step coordination.
 *
 * Mirrors deck-navigation.test.tsx for the Crew Agents slide (index 4).
 *
 * Acceptance criteria:
 *   (a) On the Crew slide, the first ArrowRight advances the sub-step
 *       WITHOUT changing the current slide.
 *   (b) From the last sub-step, ArrowRight advances to the next slide.
 *   (c) ArrowLeft retreats sub-steps and then yields to the prev slide.
 *   (d) The diagram DOM node does NOT remount between sub-steps.
 *   (e) Numeric key jump resets sub-step to 0.
 *   (f) CREW_FOCUS_BOXES contain the correct agent cards (integration check).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../hooks/useStatus.js", () => ({
  useStatus: () => ({
    pipeline: { status: "healthy", runId: null, updatedAt: null },
    device: { status: "healthy", lastSeen: null },
    selfHealing: { attempts: 0, maxAttempts: 2, open: false },
    loading: false,
    error: null,
  }),
}));

vi.mock("../hooks/useTelemetry.js", () => ({
  useTelemetry: () => ({
    latest: null,
    history: [],
    connected: false,
  }),
}));

// Mock SVG assets so jsdom does not fail on Vite URL imports
vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));
vi.mock("../presentation/assets/crew-agents.svg", () => ({
  default: "/test-asset-crew-agents.svg",
}));
vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

// ── Key helpers ──────────────────────────────────────────────────────────────

function fireArrowRight(): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
}

function fireArrowLeft(): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
  );
}

function fireKey(key: string): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true }),
  );
}

/** Current slide number from progressbar aria-valuenow (1-indexed). */
function getCurrentSlide(): number {
  const progressbar = screen.getByRole("progressbar");
  return Number(progressbar.getAttribute("aria-valuenow"));
}

// ── Import under test ────────────────────────────────────────────────────────

const { Deck } = await import("../presentation/Deck.js");
const { SLIDES, SLIDE_STEP_COUNTS } = await import("../presentation/slides.js");
const {
  CREW_DIAGRAM_STEP_COUNT,
  CREW_FOCUS_BOXES,
} = await import("../presentation/CrewDiagram.js");

// Crew slide index (0-based). Index 4 by construction (after Architecture at 3).
const CREW_SLIDE_INDEX = SLIDE_STEP_COUNTS.findIndex(
  (c) => c === CREW_DIAGRAM_STEP_COUNT,
);

// ─────────────────────────────────────────────────────────────────────────────

describe("Deck navigation — CrewDiagram (Diagrama B)", () => {

  it("sanity: CREW_SLIDE_INDEX is 4", () => {
    expect(CREW_SLIDE_INDEX).toBe(4);
  });

  it("sanity: CREW_DIAGRAM_STEP_COUNT is 6", () => {
    expect(CREW_DIAGRAM_STEP_COUNT).toBe(6);
  });

  // Helper: jump directly to Crew slide
  async function navigateToCrewSlide(): Promise<void> {
    await act(async () => {
      fireKey(String(CREW_SLIDE_INDEX + 1)); // 1-indexed numeric key
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (a) First ArrowRight on Crew slide advances sub-step, NOT slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(a) first ArrowRight on Crew slide advances sub-step without changing slide", async () => {
    render(<Deck />);
    await navigateToCrewSlide();

    const crewSlideNumber = CREW_SLIDE_INDEX + 1;
    expect(getCurrentSlide()).toBe(crewSlideNumber);

    // Step 0: overview hint visible — appears in both aria-live and the aside
    const hintMatches = screen.getAllByText(/to explore each agent/i);
    expect(hintMatches.length).toBeGreaterThanOrEqual(1);

    // Advance sub-step to 1
    await act(async () => { fireArrowRight(); });

    // Slide must NOT change
    expect(getCurrentSlide()).toBe(crewSlideNumber);

    // Sidebar for step 1 (CI Log Analyst) is shown
    expect(
      screen.getByRole("complementary", { name: /CI Log Analyst/i }),
    ).toBeInTheDocument();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (b) From last sub-step, ArrowRight advances to next slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(b) ArrowRight from last sub-step advances to next slide", async () => {
    render(<Deck />);
    await navigateToCrewSlide();

    const crewSlideNumber = CREW_SLIDE_INDEX + 1;

    // Exhaust all sub-steps (from 0 to N-1 requires N-1 presses)
    for (let i = 0; i < CREW_DIAGRAM_STEP_COUNT - 1; i++) {
      await act(async () => { fireArrowRight(); });
    }

    // Still on Crew slide at last sub-step
    expect(getCurrentSlide()).toBe(crewSlideNumber);

    // One more ArrowRight → next slide
    await act(async () => { fireArrowRight(); });
    expect(getCurrentSlide()).toBe(crewSlideNumber + 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (c) ArrowLeft retreats sub-steps and then yields to prev slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(c) ArrowLeft from step 2 retreats to step 1 without changing slide", async () => {
    render(<Deck />);
    await navigateToCrewSlide();
    const crewSlideNumber = CREW_SLIDE_INDEX + 1;

    await act(async () => { fireArrowRight(); }); // → step 1
    await act(async () => { fireArrowRight(); }); // → step 2

    expect(
      screen.getByRole("complementary", { name: /CI Repair Engineer/i }),
    ).toBeInTheDocument();

    // ArrowLeft → step 1 (CI Log Analyst)
    await act(async () => { fireArrowLeft(); });
    expect(getCurrentSlide()).toBe(crewSlideNumber);
    expect(
      screen.getByRole("complementary", { name: /CI Log Analyst/i }),
    ).toBeInTheDocument();
  });

  it("(c) ArrowLeft from step 0 yields to previous slide", async () => {
    render(<Deck />);
    await navigateToCrewSlide();
    const crewSlideNumber = CREW_SLIDE_INDEX + 1;

    // At step 0, ArrowLeft should go to prev slide
    await act(async () => { fireArrowLeft(); });
    expect(getCurrentSlide()).toBe(crewSlideNumber - 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (d) Diagram DOM does NOT remount between sub-steps
  // ─────────────────────────────────────────────────────────────────────────

  it("(d) aria-live status region is the same DOM node across sub-step changes", async () => {
    render(<Deck />);
    await navigateToCrewSlide();

    // Capture the aria-live region at step 0
    const liveRegionBefore = screen.getByRole("status");

    // Advance to step 1
    await act(async () => { fireArrowRight(); });

    // The status region must be the SAME DOM node (not remounted)
    const liveRegionAfter = screen.getByRole("status");
    expect(liveRegionAfter).toBe(liveRegionBefore);
  });

  it("(d) crew-diagram region is the same DOM node across step changes", async () => {
    render(<Deck />);
    await navigateToCrewSlide();

    const diagramRegion = screen.getByRole("region", { name: /CrewAI Agents Diagram/i });

    await act(async () => { fireArrowRight(); });
    await act(async () => { fireArrowRight(); });

    expect(
      screen.getByRole("region", { name: /CrewAI Agents Diagram/i }),
    ).toBe(diagramRegion);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (e) Numeric key jump resets sub-step to 0
  // ─────────────────────────────────────────────────────────────────────────

  it("(e) key 1 jump then return resets crew sub-step to 0", async () => {
    render(<Deck />);
    await navigateToCrewSlide();

    // Advance a few sub-steps
    await act(async () => { fireArrowRight(); }); // step 1
    await act(async () => { fireArrowRight(); }); // step 2

    // Jump to slide 1
    await act(async () => { fireKey("1"); });
    expect(getCurrentSlide()).toBe(1);

    // Jump back to Crew — sub-step should be reset to 0
    await navigateToCrewSlide();
    // Text appears in aria-live + aside — use getAllByText
    const overviewHint = screen.getAllByText(/to explore each agent/i);
    expect(overviewHint.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("complementary", { name: /Diagram overview/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /Explanation/i })).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (f) CREW_FOCUS_BOXES integration: agent cards at correct positions
  // ─────────────────────────────────────────────────────────────────────────

  it("(f) CREW_FOCUS_BOXES: three agent cards are at different x positions (left → right)", () => {
    const b1 = CREW_FOCUS_BOXES[1]; // log-analyst (leftmost)
    const b2 = CREW_FOCUS_BOXES[2]; // fix-engineer (center)
    const b3 = CREW_FOCUS_BOXES[3]; // reviewer (rightmost)

    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b3).not.toBeNull();

    if (b1 && b2 && b3) {
      // Left → center → right
      expect(b1.x).toBeLessThan(b2.x);
      expect(b2.x).toBeLessThan(b3.x);
    }
  });

  it("(f) CREW_FOCUS_BOXES: step 4 targets the Bedrock/crewai card (left panel, NOT the wide band)", () => {
    const bRuntime = CREW_FOCUS_BOXES[4];
    expect(bRuntime).not.toBeNull();
    if (bRuntime) {
      // The correct box targets the crewai+Amazon Bedrock card on the left
      // x ≈ 1 (leftmost), y ≈ 611, w ≈ 456 — NOT wider than any single agent card * 2
      expect(bRuntime.x).toBeLessThan(10);
      expect(bRuntime.y).toBeGreaterThan(500);
      expect(bRuntime.y).toBeLessThan(700);
      // Width covers only the Bedrock card, not the full diagram width
      const b1 = CREW_FOCUS_BOXES[1];
      if (b1) {
        // Old bug: w > 1000; correct: w ≈ 456 (narrower than a single agent card ×2)
        expect(bRuntime.w).toBeLessThan(b1.w * 2);
      }
      // Must NOT overlap the agent cards (agent 1 starts at x ≈ 693)
      const agentCard1 = CREW_FOCUS_BOXES[1];
      if (agentCard1) {
        expect(bRuntime.x + bRuntime.w).toBeLessThan(agentCard1.x);
      }
    }
  });

  it("(f) body[data-arch-capturing] never set throughout full Crew traversal", async () => {
    render(<Deck />);
    await navigateToCrewSlide();

    const totalKeys = SLIDES.length + CREW_DIAGRAM_STEP_COUNT + 2;
    for (let i = 0; i < totalKeys; i++) {
      await act(async () => { fireArrowRight(); });
      expect(document.body.getAttribute("data-arch-capturing")).toBeNull();
    }
  });
});
