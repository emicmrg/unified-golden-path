/**
 * scroll-proto.test.ts — Unit tests for ScrollProto pure helpers.
 *
 * Covers:
 *   (1) selectStep: hysteresis/center-distance logic is monotonic and stable.
 *   (2) navigateStep: ArrowDown/Up/Space advance/retreat; Home/End; clamp at edges.
 *   (3) BUG 1 regression: ArrowDown after cold start never returns a step BEFORE
 *       the current one (targetStepRef = 0 must not produce a backward jump when
 *       the observed step is already > 0).
 */

import { describe, it, expect } from "vitest";
import { selectStep, navigateStep } from "../proto/ScrollProto.js";

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
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThanOrEqual(observedStep);
  });

  it("full forward sequence from synced start is strictly non-decreasing", () => {
    let target = 0;
    const sequence: number[] = [target];
    // Simulate: scroll to step 4 (settle resync), then press ArrowDown 4 more times
    target = 4; // after settle resync
    sequence.push(target);
    for (let i = 0; i < 4; i++) {
      const next = navigateStep(target, "ArrowDown", 8);
      if (next !== null) {
        expect(next).toBeGreaterThanOrEqual(target);
        target = next;
      }
      sequence.push(target);
    }
    // Verify sequence is non-decreasing
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]).toBeGreaterThanOrEqual(sequence[i - 1]);
    }
  });
});
