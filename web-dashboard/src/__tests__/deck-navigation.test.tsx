/**
 * deck-navigation.test.tsx — Tests for Deck + ArchitectureDiagram coordination.
 *
 * Mounts the REAL Deck component and verifies the sub-step coordination model
 * introduced by the Context-based fix (Option B — highlight+panel, no zoom).
 *
 * Acceptance criteria:
 *   (a) ArrowRight on the cover slide advances to the next slide and does NOT
 *       trap navigation in the diagram.
 *   (b) On the Architecture slide, the first ArrowRight advances the sub-step
 *       WITHOUT changing the current slide.
 *   (c) From the last sub-step, ArrowRight advances to the next slide.
 *   (d) ArrowLeft retreats sub-steps and then yields to the prev slide.
 *   (e) The diagram DOM node does NOT remount between sub-steps: the aria-live
 *       status region is the SAME DOM node instance across step k and k+1.
 *
 * Additionally verifies:
 *   (f) body[data-arch-capturing] is never set.
 *   (g) DotNav / numeric key jump resets sub-step to 0.
 *
 * HOW WE TRACK CURRENT SLIDE:
 *   The progressbar has aria-valuenow=N (1-indexed). Reading that value gives
 *   us the current slide without relying on text content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
const { ARCH_DIAGRAM_STEP_COUNT } = await import(
  "../presentation/ArchitectureDiagram.js"
);

// Architecture slide index (0-based). SLIDE_STEP_COUNTS still exported from slides.ts.
// We use findIndex here as it is safe: SLIDE_STEP_COUNTS[3] = ARCH_DIAGRAM_STEP_COUNT
// and no other slide has the same count.
const ARCH_SLIDE_INDEX = SLIDE_STEP_COUNTS.findIndex(
  (c) => c === ARCH_DIAGRAM_STEP_COUNT,
);

// ─────────────────────────────────────────────────────────────────────────────

describe("Deck navigation — Option B (highlight+panel)", () => {
  beforeEach(() => {
    document.body.removeAttribute("data-arch-capturing");
  });

  afterEach(() => {
    document.body.removeAttribute("data-arch-capturing");
  });

  it("sanity: ARCH_SLIDE_INDEX is 3", () => {
    expect(ARCH_SLIDE_INDEX).toBe(3);
  });

  it("sanity: ARCH_DIAGRAM_STEP_COUNT is 8", () => {
    expect(ARCH_DIAGRAM_STEP_COUNT).toBe(8);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Navigate to Architecture slide (helper used by multiple tests)
  // ─────────────────────────────────────────────────────────────────────────

  async function navigateToArchSlide(): Promise<void> {
    await act(async () => {
      fireKey(String(ARCH_SLIDE_INDEX + 1)); // numeric key = 1-indexed
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (a) Cover slide: ArrowRight advances slide, not diagram
  // ─────────────────────────────────────────────────────────────────────────

  it("(a) ArrowRight on cover slide advances to slide 2 (no trap)", async () => {
    render(<Deck />);
    expect(getCurrentSlide()).toBe(1);

    await act(async () => { fireArrowRight(); });
    expect(getCurrentSlide()).toBe(2);
  });

  it("(a) body[data-arch-capturing] never set after ArrowRight on cover", async () => {
    render(<Deck />);
    await act(async () => { fireArrowRight(); });
    expect(document.body.getAttribute("data-arch-capturing")).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (b) Architecture slide: first ArrowRight advances sub-step, NOT slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(b) first ArrowRight on Architecture slide advances sub-step without changing slide", async () => {
    render(<Deck />);
    await navigateToArchSlide();

    const archSlideNumber = ARCH_SLIDE_INDEX + 1;
    expect(getCurrentSlide()).toBe(archSlideNumber);

    // Step 0: overview hint visible
    expect(screen.getByText(/to explore each service/i)).toBeInTheDocument();

    // Advance sub-step to 1
    await act(async () => { fireArrowRight(); });

    // Slide must NOT change
    expect(getCurrentSlide()).toBe(archSlideNumber);

    // Sidebar for step 1 (IaC/CDK — new entry point) is shown
    expect(
      screen.getByRole("complementary", { name: /Infrastructure as Code/i }),
    ).toBeInTheDocument();
  });

  it("(b) body[data-arch-capturing] never set during sub-step navigation", async () => {
    render(<Deck />);
    await navigateToArchSlide();
    await act(async () => { fireArrowRight(); });
    expect(document.body.getAttribute("data-arch-capturing")).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (c) From last sub-step, ArrowRight advances to next slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(c) ArrowRight from last sub-step advances to next slide", async () => {
    render(<Deck />);
    await navigateToArchSlide();

    const archSlideNumber = ARCH_SLIDE_INDEX + 1;

    // Exhaust all sub-steps (from 0 to N-1 requires N-1 presses)
    for (let i = 0; i < ARCH_DIAGRAM_STEP_COUNT - 1; i++) {
      await act(async () => { fireArrowRight(); });
    }

    // Still on Architecture slide at last sub-step
    expect(getCurrentSlide()).toBe(archSlideNumber);

    // One more ArrowRight → next slide
    await act(async () => { fireArrowRight(); });
    expect(getCurrentSlide()).toBe(archSlideNumber + 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (d) ArrowLeft retreats sub-steps and then yields to prev slide
  // ─────────────────────────────────────────────────────────────────────────

  it("(d) ArrowLeft from step 2 retreats to step 1 without changing slide", async () => {
    render(<Deck />);
    await navigateToArchSlide();
    const archSlideNumber = ARCH_SLIDE_INDEX + 1;

    // Advance to step 2
    await act(async () => { fireArrowRight(); }); // → step 1 (IaC/CDK)
    await act(async () => { fireArrowRight(); }); // → step 2 (Edge Layer)

    expect(
      screen.getByRole("complementary", { name: /Edge Layer/i }),
    ).toBeInTheDocument();

    // ArrowLeft → step 1 (IaC/CDK)
    await act(async () => { fireArrowLeft(); });
    expect(getCurrentSlide()).toBe(archSlideNumber);
    expect(
      screen.getByRole("complementary", { name: /Infrastructure as Code/i }),
    ).toBeInTheDocument();
  });

  it("(d) ArrowLeft from step 0 yields to previous slide", async () => {
    render(<Deck />);
    await navigateToArchSlide();
    const archSlideNumber = ARCH_SLIDE_INDEX + 1;

    // At step 0 (overview), ArrowLeft should go to prev slide
    await act(async () => { fireArrowLeft(); });
    expect(getCurrentSlide()).toBe(archSlideNumber - 1);
  });

  it("(d) full forward-then-backward traversal of diagram sub-steps", async () => {
    render(<Deck />);
    await navigateToArchSlide();
    const archSlideNumber = ARCH_SLIDE_INDEX + 1;

    // Forward: step 0 → step N-1
    for (let i = 0; i < ARCH_DIAGRAM_STEP_COUNT - 1; i++) {
      await act(async () => { fireArrowRight(); });
    }
    expect(getCurrentSlide()).toBe(archSlideNumber);

    // Backward: step N-1 → step 0
    for (let i = 0; i < ARCH_DIAGRAM_STEP_COUNT - 1; i++) {
      await act(async () => { fireArrowLeft(); });
    }
    expect(getCurrentSlide()).toBe(archSlideNumber);

    // One more ArrowLeft at step 0 → prev slide
    await act(async () => { fireArrowLeft(); });
    expect(getCurrentSlide()).toBe(archSlideNumber - 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (e) Diagram node does NOT remount between sub-steps
  //     The aria-live status region must be the SAME DOM node instance
  //     across step k and step k+1.
  // ─────────────────────────────────────────────────────────────────────────

  it("(e) aria-live status region is the same DOM node across sub-step changes (no remount)", async () => {
    render(<Deck />);
    await navigateToArchSlide();

    // Capture the aria-live region DOM node at step 0
    const liveRegionBefore = screen.getByRole("status");

    // Advance to step 1
    await act(async () => { fireArrowRight(); });

    // The status region must be the SAME DOM node (not remounted)
    const liveRegionAfter = screen.getByRole("status");
    expect(liveRegionAfter).toBe(liveRegionBefore);
  });

  it("(e) aria-live region is the same DOM node across multiple step changes", async () => {
    render(<Deck />);
    await navigateToArchSlide();

    const liveRegion = screen.getByRole("status");

    // Advance through several steps
    for (let i = 0; i < 4; i++) {
      await act(async () => { fireArrowRight(); });
      // The same DOM node must be present each time
      expect(screen.getByRole("status")).toBe(liveRegion);
    }
  });

  it("(e) arch-diagram root element is the same DOM node across step changes (no remount)", async () => {
    render(<Deck />);
    await navigateToArchSlide();

    const diagramRegion = screen.getByRole("region", { name: /Architecture Diagram/i });

    // Advance a few steps
    await act(async () => { fireArrowRight(); });
    await act(async () => { fireArrowRight(); });

    // Same DOM node
    expect(
      screen.getByRole("region", { name: /Architecture Diagram/i }),
    ).toBe(diagramRegion);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (f) body[data-arch-capturing] never set
  // ─────────────────────────────────────────────────────────────────────────

  it("(f) body[data-arch-capturing] never set throughout full traversal", async () => {
    render(<Deck />);
    const totalKeys = SLIDES.length + ARCH_DIAGRAM_STEP_COUNT + 2;
    for (let i = 0; i < totalKeys; i++) {
      await act(async () => { fireArrowRight(); });
      expect(document.body.getAttribute("data-arch-capturing")).toBeNull();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (g) jumpTo (numeric key) resets sub-step to 0
  // ─────────────────────────────────────────────────────────────────────────

  it("(g) key 1 jumps to slide 1 and Architecture sub-step resets to 0 on return", async () => {
    render(<Deck />);
    await navigateToArchSlide();

    // Advance a few sub-steps
    await act(async () => { fireArrowRight(); }); // step 1
    await act(async () => { fireArrowRight(); }); // step 2

    // Jump to slide 1
    await act(async () => { fireKey("1"); });
    expect(getCurrentSlide()).toBe(1);

    // Jump back to Architecture — sub-step should be reset to 0 (overview sidebar)
    await navigateToArchSlide();
    expect(screen.getByText(/to explore each service/i)).toBeInTheDocument();
    // Overview sidebar present (not the Explanation sidebar for steps > 0)
    expect(screen.getByRole("complementary", { name: /Diagram overview/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /Explanation/i })).toBeNull();
  });

  it("(g) after diagram traversal, key 1-9 navigation continues to work", async () => {
    render(<Deck />);
    await navigateToArchSlide();

    // Exhaust diagram + overshoot
    for (let i = 0; i < ARCH_DIAGRAM_STEP_COUNT + 1; i++) {
      await act(async () => { fireArrowRight(); });
    }

    // Jump to slide 1
    await act(async () => { fireKey("1"); });
    expect(getCurrentSlide()).toBe(1);

    // Jump to last slide
    await act(async () => { fireKey(String(SLIDES.length)); });
    expect(getCurrentSlide()).toBe(SLIDES.length);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // No zoom/canvas transform in the diagram
  // ─────────────────────────────────────────────────────────────────────────

  it("arch-canvas has no inline transform (no zoom-transform pattern)", async () => {
    const { container } = render(<Deck />);
    await navigateToArchSlide();
    await act(async () => { fireArrowRight(); }); // step 1

    // New Lucid SVG approach: .arch-canvas-wrap is the container (no .arch-canvas)
    const wrap = container.querySelector(".arch-canvas-wrap");
    expect(wrap).toBeInTheDocument();
    expect(wrap?.getAttribute("style") ?? "").not.toMatch(/translate|scale/i);
  });
});
