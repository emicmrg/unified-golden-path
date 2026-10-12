/**
 * useSpring.ts — Critically damped spring (damping = 1.0, zero overshoot).
 *
 * Uses the closed-form analytical solution of the critically damped oscillator:
 *   x(t) = target + (A + B·t)·e^(-ω·t)
 *   ẋ(t) = (B - ω·(A + B·t))·e^(-ω·t)
 * where ω = 2π / response and (A, B) are initialised from the current
 * presentation state (x, v) — so if target changes mid-animation the next
 * segment always starts from the *displayed* value, never from 0 or the old
 * target (Apple WWDC 2018 §3: "animate from the current value").
 *
 * References:
 *   - Designing Fluid Interfaces — WWDC 2018, §3, §4
 *   - apple-design skill: damping 1.0, response 0.3–0.4 for data UI
 *
 * Respects prefers-reduced-motion: returns target immediately without rAF.
 *
 * IMPORTANT — matchMedia is read only inside useEffect (never at render time)
 * so that the hook is safe in jsdom/test environments that do not implement it.
 */

import { useEffect, useRef, useState } from "react";

/**
 * @param target       The value to animate towards.
 * @param response     Approximate settling time in seconds (≈ 2π / ω). Default 0.35 s.
 * @param initialValue Starting value for the spring. When provided the spring animates
 *                     FROM initialValue TO target on the very first frame — this is the
 *                     key fix for FLIP open animations where the overlay must start at
 *                     the origin card scale, not at the target scale.
 *                     If omitted (undefined) the hook starts at `target`, preserving the
 *                     existing behaviour for springs that only receive mid-animation
 *                     target changes (e.g. progress-bar springs).
 * @returns            The current animated value (updated every rAF tick).
 */
export function useSpring(
  target: number,
  response = 0.35,
  initialValue?: number,
): number {
  // When initialValue is provided, start there; otherwise start at target
  // (legacy behaviour — no jump on first frame for non-FLIP springs).
  const startValue = initialValue !== undefined ? initialValue : target;
  const [value, setValue] = useState(startValue);

  // Internal mutable state: position (x) and velocity (v).
  // Stored in a ref so it persists across re-renders without causing them.
  // Initialise from startValue so the very first rAF tick animates FROM there.
  const state = useRef<{ x: number; v: number }>({ x: startValue, v: 0 });

  useEffect(() => {
    // Read prefers-reduced-motion INSIDE the effect so it never runs at
    // render time. Fallback to false in environments without matchMedia (jsdom).
    const reducedMotion =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;

    // Under reduced-motion: skip rAF entirely; snap to target immediately.
    if (reducedMotion) {
      state.current = { x: target, v: 0 };
      setValue(target);
      return;
    }

    const omega = (2 * Math.PI) / response; // angular frequency
    let lastTime = performance.now();
    let raf: number;

    function tick(now: number): void {
      // Clamp dt to 1/30 s to avoid a large "catch-up" jump when the tab was
      // hidden or the page was backgrounded.
      const dt = Math.min((now - lastTime) / 1000, 1 / 30);
      lastTime = now;

      const s = state.current;
      // Coefficients for the closed-form solution at t=0 (current presentation state)
      const A = s.x - target;
      const B = s.v + omega * A;
      const exp = Math.exp(-omega * dt);

      const nx = target + (A + B * dt) * exp;
      const nv = (B - omega * (A + B * dt)) * exp;

      s.x = nx;
      s.v = nv;
      setValue(nx);

      // Settle: stop the loop when both displacement and velocity are negligible.
      if (Math.abs(nx - target) < 0.001 && Math.abs(nv) < 0.001) {
        s.x = target;
        s.v = 0;
        setValue(target);
        return; // do NOT schedule the next frame
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, response]);

  return value;
}
