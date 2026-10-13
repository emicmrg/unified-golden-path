/**
 * scrollStep.ts — Pure helpers for scrollytelling step selection and keyboard
 * navigation. Extracted from the prototype (ScrollProto) so the ScrollDeck
 * can import them without pulling the 108 KB SVG ?raw import into the bundle.
 *
 * These functions have no DOM or React dependencies — they are pure functions
 * that can be tested independently (see scroll-step.test.ts).
 */

// ─────────────────────────────────────────────────────────────────────────────
// selectStep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * selectStep — center-distance step selection with hysteresis deadband.
 *
 * Given an array of distances from the viewport center to each step's center,
 * returns the index of the step that should become active.  The current
 * committed step is retained unless the best candidate beats it by more than
 * `deadband` pixels, which prevents oscillation between adjacent steps during
 * slow/continuous scrolling.
 *
 * @param distances   Distance from viewport center to each step center (px).
 * @param committed   Previously committed step index.
 * @param deadband    Hysteresis in pixels (default 40).
 */
export function selectStep(
  distances: number[],
  committed: number,
  deadband: number = 40,
): number {
  if (distances.length === 0) return committed;

  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < distances.length; i++) {
    if (distances[i] < bestDist) {
      bestDist = distances[i];
      bestIdx = i;
    }
  }

  if (bestIdx === committed) return committed;

  const prevDist = distances[committed] ?? Infinity;
  if (bestDist < prevDist - deadband) {
    return bestIdx;
  }
  return committed;
}

// ─────────────────────────────────────────────────────────────────────────────
// navigateStep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * navigateStep — pure keyboard step navigation.
 *
 * Given the current targetStep, a key string, and the total number of steps,
 * returns the next target step (or null when the key is not handled).
 */
export function navigateStep(
  current: number,
  key: string,
  stepCount: number,
): number | null {
  const last = stepCount - 1;
  if (key === "ArrowDown" || key === "ArrowRight" || key === " ") {
    return Math.min(current + 1, last);
  }
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return Math.max(current - 1, 0);
  }
  if (key === "Home") return 0;
  if (key === "End") return last;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// selectSection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * selectSection — deterministic active-section detection by viewport-center
 * containment.
 *
 * PRIMARY RULE: the active section is the one whose bounding rect CONTAINS
 * the viewport center (rect.top <= mid < rect.bottom, where mid = viewportHeight/2).
 * Because sections are laid out contiguously with no gaps, exactly one section
 * always contains the center.  This is height-independent and always produces
 * the correct result regardless of the disparate heights of diagram sections
 * (e.g. architecture 8 steps × 95 vh vs agents 6 steps × 95 vh).
 *
 * FALLBACK: if no section contains the center (edge of scroll range where the
 * page is not yet fully scrolled), fall back to the section whose center is
 * closest to the viewport center — identical to the old closest-center
 * heuristic but only used as a last resort.
 *
 * @param rects         Array of {top, bottom} bounding-rect values (px,
 *                      viewport-relative — as returned by getBoundingClientRect).
 * @param viewportHeight  Current window.innerHeight (px).
 * @returns             Index of the active section (0-based).
 */
export function selectSection(
  rects: { top: number; bottom: number }[],
  viewportHeight: number,
): number {
  if (rects.length === 0) return 0;

  const mid = viewportHeight / 2;

  // Primary: containment — O(n), always correct for contiguous sections.
  for (let i = 0; i < rects.length; i++) {
    const { top, bottom } = rects[i];
    if (top <= mid && mid < bottom) {
      return i;
    }
  }

  // Fallback: closest center (edge of scroll range, no section contains mid).
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const center = (rects[i].top + rects[i].bottom) / 2;
    const dist = Math.abs(center - mid);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}
