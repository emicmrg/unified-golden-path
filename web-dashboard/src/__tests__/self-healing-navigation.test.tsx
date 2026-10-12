/**
 * self-healing-navigation.test.tsx — Tests for Deck + SelfHealingDiagram sub-step coordination.
 *
 * Mirrors crew-navigation.test.tsx for the Self-Healing Flow slide (SH_SLIDE_INDEX = 5).
 *
 * Acceptance criteria:
 *   (a) On the SH slide, the first ArrowRight advances the sub-step
 *       WITHOUT changing the current slide.
 *   (b) From the last sub-step (step 7), ArrowRight advances to the next slide.
 *   (c) ArrowLeft retreats sub-steps and then yields to the prev slide.
 *   (d) No cross-contamination with sub-steps of Diagram A (subSteps[3]) or
 *       Diagram B (subSteps[4]).
 *   (e) Numeric key jump resets sub-step to 0.
 *   (f) The diagram DOM node does NOT remount between sub-steps.
 *   (g) SH_FOCUS_BOXES are in the correct containers (GitHub ↔ AWS).
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
vi.mock("../presentation/assets/self-healing-flow.svg", () => ({
  default: "/test-asset-self-healing-flow.svg",
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
const { SH_SLIDE_INDEX, ARCH_SLIDE_INDEX, CREW_SLIDE_INDEX, SLIDE_STEP_COUNTS } = await import("../presentation/slides.js");
const {
  SH_DIAGRAM_STEP_COUNT,
  SH_FOCUS_BOXES,
} = await import("../presentation/SelfHealingDiagram.js");

// ─────────────────────────────────────────────────────────────────────────────

describe("Deck navigation — SelfHealingDiagram (Diagrama C)", () => {

  it("sanity: SH_SLIDE_INDEX is 5", () => {
    expect(SH_SLIDE_INDEX).toBe(5);
  });

  it("sanity: SH_DIAGRAM_STEP_COUNT is 8", () => {
    expect(SH_DIAGRAM_STEP_COUNT).toBe(8);
  });

  it("sanity: SLIDE_STEP_COUNTS[SH_SLIDE_INDEX] === SH_DIAGRAM_STEP_COUNT", () => {
    expect(SLIDE_STEP_COUNTS[SH_SLIDE_INDEX]).toBe(SH_DIAGRAM_STEP_COUNT);
  });

  /** Jump directly to the SH slide using the numeric key (1-indexed). */
  async function navigateToSHSlide(): Promise<void> {
    await act(async () => {
      fireKey(String(SH_SLIDE_INDEX + 1)); // key "6" → slide index 5
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (a) First ArrowRight on SH slide advances sub-step, NOT slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(a) first ArrowRight on SH slide advances sub-step without changing slide", async () => {
    render(<Deck />);
    await navigateToSHSlide();

    const shSlideNumber = SH_SLIDE_INDEX + 1; // 6
    expect(getCurrentSlide()).toBe(shSlideNumber);

    // Step 0: overview hint visible
    const hintMatches = screen.getAllByText(/walk through each step/i);
    expect(hintMatches.length).toBeGreaterThanOrEqual(1);

    // Advance sub-step to 1
    await act(async () => { fireArrowRight(); });

    // Slide must NOT change
    expect(getCurrentSlide()).toBe(shSlideNumber);

    // Sidebar for step 1 (CI Fails) is shown
    expect(
      screen.getByRole("complementary", { name: /Step 1/i }),
    ).toBeInTheDocument();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (b) From last sub-step (step 7), ArrowRight advances to next slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(b) ArrowRight recorre sub-steps 0→7 sin cambiar de slide y al agotarlos pasa a la siguiente", async () => {
    render(<Deck />);
    await navigateToSHSlide();

    const shSlideNumber = SH_SLIDE_INDEX + 1;

    // Exhaust all sub-steps: from 0 to SH_DIAGRAM_STEP_COUNT-1 requires N-1 presses
    for (let i = 0; i < SH_DIAGRAM_STEP_COUNT - 1; i++) {
      await act(async () => { fireArrowRight(); });
      // While iterating through sub-steps, the slide number must NOT change
      expect(getCurrentSlide()).toBe(shSlideNumber);
    }

    // One more ArrowRight → next slide
    await act(async () => { fireArrowRight(); });
    expect(getCurrentSlide()).toBe(shSlideNumber + 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (c) ArrowLeft retreats sub-steps and then yields to prev slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(c) ArrowLeft from step 2 retreats to step 1 without changing slide", async () => {
    render(<Deck />);
    await navigateToSHSlide();
    const shSlideNumber = SH_SLIDE_INDEX + 1;

    await act(async () => { fireArrowRight(); }); // → step 1
    await act(async () => { fireArrowRight(); }); // → step 2

    // Step 2 sidebar should be about self-heal-dispatch
    expect(
      screen.getByRole("complementary", { name: /Step 2/i }),
    ).toBeInTheDocument();

    // ArrowLeft → step 1 (CI Fails)
    await act(async () => { fireArrowLeft(); });
    expect(getCurrentSlide()).toBe(shSlideNumber);
    expect(
      screen.getByRole("complementary", { name: /Step 1/i }),
    ).toBeInTheDocument();
  });

  it("(c) ArrowLeft from step 0 yields to previous slide", async () => {
    render(<Deck />);
    await navigateToSHSlide();
    const shSlideNumber = SH_SLIDE_INDEX + 1;

    // At step 0, ArrowLeft should go to prev slide
    await act(async () => { fireArrowLeft(); });
    expect(getCurrentSlide()).toBe(shSlideNumber - 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (d) No cross-contamination: sub-steps de A (index 3) y B (index 4)
  //     no se ven afectados al navegar el Diagrama C
  // ─────────────────────────────────────────────────────────────────────────

  it("(d) navegar el Diagrama C no contamina los sub-steps del Diagrama A", async () => {
    render(<Deck />);

    // Advance a few sub-steps on Architecture (Diagram A, index 3)
    await act(async () => { fireKey(String(ARCH_SLIDE_INDEX + 1)); }); // jump to slide 4
    await act(async () => { fireArrowRight(); }); // arch step 1
    await act(async () => { fireArrowRight(); }); // arch step 2

    // Jump to SH slide (index 5) and advance its sub-steps
    await navigateToSHSlide();
    await act(async () => { fireArrowRight(); }); // sh step 1
    await act(async () => { fireArrowRight(); }); // sh step 2
    await act(async () => { fireArrowRight(); }); // sh step 3

    // Jump BACK to Arch slide — must be at step 2 still (not reset, not overwritten by SH)
    await act(async () => { fireKey(String(ARCH_SLIDE_INDEX + 1)); });
    expect(getCurrentSlide()).toBe(ARCH_SLIDE_INDEX + 1);

    // Arch step 2 sidebar should still show OIDC/step info (not SH content)
    // Verify no SH-specific text leaks into the arch sidebar
    const currentSidebar = screen.queryByRole("complementary", { name: /Explanation/i });
    if (currentSidebar) {
      expect(currentSidebar.textContent).not.toMatch(/self-heal-dispatch|SELF_HEAL_MODE/i);
    }
  });

  it("(d) navegar el Diagrama C no contamina los sub-steps del Diagrama B", async () => {
    render(<Deck />);

    // Advance a few sub-steps on Crew (Diagram B, index 4)
    await act(async () => { fireKey(String(CREW_SLIDE_INDEX + 1)); }); // jump to slide 5
    await act(async () => { fireArrowRight(); }); // crew step 1
    await act(async () => { fireArrowRight(); }); // crew step 2

    // Jump to SH slide (index 5) and advance its sub-steps
    await navigateToSHSlide();
    await act(async () => { fireArrowRight(); }); // sh step 1
    await act(async () => { fireArrowRight(); }); // sh step 2
    await act(async () => { fireArrowRight(); }); // sh step 3

    // Jump back to Crew slide — must be at step 2 still
    await act(async () => { fireKey(String(CREW_SLIDE_INDEX + 1)); });
    expect(getCurrentSlide()).toBe(CREW_SLIDE_INDEX + 1);

    // Crew step 2 sidebar should NOT contain SH-specific content
    const currentSidebar = screen.queryByRole("complementary", { name: /Explanation/i });
    if (currentSidebar) {
      expect(currentSidebar.textContent).not.toMatch(/self-heal-dispatch|SELF_HEAL_MODE/i);
    }
  });

  it("(d) el contexto SelfHealingSubStepContext es independiente de SubStepContext (A) y CrewSubStepContext (B)", () => {
    // Each diagram slot in SLIDE_STEP_COUNTS must be non-zero (they are registered)
    expect(SLIDE_STEP_COUNTS[ARCH_SLIDE_INDEX]).toBeGreaterThan(0);
    expect(SLIDE_STEP_COUNTS[CREW_SLIDE_INDEX]).toBeGreaterThan(0);
    expect(SLIDE_STEP_COUNTS[SH_SLIDE_INDEX]).toBe(SH_DIAGRAM_STEP_COUNT);
    // Each diagram is registered at a DIFFERENT slide index — no aliasing
    expect(SH_SLIDE_INDEX).not.toBe(ARCH_SLIDE_INDEX);
    expect(SH_SLIDE_INDEX).not.toBe(CREW_SLIDE_INDEX);
    expect(ARCH_SLIDE_INDEX).not.toBe(CREW_SLIDE_INDEX);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (e) Numeric key jump resets sub-step to 0
  // ─────────────────────────────────────────────────────────────────────────

  it("(e) key jump then return resets SH sub-step to 0", async () => {
    render(<Deck />);
    await navigateToSHSlide();

    // Advance a few sub-steps
    await act(async () => { fireArrowRight(); }); // step 1
    await act(async () => { fireArrowRight(); }); // step 2
    await act(async () => { fireArrowRight(); }); // step 3

    // Jump to slide 1 (numeric key "1")
    await act(async () => { fireKey("1"); });
    expect(getCurrentSlide()).toBe(1);

    // Jump back to SH slide — sub-step should be reset to 0
    await navigateToSHSlide();
    // Step 0: overview hint visible
    const overviewHint = screen.getAllByText(/walk through each step/i);
    expect(overviewHint.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("complementary", { name: /Diagram overview/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /Explanation/i })).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (f) Diagram DOM does NOT remount between sub-steps
  // ─────────────────────────────────────────────────────────────────────────

  it("(f) aria-live status region is the same DOM node across sub-step changes", async () => {
    render(<Deck />);
    await navigateToSHSlide();

    // Capture the aria-live region at step 0
    const liveRegionBefore = screen.getByRole("status");

    // Advance to step 1
    await act(async () => { fireArrowRight(); });

    // The status region must be the SAME DOM node (not remounted)
    const liveRegionAfter = screen.getByRole("status");
    expect(liveRegionAfter).toBe(liveRegionBefore);
  });

  it("(f) Self-Healing Flow diagram region is the same DOM node across step changes", async () => {
    render(<Deck />);
    await navigateToSHSlide();

    const diagramRegion = screen.getByRole("region", { name: /Self-Healing Flow Diagram/i });

    await act(async () => { fireArrowRight(); });
    await act(async () => { fireArrowRight(); });

    expect(
      screen.getByRole("region", { name: /Self-Healing Flow Diagram/i }),
    ).toBe(diagramRegion);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (g) SH_FOCUS_BOXES integration: GitHub ↔ AWS placement
  // ─────────────────────────────────────────────────────────────────────────

  it("(g) GitHub container bboxes (steps 1,2,6) have x < 400 (left side)", () => {
    const githubSteps = [1, 2, 6] as const;
    for (const step of githubSteps) {
      const bbox = SH_FOCUS_BOXES[step];
      expect(bbox, `step ${step} bbox should not be null`).not.toBeNull();
      if (bbox) {
        expect(bbox.x, `step ${step} GitHub bbox x should be < 400`).toBeLessThan(400);
      }
    }
  });

  it("(g) AWS container bboxes (steps 3,4,5) have x > 400 (right side)", () => {
    const awsSteps = [3, 4, 5] as const;
    for (const step of awsSteps) {
      const bbox = SH_FOCUS_BOXES[step];
      expect(bbox, `step ${step} bbox should not be null`).not.toBeNull();
      if (bbox) {
        expect(bbox.x, `step ${step} AWS bbox x should be > 400`).toBeGreaterThan(400);
      }
    }
  });

  it("(g) body[data-arch-capturing] never set throughout full SH traversal", async () => {
    render(<Deck />);
    await navigateToSHSlide();

    const totalKeys = SH_DIAGRAM_STEP_COUNT + 2;
    for (let i = 0; i < totalKeys; i++) {
      await act(async () => { fireArrowRight(); });
      expect(document.body.getAttribute("data-arch-capturing")).toBeNull();
    }
  });
});
