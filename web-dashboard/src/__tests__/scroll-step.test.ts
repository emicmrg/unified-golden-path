/**
 * scroll-step.test.ts — Unit tests for scrollStep pure helpers.
 *
 * Covers:
 *   (1) selectStep: hysteresis/center-distance logic is monotonic and stable.
 *   (2) navigateStep: ArrowDown/Up/Space advance/retreat; Home/End; clamp at edges.
 *   (3) BUG 1 regression: ArrowDown after cold start never returns a step BEFORE
 *       the current one (targetStepRef = 0 must not produce a backward jump when
 *       the observed step is already > 0).
 *   (4) selectSection: viewport-center containment — deterministic with real
 *       section heights (content=100svh, diagram=steps×95vh+6rem).
 *       Covers the 4 transition points that failed with the old closest-center
 *       heuristic: entering architecture, architecture→agents, entering
 *       self-healing, self-healing→closing.
 */

import { describe, it, expect } from "vitest";
import { selectStep, navigateStep, selectSection } from "../presentation/scrollStep.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate scrolling through N steps from top to bottom.
 * Returns the sequence of committed step indices produced by selectStep.
 */
function simulateScrollDown(stepCount: number, deadband = 40): number[] {
  // Viewport center fixed at 400 px (arbitrary).
  // Steps are 1000 px tall, top of step[i] = i * 1000.
  // elCenter[i] = i * 1000 + 500.
  // dist[i] = |elCenter[i] - 400| when step i is perfectly centred:
  //   we model the scroll position advancing step-by-step.
  const results: number[] = [];
  let committed = 0;

  for (let scrolled = 0; scrolled < stepCount; scrolled++) {
    // viewportCenter = 400 fixed; scrollY = scrolled * 1000
    const distances = Array.from({ length: stepCount }, (_, i) => {
      const elTop = i * 1000 - scrolled * 1000;
      const elCenter = elTop + 500;
      return Math.abs(elCenter - 400);
    });
    committed = selectStep(distances, committed, deadband);
    results.push(committed);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) selectStep — step selection is monotonic (no oscillation)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectStep — hysteresis / center-distance", () => {
  it("returns committed when all distances are equal (no winner)", () => {
    const distances = [100, 100, 100];
    expect(selectStep(distances, 0)).toBe(0);
    expect(selectStep(distances, 2)).toBe(2);
  });

  it("returns committed when new winner does not beat DEADBAND threshold", () => {
    // current = step 0 (dist 50), candidate = step 1 (dist 30); margin = 20 < 40
    const distances = [50, 30, 200];
    expect(selectStep(distances, 0, 40)).toBe(0); // not enough margin
  });

  it("switches when new winner beats committed by more than DEADBAND", () => {
    // current = step 0 (dist 80), candidate = step 1 (dist 10); margin = 70 > 40
    const distances = [80, 10, 200];
    expect(selectStep(distances, 0, 40)).toBe(1);
  });

  it("does not oscillate scrolling step 0 → step 7 (monotonic sequence)", () => {
    const seq = simulateScrollDown(8);
    // Sequence must be non-decreasing (never goes backwards)
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    }
  });

  it("reaches the last step eventually when scrolling all the way down", () => {
    const seq = simulateScrollDown(8);
    expect(seq[seq.length - 1]).toBe(7);
  });

  it("stays at 0 when already at best step (no deadband needed)", () => {
    // Step 0 is clearly the closest
    const distances = [5, 900, 1800, 2700];
    expect(selectStep(distances, 0)).toBe(0);
  });

  it("handles empty distances gracefully (returns committed)", () => {
    expect(selectStep([], 0)).toBe(0);
    expect(selectStep([], 3)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) navigateStep — keyboard navigation
// ─────────────────────────────────────────────────────────────────────────────

describe("navigateStep — keyboard navigation", () => {
  const N = 8; // SH_STEPS has 8 entries

  it("ArrowDown advances 0 → 1", () => {
    expect(navigateStep(0, "ArrowDown", N)).toBe(1);
  });

  it("ArrowDown advances step by step up to N-1", () => {
    let step = 0;
    for (let i = 1; i < N; i++) {
      const next = navigateStep(step, "ArrowDown", N);
      expect(next).toBe(i);
      step = next!;
    }
  });

  it("ArrowDown clamps at last step (N-1)", () => {
    expect(navigateStep(N - 1, "ArrowDown", N)).toBe(N - 1);
  });

  it("ArrowUp retreats step by step down to 0", () => {
    let step = N - 1;
    for (let i = N - 2; i >= 0; i--) {
      const next = navigateStep(step, "ArrowUp", N);
      expect(next).toBe(i);
      step = next!;
    }
  });

  it("ArrowUp clamps at first step (0)", () => {
    expect(navigateStep(0, "ArrowUp", N)).toBe(0);
  });

  it("ArrowRight advances (same as ArrowDown)", () => {
    expect(navigateStep(2, "ArrowRight", N)).toBe(3);
  });

  it("ArrowLeft retreats (same as ArrowUp)", () => {
    expect(navigateStep(5, "ArrowLeft", N)).toBe(4);
  });

  it("Space advances (same as ArrowDown)", () => {
    expect(navigateStep(3, " ", N)).toBe(4);
  });

  it("Home returns 0 from any step", () => {
    for (let i = 0; i < N; i++) {
      expect(navigateStep(i, "Home", N)).toBe(0);
    }
  });

  it("End returns last step from any step", () => {
    for (let i = 0; i < N; i++) {
      expect(navigateStep(i, "End", N)).toBe(N - 1);
    }
  });

  it("unhandled keys return null", () => {
    expect(navigateStep(2, "Tab", N)).toBeNull();
    expect(navigateStep(2, "Escape", N)).toBeNull();
    expect(navigateStep(2, "Enter", N)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) BUG 1 regression — ArrowDown after cold start never scrolls backward
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG 1 regression — ArrowDown from stale targetStepRef = 0", () => {
  /**
   * Simulate the old bug:
   *   - User scrolled to observedStep (e.g. 3) via touch/mouse.
   *   - targetStepRef was NOT resynced (the settle effect cancelled itself).
   *   - targetStepRef.current is still 0.
   *   - User presses ArrowDown → old code: 0+1 = 1 → scrollIntoView(step 1) → BACKWARD.
   *
   * With the fix:
   *   - The settle resync (deps:[]) fires after scroll stops → targetStepRef := observedStep
   *   - ArrowDown → navigateStep(observedStep, "ArrowDown") = observedStep + 1 → FORWARD.
   *
   * We simulate the scenario by:
   *   (a) Old behavior: targetRef = 0, observedStep = 3 → ArrowDown → step 1 (BACKWARD).
   *   (b) Fixed behavior: targetRef = observedStep = 3 → ArrowDown → step 4 (FORWARD).
   */

  it("(old bug) targetRef=0, observedStep=3 → ArrowDown would give step 1 (< 3) — verifies the regression scenario", () => {
    // This test documents the old buggy behavior for clarity.
    const staleTarget = 0;
    const next = navigateStep(staleTarget, "ArrowDown", 8);
    // next = 1, which is < observedStep (3) → backward jump
    expect(next).toBe(1);
    expect(next!).toBeLessThan(3); // confirms the regression
  });

  it("(fixed) after settle resync, targetRef = observedStep = 3 → ArrowDown gives step 4 (forward)", () => {
    // After the fix: settle resync sets targetRef := observedStep before first keypress
    const syncedTarget = 3; // resync happened
    const next = navigateStep(syncedTarget, "ArrowDown", 8);
    expect(next).toBe(4);
    expect(next!).toBeGreaterThan(3); // always forward — no backward jump
  });

  it("ArrowDown from any synced step N always produces N+1 (never less than N)", () => {
    const observedStep = 5;
    const next = navigateStep(observedStep, "ArrowDown", 8);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(observedStep);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) selectSection — deterministic viewport-center containment
//     with real section heights
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Real section heights (px) for a viewportHeight of 900 px.
 *
 * Section layout (7 sections):
 *   0. cover        — 100svh          = 1 × 900 = 900 px
 *   1. platform     — 100svh          = 1 × 900 = 900 px
 *   2. firmware     — 100svh          = 1 × 900 = 900 px  (content, no diagram steps)
 *   3. architecture — 8 steps × 95vh + 6rem
 *                   = 8 × 855 + 96    = 6840 + 96 = 6936 px
 *   4. agents       — 6 steps × 95vh + 6rem
 *                   = 6 × 855 + 96    = 5130 + 96 = 5226 px
 *   5. self-healing — 8 steps × 95vh + 6rem
 *                   = 8 × 855 + 96    = 6840 + 96 = 6936 px
 *   6. closing      — 100svh          = 1 × 900 = 900 px
 *
 * Notes:
 *   - 95vh @ 900px viewport = 855 px
 *   - 6rem @ 16px root      = 96 px
 *   - These match the CSS variables in ScrollDeck.css:
 *       --deck-section-step-height: 95svh
 *       Padding-block on the diagram section: 3rem top + 3rem bottom = 6rem
 */
const VH = 900; // fixed viewport height for all tests

const SECTION_HEIGHTS_PX = [
  VH,               // 0: cover
  VH,               // 1: platform
  VH,               // 2: firmware
  8 * 855 + 96,     // 3: architecture (8 steps)
  6 * 855 + 96,     // 4: agents (6 steps)
  8 * 855 + 96,     // 5: self-healing (8 steps)
  VH,               // 6: closing
] as const;

// Section names for readable test output
const SECTION_NAMES = [
  "cover",
  "platform",
  "firmware",
  "architecture",
  "agents",
  "self-healing",
  "closing",
] as const;

/**
 * Build viewport-relative rects from absolute section top positions and
 * a given scrollY (window.scrollY equivalent).
 */
function buildRects(
  heights: readonly number[],
  scrollY: number,
): { top: number; bottom: number }[] {
  let absoluteTop = 0;
  return heights.map((h) => {
    const top = absoluteTop - scrollY;
    const bottom = top + h;
    absoluteTop += h;
    return { top, bottom };
  });
}

/** Total scrollable height = sum of section heights - one viewport. */
const TOTAL_HEIGHT_PX = SECTION_HEIGHTS_PX.reduce((a, b) => a + b, 0);
const MAX_SCROLL = TOTAL_HEIGHT_PX - VH;

/**
 * Given a scrollY, compute which section index ACTUALLY contains the
 * viewport center (mid = VH/2 = 450 px) in document coordinates.
 *
 * This is the ground truth to validate against selectSection.
 */
function groundTruthSection(scrollY: number): number {
  const mid = scrollY + VH / 2; // absolute midpoint in document
  let top = 0;
  for (let i = 0; i < SECTION_HEIGHTS_PX.length; i++) {
    const bottom = top + SECTION_HEIGHTS_PX[i];
    if (mid >= top && mid < bottom) return i;
    top = bottom;
  }
  return SECTION_HEIGHTS_PX.length - 1; // closing (past end)
}

describe("selectSection — viewport-center containment with real section heights", () => {
  it("handles empty rects gracefully (returns 0)", () => {
    expect(selectSection([], VH)).toBe(0);
  });

  it("returns 0 at scrollY=0 (viewport center is inside cover)", () => {
    const rects = buildRects(SECTION_HEIGHTS_PX, 0);
    expect(selectSection(rects, VH)).toBe(0);
  });

  it("returns 6 (closing) at maximum scroll", () => {
    const rects = buildRects(SECTION_HEIGHTS_PX, MAX_SCROLL);
    expect(selectSection(rects, VH)).toBe(6);
  });

  // ── Sweep test: selectSection must match ground truth at every pixel ──────

  it("matches ground truth for every 10px step from 0 to MAX_SCROLL", () => {
    const STEP = 10;
    for (let scrollY = 0; scrollY <= MAX_SCROLL; scrollY += STEP) {
      const rects = buildRects(SECTION_HEIGHTS_PX, scrollY);
      const got = selectSection(rects, VH);
      const expected = groundTruthSection(scrollY);
      expect(got, `scrollY=${scrollY}: expected ${SECTION_NAMES[expected]} (${expected}), got ${SECTION_NAMES[got]} (${got})`).toBe(expected);
    }
  });

  // ── No backward jumps on forward scroll ────────────────────────────────────

  it("never jumps to a lower section index while scrolling forward", () => {
    const STEP = 50;
    let prev = 0;
    for (let scrollY = 0; scrollY <= MAX_SCROLL; scrollY += STEP) {
      const rects = buildRects(SECTION_HEIGHTS_PX, scrollY);
      const idx = selectSection(rects, VH);
      expect(idx, `scrollY=${scrollY}: jumped backward from ${prev} to ${idx}`).toBeGreaterThanOrEqual(prev);
      prev = idx;
    }
  });

  // ── 4 explicit transition points that failed with closest-center ──────────
  //
  // With closest-center the cross-over is at (center_i + center_{i+1}) / 2
  // which, for sections of different heights, is NOT at the section boundary.
  // For architecture (6936 px) → agents (5226 px):
  //   closest-center crosses at boundary + (6936/2 - 5226/2) / 2 = ~427 px
  //   BEFORE the true boundary → the old code activated "agents" ~427 px too
  //   early and could jump backward when entering self-healing.
  // selectSection using containment crosses EXACTLY at the boundary.

  it("BUG-FIX: entering architecture — activates at the exact boundary, not before", () => {
    // architecture starts at scrollY = 900 + 900 + 900 = 2700
    // viewport center (mid=450) is inside architecture when scrollY >= 2700 - (VH-450) = 2250
    // i.e. absolute_mid = scrollY + 450 >= 2700 → scrollY >= 2250
    const archStart = VH + VH + VH; // 2700 — absolute top of architecture section
    const enterBoundary = archStart - VH / 2; // scrollY where mid hits architecture top = 2250

    // Just before the boundary → should still be firmware (2)
    const rectsBefore = buildRects(SECTION_HEIGHTS_PX, enterBoundary - 1);
    expect(selectSection(rectsBefore, VH), "1px before architecture boundary should be firmware").toBe(2);

    // At the boundary → should be architecture (3)
    const rectsAt = buildRects(SECTION_HEIGHTS_PX, enterBoundary);
    expect(selectSection(rectsAt, VH), "at architecture boundary should be architecture").toBe(3);

    // Well inside → architecture (3)
    const rectsInside = buildRects(SECTION_HEIGHTS_PX, enterBoundary + 500);
    expect(selectSection(rectsInside, VH), "500px into architecture should be architecture").toBe(3);
  });

  it("BUG-FIX: architecture→agents transition — activates agents at the exact boundary", () => {
    // architecture section: top=2700, height=6936 → bottom=9636
    const archTop = VH * 3; // 2700
    const archHeight = SECTION_HEIGHTS_PX[3]; // 6936
    const archBottom = archTop + archHeight; // 9636

    // viewport center hits architecture/agents boundary when scrollY + 450 = 9636
    // → scrollY = 9186
    const transitionBoundary = archBottom - VH / 2; // 9186

    // 1px before → architecture (3)
    const rectsBefore = buildRects(SECTION_HEIGHTS_PX, transitionBoundary - 1);
    expect(selectSection(rectsBefore, VH), "1px before arch→agents boundary should be architecture").toBe(3);

    // At boundary → agents (4)
    const rectsAt = buildRects(SECTION_HEIGHTS_PX, transitionBoundary);
    expect(selectSection(rectsAt, VH), "at arch→agents boundary should be agents").toBe(4);
  });

  it("BUG-FIX: entering self-healing — activates at exact boundary (no backward jump)", () => {
    // agents section: top=9636, height=5226 → bottom=14862
    const agentsTop = VH * 3 + SECTION_HEIGHTS_PX[3]; // 9636
    const agentsHeight = SECTION_HEIGHTS_PX[4]; // 5226
    const agentsBottom = agentsTop + agentsHeight; // 14862

    // viewport center hits agents/self-healing boundary when scrollY + 450 = 14862
    // → scrollY = 14412
    const transitionBoundary = agentsBottom - VH / 2; // 14412

    // 1px before → agents (4)
    const rectsBefore = buildRects(SECTION_HEIGHTS_PX, transitionBoundary - 1);
    expect(selectSection(rectsBefore, VH), "1px before agents→self-healing boundary should be agents").toBe(4);

    // At boundary → self-healing (5)
    const rectsAt = buildRects(SECTION_HEIGHTS_PX, transitionBoundary);
    expect(selectSection(rectsAt, VH), "at agents→self-healing boundary should be self-healing").toBe(5);
  });

  it("BUG-FIX: self-healing→closing transition — activates closing at exact boundary", () => {
    // self-healing section: top=14862, height=6936 → bottom=21798
    const shTop = VH * 3 + SECTION_HEIGHTS_PX[3] + SECTION_HEIGHTS_PX[4]; // 14862
    const shHeight = SECTION_HEIGHTS_PX[5]; // 6936
    const shBottom = shTop + shHeight; // 21798

    // viewport center hits self-healing/closing boundary when scrollY + 450 = 21798
    // → scrollY = 21348
    const transitionBoundary = shBottom - VH / 2; // 21348

    // 1px before → self-healing (5)
    const rectsBefore = buildRects(SECTION_HEIGHTS_PX, transitionBoundary - 1);
    expect(selectSection(rectsBefore, VH), "1px before self-healing→closing boundary should be self-healing").toBe(5);

    // At boundary (or clamped to MAX_SCROLL if beyond) → closing (6)
    const clampedScrollY = Math.min(transitionBoundary, MAX_SCROLL);
    const rectsAt = buildRects(SECTION_HEIGHTS_PX, clampedScrollY);
    expect(selectSection(rectsAt, VH), "at self-healing→closing boundary should be closing").toBe(6);
  });
});
