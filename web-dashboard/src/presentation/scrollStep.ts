/**
 * scrollStep.ts — Pure helpers for scrollytelling step selection and keyboard
 * navigation. Extracted from the prototype (ScrollProto) so the ScrollDeck
 * can import them without pulling the 108 KB SVG ?raw import into the bundle.
 *
 * These functions have no DOM or React dependencies — they are pure functions
 * that can be tested independently (see scroll-proto.test.ts).
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
