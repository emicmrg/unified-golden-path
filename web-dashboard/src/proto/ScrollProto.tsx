/**
 * ScrollProto.tsx — Scrollytelling prototype with 6 highlight variants (A, B, C, C1, C2, C3).
 *
 * Access: ?proto=scroll in the URL
 *
 * ARCHITECTURE — MODEL A (full-page scroll):
 *   The PAGE (document / window) is the scroller.
 *   The diagram is pinned STICKY in the viewport (position:sticky) while the
 *   8 step blocks (SH_STEPS) flow in the document scroll, each ~90-100vh tall.
 *   IntersectionObserver root = viewport (null), no nested scroller.
 *   Step selection: center-distance + 40 px hysteresis deadband (rAF-throttled).
 *   Scroll-snap: scroll-snap-type: y proximity on the section wrapper, each step
 *   block has scroll-snap-align: start. PROXIMITY (not mandatory) avoids trapping.
 *   No nested scroller, no scroll chaining, no overscroll-behavior on inner box.
 *
 * VARIANTS:
 *   A  — Desaturate/dim: two <img> layers; active area revealed via clip-path.
 *   B  — Camera zoom/pan: transform scale+translate with critically-damped spring.
 *   C  — Halo ring (original): DOM ring over active bbox.
 *   C1 — Soft halo, no outline [DEFINITIVE]: diffuse box-shadow glow + scale 1.02 spring.
 *        Model A hardened: full-page scroll, viewport IntersectionObserver,
 *        center-distance hysteresis, deterministic keyboard nav (targetStepRef),
 *        cross-fade halo (opacity-only, no position transition), reduced-motion safe.
 *   C2 — Soft halo + dim: C1 plus background desaturation.
 *   C3 — Inline SVG highlight: <rect> in viewBox coords; zero DOM offset error.
 *
 * REDUCED-MOTION (B1 FIXED):
 *   @media (prefers-reduced-motion: reduce) block is placed AFTER all base C1
 *   rules so it wins on equal specificity. With reduced-motion: no scroll-snap,
 *   no scroll-behavior:smooth, no cross-fade / halo transforms, static layout.
 *
 * MOBILE (B2 FIXED):
 *   @media (max-width: 48rem) is placed AFTER base rules. Diagram goes sticky
 *   at the top, text flows beneath it in a single column. No nested scroll.
 *
 * KEYBOARD (B3 FIXED → deterministic, no-click required):
 *   window keydown listener gated by isVisible (C1 section in viewport).
 *   No click required — works on first keypress after section enters view.
 *   Ignores events in INPUT/TEXTAREA/SELECT/[contenteditable].
 *   targetStepRef advances immediately on each press (deterministic, auto-repeat safe).
 *   activeStepRef mirrors the observed activeStep (updated in a deps:[activeStep] effect).
 *   Settle resync: window 'scrollend' event + 150 ms debounce fallback, registered ONCE
 *   (deps:[]) so cleanup never cancels a pending debounce on step commit.
 *   ArrowDown/Up/Space clamp(target ± 1), Home, End; scrollIntoView on change.
 *
 * HALO CROSS-FADE (B4 FIXED):
 *   Position transitions REMOVED from .proto-soft-halo-glow. Incoming buffer is
 *   positioned first (no transition), reflow forced, then opacity swapped so the
 *   new glow fades in at its correct location without sliding from the old one.
 *
 * CONTRAST (B5 FIXED):
 *   Keyboard hint uses --c-muted (#525252) at full opacity (was 0.65 → ~3.2:1,
 *   now 1.0 → 5.9:1 AA+). Active state uses --c-accent.
 *
 * ACCESSIBILITY:
 *   - aria-live region announces the step NAME (not "Paso 0").
 *   - aria-label on keyboard region uses English and lists actual keys.
 *   - All copy unified to English.
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  SH_FOCUS_BOXES,
  SH_STEPS,
  SH_SVG_VB_H,
  SH_SVG_VB_W,
  SelfHealingSubStepContext,
} from "../presentation/SelfHealingDiagram.js";
import type { BBox } from "../presentation/ArchitectureDiagram.js";

import selfHealingFlowSvgUrl from "../presentation/assets/self-healing-flow.svg";
// Raw SVG text for C3 inline variant (Vite ?raw import — no img-src CSP issue)
import selfHealingFlowSvgRaw from "../presentation/assets/self-healing-flow.svg?raw";
import "./ScrollProto.css";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Variant = "A" | "B" | "C" | "C1" | "C2" | "C3";

interface VariantMeta {
  id: Variant;
  label: string;
  title: string;
  desc: string;
}

const VARIANTS: VariantMeta[] = [
  {
    id: "A",
    label: "A",
    title: "Desaturate / Dim",
    desc: "Active group stays in color; the rest desaturates and dims. No dark scrim.",
  },
  {
    id: "B",
    label: "B",
    title: "Camera Zoom / Pan",
    desc: "Diagram zooms and pans with a spring toward the active bbox, like a camera.",
  },
  {
    id: "C",
    label: "C — original",
    title: "Halo Ring",
    desc: "DOM ring with Slalom Blue border over the bbox. May mis-align 2-3 px (see C1/C2).",
  },
  {
    id: "C1",
    label: "C1",
    title: "Soft Halo — no outline",
    desc: "Diffuse glow (large box-shadow) + scale 1.02. No hard border; forgives bbox imprecision.",
  },
  {
    id: "C2",
    label: "C2",
    title: "Soft Halo + Dim",
    desc: "C1 with light background desaturation. Double focus signal; halo precision matters less.",
  },
  {
    id: "C3",
    label: "C3",
    title: "Inline SVG highlight",
    desc: "Inline SVG: <rect> highlight in viewBox coords. Perfect scaling, impossible to mis-align.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hook: critically-damped spring (inline, no external dep)
// Identical physics to hooks/useSpring.ts — inlined to keep the proto self-contained.
// ─────────────────────────────────────────────────────────────────────────────

function useSpringValue(target: number, response = 0.36): number {
  const [value, setValue] = useState(target);
  const state = useRef<{ x: number; v: number }>({ x: target, v: 0 });

  useEffect(() => {
    const reducedMotion =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;

    if (reducedMotion) {
      state.current = { x: target, v: 0 };
      setValue(target);
      return;
    }

    const omega = (2 * Math.PI) / response;
    let lastTime = performance.now();
    let raf: number;

    function tick(now: number): void {
      const dt = Math.min((now - lastTime) / 1000, 1 / 30);
      lastTime = now;
      const s = state.current;
      const A = s.x - target;
      const B = s.v + omega * A;
      const exp = Math.exp(-omega * dt);
      const nx = target + (A + B * dt) * exp;
      const nv = (B - omega * (A + B * dt)) * exp;
      s.x = nx;
      s.v = nv;
      setValue(nx);
      if (Math.abs(nx - target) < 0.001 && Math.abs(nv) < 0.001) {
        s.x = target;
        s.v = 0;
        setValue(target);
        return;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, response]);

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: project a viewBox BBox into DOM canvas coordinates
// ─────────────────────────────────────────────────────────────────────────────

interface DOMRect4 {
  left: number;
  top: number;
  width: number;
  height: number;
}

function projectBBox(
  bbox: BBox,
  canvasEl: HTMLElement | null,
): DOMRect4 | null {
  if (!canvasEl) return null;
  const cw = canvasEl.clientWidth;
  const ch = canvasEl.clientHeight;
  if (cw === 0 || ch === 0) return null;

  const imgAspect = SH_SVG_VB_W / SH_SVG_VB_H;
  const canvasAspect = cw / ch;

  let renderedW: number;
  let renderedH: number;
  let offsetX: number;
  let offsetY: number;

  if (imgAspect > canvasAspect) {
    renderedW = cw;
    renderedH = cw / imgAspect;
    offsetX = 0;
    offsetY = (ch - renderedH) / 2;
  } else {
    renderedH = ch;
    renderedW = ch * imgAspect;
    offsetX = (cw - renderedW) / 2;
    offsetY = 0;
  }

  const scaleX = renderedW / SH_SVG_VB_W;
  const scaleY = renderedH / SH_SVG_VB_H;

  return {
    left: offsetX + bbox.x * scaleX,
    top: offsetY + bbox.y * scaleY,
    width: bbox.w * scaleX,
    height: bbox.h * scaleY,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant A — Desaturate / Dim
// ─────────────────────────────────────────────────────────────────────────────

function VariantADesaturate({
  activeStep,
  canvasRef,
}: {
  activeStep: number;
  canvasRef: React.RefObject<HTMLDivElement>;
}): React.ReactElement {
  const bbox = SH_FOCUS_BOXES[activeStep] ?? null;
  const isOverview = bbox === null;

  const [clipPath, setClipPath] = useState<string>("inset(0 0 0 0)");

  useEffect(() => {
    if (isOverview || !canvasRef.current) {
      setClipPath("inset(0 0 0 0)");
      return;
    }
    const canvas = canvasRef.current;
    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const { left, top, width, height } = projected;
    const PAD = 10;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;

    const t = Math.max(0, top - PAD);
    const r = Math.max(0, cw - (left + width + PAD));
    const b = Math.max(0, ch - (top + height + PAD));
    const l = Math.max(0, left - PAD);

    setClipPath(`inset(${t}px ${r}px ${b}px ${l}px round 12px)`);
  }, [activeStep, bbox, isOverview, canvasRef]);

  return (
    <div
      className="proto-canvas proto-canvas--desaturate"
      ref={canvasRef}
      aria-hidden="true"
    >
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-desat-layer"
        draggable={false}
        aria-hidden="true"
      />
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-desat-active"
        draggable={false}
        aria-hidden="true"
        style={{
          clipPath: isOverview ? "inset(0 0 0 0)" : clipPath,
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant B — Camera Zoom / Pan
// ─────────────────────────────────────────────────────────────────────────────

interface CameraTarget {
  scale: number;
  tx: number;
  ty: number;
}

function computeCamera(
  bbox: BBox | null,
  canvasEl: HTMLElement | null,
  margin = 0.18,
): CameraTarget {
  if (!bbox || !canvasEl) return { scale: 1, tx: 0, ty: 0 };

  const cw = canvasEl.clientWidth;
  const ch = canvasEl.clientHeight;
  if (cw === 0 || ch === 0) return { scale: 1, tx: 0, ty: 0 };

  const imgAspect = SH_SVG_VB_W / SH_SVG_VB_H;
  const canvasAspect = cw / ch;

  let renderedW: number, renderedH: number, offsetX: number, offsetY: number;
  if (imgAspect > canvasAspect) {
    renderedW = cw;
    renderedH = cw / imgAspect;
    offsetX = 0;
    offsetY = (ch - renderedH) / 2;
  } else {
    renderedH = ch;
    renderedW = ch * imgAspect;
    offsetX = (cw - renderedW) / 2;
    offsetY = 0;
  }

  const scaleX = renderedW / SH_SVG_VB_W;
  const scaleY = renderedH / SH_SVG_VB_H;

  const bboxCenterX = offsetX + (bbox.x + bbox.w / 2) * scaleX;
  const bboxCenterY = offsetY + (bbox.y + bbox.h / 2) * scaleY;

  const bboxDomW = bbox.w * scaleX;
  const bboxDomH = bbox.h * scaleY;
  const scaleNeeded = Math.min(
    (cw * (1 - margin)) / bboxDomW,
    (ch * (1 - margin)) / bboxDomH,
    3.2,
  );

  const tx = -scaleNeeded * (bboxCenterX - cw / 2);
  const ty = -scaleNeeded * (bboxCenterY - ch / 2);

  return { scale: scaleNeeded, tx, ty };
}

function VariantBZoom({
  activeStep,
  canvasRef,
}: {
  activeStep: number;
  canvasRef: React.RefObject<HTMLDivElement>;
}): React.ReactElement {
  const bbox = SH_FOCUS_BOXES[activeStep] ?? null;

  const [camera, setCamera] = useState<CameraTarget>({ scale: 1, tx: 0, ty: 0 });

  const recompute = useCallback(() => {
    if (!canvasRef.current) return;
    setCamera(computeCamera(bbox, canvasRef.current));
  }, [bbox, canvasRef]);

  useEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasRef, recompute]);

  const springScale = useSpringValue(camera.scale, 0.5);
  const springTx = useSpringValue(camera.tx, 0.5);
  const springTy = useSpringValue(camera.ty, 0.5);

  const transform =
    `translate(${springTx.toFixed(2)}px, ${springTy.toFixed(2)}px) scale(${springScale.toFixed(4)})`;

  const ringRef = useRef<HTMLDivElement>(null);
  const isOverview = bbox === null;

  useEffect(() => {
    const ring = ringRef.current;
    const canvas = canvasRef.current;
    if (!ring || !canvas || isOverview) return;

    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const PAD = 6;
    ring.style.left = `${projected.left - PAD}px`;
    ring.style.top = `${projected.top - PAD}px`;
    ring.style.width = `${projected.width + PAD * 2}px`;
    ring.style.height = `${projected.height + PAD * 2}px`;
  }, [activeStep, bbox, isOverview, canvasRef]);

  return (
    <div
      className="proto-canvas proto-canvas--zoom"
      ref={canvasRef}
      aria-hidden="true"
    >
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-zoom-img"
        draggable={false}
        aria-hidden="true"
        style={{ transform }}
      />
      <div
        ref={ringRef}
        className="proto-zoom-ring"
        data-hidden={isOverview ? "true" : "false"}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant C — Halo ring (original — kept for comparison)
// ─────────────────────────────────────────────────────────────────────────────

function VariantCHalo({
  activeStep,
  canvasRef,
}: {
  activeStep: number;
  canvasRef: React.RefObject<HTMLDivElement>;
}): React.ReactElement {
  const bbox = SH_FOCUS_BOXES[activeStep] ?? null;
  const isOverview = bbox === null;

  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ring = ringRef.current;
    const canvas = canvasRef.current;
    if (!ring || !canvas || isOverview) {
      if (ring) ring.dataset.hidden = "true";
      return;
    }

    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const PAD = 8;
    ring.style.left = `${projected.left - PAD}px`;
    ring.style.top = `${projected.top - PAD}px`;
    ring.style.width = `${projected.width + PAD * 2}px`;
    ring.style.height = `${projected.height + PAD * 2}px`;
    ring.dataset.hidden = "false";
  }, [activeStep, bbox, isOverview, canvasRef]);

  return (
    <div
      className="proto-canvas proto-canvas--halo"
      ref={canvasRef}
      aria-hidden="true"
    >
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-halo-img"
        draggable={false}
        aria-hidden="true"
        data-has-active={isOverview ? "false" : "true"}
      />
      <div
        ref={ringRef}
        className="proto-halo-ring"
        data-hidden="true"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant C1 — Soft halo, no outline  [DEFINITIVE VARIANT — Model A hardened]
//
// B4 FIX: Position transitions are REMOVED from the glow element. The incoming
// buffer is positioned first (style assignment = no CSS transition), then a
// forced synchronous reflow (el.offsetHeight read) ensures the browser commits
// the position before the opacity transition fires. This eliminates the diagonal
// slide from the old position.
//
// Cross-fade with no position slide:
//   1. Position incoming buffer at new bbox (no transition — instant).
//   2. Force reflow to commit position.
//   3. Set data-hidden="false" on incoming → opacity: 0 → 1 (CSS transition).
//   4. Set data-hidden="true" on outgoing  → opacity: 1 → 0 (CSS transition).
// ─────────────────────────────────────────────────────────────────────────────

interface GlowPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

function VariantC1SoftHalo({
  activeStep,
  canvasRef,
}: {
  activeStep: number;
  canvasRef: React.RefObject<HTMLDivElement>;
}): React.ReactElement {
  const bbox = SH_FOCUS_BOXES[activeStep] ?? null;
  const isOverview = bbox === null;

  // Spring scale: 1.02 when active, 1 when overview
  const scaleTarget = isOverview ? 1 : 1.02;
  const springScale = useSpringValue(scaleTarget, 0.4);

  // Double-buffer glow for cross-fade
  const glowARef = useRef<HTMLDivElement>(null);
  const glowBRef = useRef<HTMLDivElement>(null);
  const bufferIdx = useRef<0 | 1>(0);
  const prevStepRef = useRef<number>(-1);
  const positionRef = useRef<GlowPosition | null>(null);

  const recomputeGlow = useCallback(() => {
    const canvas = canvasRef.current;
    const glowA = glowARef.current;
    const glowB = glowBRef.current;
    if (!canvas || !glowA || !glowB) return;

    if (isOverview) {
      glowA.dataset.hidden = "true";
      glowB.dataset.hidden = "true";
      positionRef.current = null;
      return;
    }

    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const PAD = 16;
    const pos: GlowPosition = {
      left: projected.left - PAD,
      top: projected.top - PAD,
      width: projected.width + PAD * 2,
      height: projected.height + PAD * 2,
    };
    positionRef.current = pos;

    // On resize: reposition the current active buffer (no cross-fade needed)
    const cur = bufferIdx.current === 0 ? glowA : glowB;
    cur.style.left = `${pos.left}px`;
    cur.style.top = `${pos.top}px`;
    cur.style.width = `${pos.width}px`;
    cur.style.height = `${pos.height}px`;
  }, [bbox, isOverview, canvasRef]);

  // ResizeObserver — recompute on container resize / zoom
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { recomputeGlow(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasRef, recomputeGlow]);

  // Step change — cross-fade between buffers
  // B4 FIX: position is set BEFORE opacity transition, with forced reflow in between.
  useEffect(() => {
    const canvas = canvasRef.current;
    const glowA = glowARef.current;
    const glowB = glowBRef.current;
    if (!canvas || !glowA || !glowB) return;

    const stepChanged = activeStep !== prevStepRef.current;
    prevStepRef.current = activeStep;

    if (isOverview) {
      glowA.dataset.hidden = "true";
      glowB.dataset.hidden = "true";
      positionRef.current = null;
      return;
    }

    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const PAD = 16;
    const pos: GlowPosition = {
      left: projected.left - PAD,
      top: projected.top - PAD,
      width: projected.width + PAD * 2,
      height: projected.height + PAD * 2,
    };
    positionRef.current = pos;

    if (!stepChanged) {
      // Scale update on current buffer only
      const cur = bufferIdx.current === 0 ? glowA : glowB;
      cur.style.transform = `scale(${springScale.toFixed(4)})`;
      return;
    }

    // Cross-fade: B4 FIX — position incoming buffer FIRST, force reflow, then swap opacity.
    const next: 0 | 1 = bufferIdx.current === 0 ? 1 : 0;
    const incoming = next === 0 ? glowA : glowB;
    const outgoing = bufferIdx.current === 0 ? glowA : glowB;

    // 1. Position incoming at new location. CSS has NO position transitions (B4 fix),
    //    so this is instantaneous.
    incoming.style.left = `${pos.left}px`;
    incoming.style.top = `${pos.top}px`;
    incoming.style.width = `${pos.width}px`;
    incoming.style.height = `${pos.height}px`;
    incoming.style.transform = `scale(${springScale.toFixed(4)})`;

    // 2. Force synchronous reflow so the browser commits the new position
    //    before the opacity transition starts.
    void incoming.offsetHeight;

    // 3. Swap opacity — only the opacity transition fires (200ms ease-out).
    incoming.dataset.hidden = "false";
    outgoing.dataset.hidden = "true";

    bufferIdx.current = next;
  }, [activeStep, bbox, isOverview, canvasRef, springScale]);

  return (
    <div
      className="proto-canvas proto-canvas--soft-halo"
      ref={canvasRef}
      aria-hidden="true"
    >
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-soft-halo-img"
        draggable={false}
        aria-hidden="true"
      />
      {/* Double-buffer glow — glowA and glowB alternate for cross-fade (B4) */}
      <div ref={glowARef} className="proto-soft-halo-glow" data-hidden="true" />
      <div ref={glowBRef} className="proto-soft-halo-glow" data-hidden="true" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant C2 — Soft halo + dim
// ─────────────────────────────────────────────────────────────────────────────

function VariantC2HaloPlusDim({
  activeStep,
  canvasRef,
}: {
  activeStep: number;
  canvasRef: React.RefObject<HTMLDivElement>;
}): React.ReactElement {
  const bbox = SH_FOCUS_BOXES[activeStep] ?? null;
  const isOverview = bbox === null;

  const scaleTarget = isOverview ? 1 : 1.02;
  const springScale = useSpringValue(scaleTarget, 0.4);

  const [clipPath, setClipPath] = useState<string>("inset(0 0 0 0)");
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOverview || !canvasRef.current) {
      setClipPath("inset(0 0 0 0)");
      return;
    }
    const canvas = canvasRef.current;
    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const { left, top, width, height } = projected;
    const PAD = 14;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;

    const t = Math.max(0, top - PAD);
    const r = Math.max(0, cw - (left + width + PAD));
    const b = Math.max(0, ch - (top + height + PAD));
    const l = Math.max(0, left - PAD);

    setClipPath(`inset(${t}px ${r}px ${b}px ${l}px round 14px)`);
  }, [activeStep, bbox, isOverview, canvasRef]);

  useEffect(() => {
    const glow = glowRef.current;
    const canvas = canvasRef.current;
    if (!glow || !canvas || isOverview) {
      if (glow) glow.dataset.hidden = "true";
      return;
    }

    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const PAD = 16;
    glow.style.left = `${projected.left - PAD}px`;
    glow.style.top = `${projected.top - PAD}px`;
    glow.style.width = `${projected.width + PAD * 2}px`;
    glow.style.height = `${projected.height + PAD * 2}px`;
    glow.style.transform = `scale(${springScale.toFixed(4)})`;
    glow.dataset.hidden = "false";
  }, [activeStep, bbox, isOverview, canvasRef, springScale]);

  return (
    <div
      className="proto-canvas proto-canvas--halo-dim"
      ref={canvasRef}
      aria-hidden="true"
    >
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-halo-dim-base"
        draggable={false}
        aria-hidden="true"
        data-overview={isOverview ? "true" : "false"}
      />
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-halo-dim-active"
        draggable={false}
        aria-hidden="true"
        style={{
          clipPath: isOverview ? "inset(0 0 0 0)" : clipPath,
        }}
      />
      <div
        ref={glowRef}
        className="proto-soft-halo-glow proto-soft-halo-glow--c2"
        data-hidden="true"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant C3 — Inline SVG highlight
// ─────────────────────────────────────────────────────────────────────────────

const C3_SVG_BASE: string = (() => {
  let s = selfHealingFlowSvgRaw;
  if (!s.match(/<svg\b[^>]*viewBox/)) {
    s = s.replace(
      /(<svg\b[^>]*?)>/,
      `$1 viewBox="0 0 ${SH_SVG_VB_W} ${SH_SVG_VB_H}" preserveAspectRatio="xMidYMid meet">`,
    );
  }
  s = s.replace(/(<svg\b[^>]*?)\s+width="[^"]*"/, "$1");
  s = s.replace(/(<svg\b[^>]*?)\s+height="[^"]*"/, "$1");
  return s;
})();

function buildC3Svg(activeStep: number): string {
  const bbox = SH_FOCUS_BOXES[activeStep] ?? null;

  const filterId = "proto-c3-glow";
  const PAD = 14;
  const rx = 14;
  const glowColor = "#0C62FB";

  let highlightGroup = "";
  if (bbox !== null) {
    const hx = Math.max(0, bbox.x - PAD);
    const hy = Math.max(0, bbox.y - PAD);
    const hw = Math.min(SH_SVG_VB_W - hx, bbox.w + PAD * 2);
    const hh = Math.min(SH_SVG_VB_H - hy, bbox.h + PAD * 2);

    highlightGroup = `
  <defs>
    <filter id="${filterId}" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">
      <feFlood flood-color="${glowColor}" flood-opacity="0.18" result="flood"/>
      <feComposite in="flood" in2="SourceGraphic" operator="in" result="colorFill"/>
      <feGaussianBlur in="colorFill" stdDeviation="18" result="glow"/>
      <feMerge>
        <feMergeNode in="glow"/>
        <feMergeNode in="glow"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="${filterId}-ring" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="0" stdDeviation="10" flood-color="${glowColor}" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g class="proto-c3-highlights" aria-hidden="true">
    <rect
      x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="${rx}"
      fill="${glowColor}" fill-opacity="0.07"
      filter="url(#${filterId})"
    />
    <rect
      x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="${rx}"
      fill="none"
      stroke="${glowColor}" stroke-width="2.5" stroke-opacity="0.65"
      filter="url(#${filterId}-ring)"
    />
  </g>`;
  }

  return C3_SVG_BASE.replace(/<\/svg>\s*$/, `${highlightGroup}</svg>`);
}

function VariantC3InlineSvg({
  activeStep,
}: {
  activeStep: number;
}): React.ReactElement {
  const svgMarkup = useMemo(() => buildC3Svg(activeStep), [activeStep]);

  return (
    <div
      className="proto-canvas proto-canvas--inline-svg"
      aria-hidden="true"
    >
      {/*
        dangerouslySetInnerHTML: safe — selfHealingFlowSvgRaw is a bundled asset,
        not user input. Injected highlight is static markup with no script elements.
      */}
      <div
        className="proto-c3-svg-wrap"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svgMarkup }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: useC1ActiveStep — MODEL A version
//
// MODEL A: root = viewport (null). Step blocks live in the document scroll,
// not in a nested container. We listen on WINDOW scroll events and measure
// each step block's distance from the VIEWPORT center.
//
// Hysteresis deadband: 40 px. Only commit a step change when the new winner
// beats the previous winner by more than DEADBAND px — prevents oscillation
// when two steps are nearly equidistant.
//
// rAF throttling: scroll events fire at display refresh rate via requestAnimationFrame.
// ─────────────────────────────────────────────────────────────────────────────

const C1_HYSTERESIS_PX = 40;

// ── Pure helpers — exported for unit testing ─────────────────────────────────

/**
 * selectStep — pure step-selection with hysteresis deadband.
 *
 * Given the distance of each step from the viewport center and the previously
 * committed step, returns the new committed step index.
 *
 * Only switches to a new winner when it beats the previous winner by more than
 * DEADBAND pixels — prevents oscillation when two steps are equidistant.
 *
 * @param distances   Array of |elCenter − viewportCenter| per step (length = stepCount)
 * @param committed   Previously committed step index
 * @param deadband    Hysteresis in pixels (default C1_HYSTERESIS_PX)
 */
export function selectStep(
  distances: number[],
  committed: number,
  deadband: number = C1_HYSTERESIS_PX,
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

function useC1ActiveStep(
  stepRefs: React.RefObject<(HTMLElement | null)[]>,
  stepCount: number,
  enabled: boolean,
): number {
  const [activeStep, setActiveStep] = useState(0);
  const committedRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const compute = useCallback(() => {
    const steps = stepRefs.current;
    if (!steps) return;

    // Viewport center — MODEL A uses window/viewport as scroll root
    const viewportCenter = window.innerHeight / 2;

    // Build distance array for each step (|elCenter − viewportCenter|)
    const distances: number[] = [];
    for (let i = 0; i < stepCount; i++) {
      const el = steps[i];
      if (!el) {
        distances.push(Infinity);
        continue;
      }
      const rect = el.getBoundingClientRect();
      const elCenter = rect.top + rect.height / 2;
      distances.push(Math.abs(elCenter - viewportCenter));
    }

    // Delegate to pure selectStep (hysteresis deadband, testable)
    const next = selectStep(distances, committedRef.current);
    if (next !== committedRef.current) {
      committedRef.current = next;
      setActiveStep(next);
    }
  }, [stepRefs, stepCount]);

  useEffect(() => {
    if (!enabled) return;

    // MODEL A: listen on WINDOW (not a nested container)
    const onScroll = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        compute();
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    // Initial compute
    compute();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, compute]);

  return activeStep;
}

// ─────────────────────────────────────────────────────────────────────────────
// C1Section — Model A layout for the definitive C1 variant
//
// MODEL A differences vs. old nested-scroller approach:
//   • No overflow:scroll column. Page body is the scroller.
//   • Diagram: position:sticky, stays in viewport while steps flow past.
//   • Each step block: ~90-100vh tall, gives generous scroll travel.
//   • scroll-snap: scroll-snap-type: y proximity on the section wrapper,
//     scroll-snap-align: start on each step block. PROXIMITY avoids trapping.
//   • IntersectionObserver / step detection: viewport root (null), NOT a nested div.
//   • B3 FIX (deterministic keyboard nav):
//     activeStepRef mirrors observed activeStep (deps:[activeStep] effect, always current).
//     targetStepRef advanced immediately in the keyboard handler — no stale values.
//     Settle resync (deps:[]) listens to 'scrollend' + 150 ms debounce; cleanup never
//     cancels a pending debounce because the effect is registered once, not per-step.
//     Keyboard handler registered on window (gated by isVisible) — no click required.
// ─────────────────────────────────────────────────────────────────────────────

function C1Section({ isVisible }: { isVisible: boolean }): React.ReactElement {
  const variant = VARIANTS.find((v) => v.id === "C1")!;
  const [announcement, setAnnouncement] = useState("");
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const announcerId = useId();

  // MODEL A: no scrollContainerRef — hook listens on window
  const activeStep = useC1ActiveStep(stepRefs, SH_STEPS.length, isVisible);

  // BUG 1 FIX: activeStepRef mirrors the observed activeStep so the settle handler
  // can read it without capturing a stale closure value.
  const activeStepRef = useRef<number>(activeStep);
  useEffect(() => {
    activeStepRef.current = activeStep;
  }, [activeStep]);

  // targetStepRef: keyboard handler advances this ref directly so rapid key
  // presses are deterministic and never lose or invert a press.
  // Re-sync ONLY when scroll settles — registered ONCE (deps []) so the cleanup
  // never cancels the pending debounce on each activeStep commit.
  const targetStepRef = useRef<number>(0);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const resync = () => {
      // Read latest observed step via ref — no stale closure
      targetStepRef.current = activeStepRef.current;
    };
    const onScrollSettle = () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      // Fallback debounce: 150 ms of scroll silence
      syncTimerRef.current = setTimeout(resync, 150);
    };
    window.addEventListener("scrollend", resync, { passive: true });
    window.addEventListener("scroll", onScrollSettle, { passive: true });
    return () => {
      window.removeEventListener("scrollend", resync);
      window.removeEventListener("scroll", onScrollSettle);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // deps [] — register once; cleanup never cancels the pending debounce

  // Announce step change — announce step NAME, not "Paso N" (accessibility)
  useEffect(() => {
    const step = SH_STEPS[activeStep];
    if (!step) return;
    setAnnouncement(step.title);
  }, [activeStep]);

  // Reduced-motion detection
  const prefersReducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  // scrollToStep: scrollIntoView on the document (MODEL A)
  const scrollToStep = useCallback(
    (idx: number) => {
      const el = stepRefs.current[idx];
      if (!el) return;
      el.scrollIntoView({
        behavior: prefersReducedMotion ? "instant" : "smooth",
        block: "start",
      });
    },
    [prefersReducedMotion],
  );

  // BUG 2 FIX: register keydown on window, gated by isVisible (C1 section in
  // viewport). No click required. Ignore events whose target is a text input.
  useEffect(() => {
    if (!isVisible) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Do not intercept typing in form controls or contenteditable
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      const editable = (e.target as HTMLElement | null)?.isContentEditable ?? false;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || editable) return;

      const last = SH_STEPS.length - 1;
      let next: number | null = null;

      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === " ") {
        next = Math.min(targetStepRef.current + 1, last);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        next = Math.max(targetStepRef.current - 1, 0);
      } else if (e.key === "Home") {
        next = 0;
      } else if (e.key === "End") {
        next = last;
      }

      if (next !== null) {
        e.preventDefault(); // only when actually navigating a step
        targetStepRef.current = next; // advance immediately — deterministic
        scrollToStep(next);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isVisible, scrollToStep]);

  const currentStep = SH_STEPS[activeStep] ?? SH_STEPS[0];

  return (
    <section
      className={`proto-section proto-section--c1${isVisible ? "" : " proto-section--hidden"}`}
      aria-label="Self-Healing Flow — C1 Soft Halo (definitive variant)"
    >
      {/* Accessible live region — announces step NAME, not index (B5 copy fix) */}
      <div
        id={announcerId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="proto-sr-only"
      >
        {announcement}
      </div>

      {/* Variant banner */}
      <div className="proto-variant-label" aria-hidden="true">
        <span className="proto-variant-label__tag">C1</span>
        <p className="proto-variant-label__title">{variant.title}</p>
        <span className="proto-variant-label__badge">Definitive variant</span>
        <p className="proto-variant-label__desc">{variant.desc}</p>
      </div>

      {/*
        MODEL A story layout:
        - proto-story--model-a: CSS grid with sticky diagram column
        - proto-steps--model-a: plain document flow, NO overflow:scroll
        - Each step block is ~95vh tall for generous scroll travel
        - keyboard handler registered on window (gated by isVisible) — no click required
      */}
      <SelfHealingSubStepContext.Provider
        value={{ subStep: activeStep, isActive: isVisible }}
      >
        <div
          className="proto-story proto-story--model-a"
          role="region"
          aria-label="Self-Healing steps — use Arrow keys, Space, Home, End to navigate"
          tabIndex={0}
        >
          {/* ── Text column: plain document flow (MODEL A) ── */}
          <div className="proto-steps proto-steps--model-a">
            {SH_STEPS.map((step, idx) => (
              <article
                key={step.id}
                ref={(el) => {
                  stepRefs.current[idx] = el;
                }}
                data-step-idx={idx}
                className="proto-step proto-step--model-a"
                data-active={activeStep === idx ? "true" : "false"}
                aria-current={activeStep === idx ? "true" : undefined}
                aria-labelledby={`${announcerId}-step-${idx}`}
              >
                <p className="proto-step__num">
                  {idx === 0 || idx === SH_STEPS.length - 1
                    ? "Overview"
                    : `Step ${idx} of ${SH_STEPS.length - 2}`}
                </p>
                <h3
                  id={`${announcerId}-step-${idx}`}
                  className="proto-step__title"
                >
                  {step.title}
                </h3>
                <ul className="proto-step__list">
                  {step.bullets.map((bullet, bi) => (
                    <li key={bi} className="proto-step__item">
                      {bullet}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {/* ── Diagram column: position:sticky (MODEL A) ── */}
          <div className="proto-diagram-pin proto-diagram-pin--model-a" aria-hidden="true">
            <VariantC1SoftHalo activeStep={activeStep} canvasRef={canvasRef} />

            {/* Step label under diagram */}
            <p className="proto-step-label" aria-hidden="true">
              {activeStep === 0 || activeStep === SH_STEPS.length - 1 ? (
                "Overview — scroll to walk through each step"
              ) : (
                <>
                  <span>{currentStep.title.split("—")[0]}</span>
                  {currentStep.title.includes("—")
                    ? `—${currentStep.title.split("—").slice(1).join("—")}`
                    : ""}
                </>
              )}
            </p>

            {/* B5 FIX: keyboard hint at full opacity (was opacity 0.65 → ~3.2:1).
                Full --c-muted color = 5.9:1 AA+. Active state = --c-accent. */}
            <p className="proto-keyboard-hint" aria-hidden="true">
              Arrow keys · Space · Home · End to navigate
            </p>
          </div>
        </div>
      </SelfHealingSubStepContext.Provider>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VariantSection — generic section for variants A, B, C, C2, C3
// Uses window scroll + IntersectionObserver with root = viewport (MODEL A)
// ─────────────────────────────────────────────────────────────────────────────

function VariantSection({
  variant,
  isVisible,
}: {
  variant: VariantMeta;
  isVisible: boolean;
}): React.ReactElement {
  const [activeStep, setActiveStep] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const announcerId = useId();

  // IntersectionObserver with root = viewport (null) — MODEL A
  useEffect(() => {
    if (!isVisible) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (visible) {
          const idx = Number((visible.target as HTMLElement).dataset.stepIdx ?? 0);
          setActiveStep(idx);
        }
      },
      // root: null = viewport (MODEL A)
      { root: null, rootMargin: "-30% 0px -40% 0px", threshold: [0, 0.25, 0.6] },
    );

    stepRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [isVisible]);

  useEffect(() => {
    const step = SH_STEPS[activeStep];
    if (!step) return;
    setAnnouncement(step.title);
  }, [activeStep]);

  const currentStep = SH_STEPS[activeStep] ?? SH_STEPS[0];

  return (
    <section
      className={`proto-section${isVisible ? "" : " proto-section--hidden"}`}
      aria-label={`Variant ${variant.id}: ${variant.title}`}
    >
      <div
        id={announcerId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="proto-sr-only"
      >
        {announcement}
      </div>

      <div className="proto-variant-label" aria-hidden="true">
        <span className="proto-variant-label__tag">{variant.id}</span>
        <p className="proto-variant-label__title">{variant.title}</p>
        <p className="proto-variant-label__desc">{variant.desc}</p>
      </div>

      <SelfHealingSubStepContext.Provider
        value={{ subStep: activeStep, isActive: isVisible }}
      >
        <div className="proto-story proto-story--model-a">
          {/* Text column — document flow */}
          <div className="proto-steps proto-steps--model-a">
            {SH_STEPS.map((step, idx) => (
              <article
                key={step.id}
                ref={(el) => {
                  stepRefs.current[idx] = el;
                }}
                data-step-idx={idx}
                className="proto-step proto-step--model-a"
                data-active={activeStep === idx ? "true" : "false"}
                aria-current={activeStep === idx ? "true" : undefined}
                aria-labelledby={`${announcerId}-step-${idx}`}
              >
                <p className="proto-step__num">
                  {idx === 0 || idx === SH_STEPS.length - 1
                    ? "Overview"
                    : `Step ${idx} of ${SH_STEPS.length - 2}`}
                </p>
                <h3
                  id={`${announcerId}-step-${idx}`}
                  className="proto-step__title"
                >
                  {step.title}
                </h3>
                <ul className="proto-step__list">
                  {step.bullets.map((bullet, bi) => (
                    <li key={bi} className="proto-step__item">
                      {bullet}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {/* Diagram column — sticky */}
          <div className="proto-diagram-pin proto-diagram-pin--model-a" aria-hidden="true">
            {variant.id === "A" && (
              <VariantADesaturate activeStep={activeStep} canvasRef={canvasRef} />
            )}
            {variant.id === "B" && (
              <VariantBZoom activeStep={activeStep} canvasRef={canvasRef} />
            )}
            {variant.id === "C" && (
              <VariantCHalo activeStep={activeStep} canvasRef={canvasRef} />
            )}
            {variant.id === "C2" && (
              <VariantC2HaloPlusDim activeStep={activeStep} canvasRef={canvasRef} />
            )}
            {variant.id === "C3" && (
              <VariantC3InlineSvg activeStep={activeStep} />
            )}

            <p className="proto-step-label" aria-hidden="true">
              {activeStep === 0 || activeStep === SH_STEPS.length - 1 ? (
                "Overview — scroll to walk through each step"
              ) : (
                <>
                  <span>{currentStep.title.split("—")[0]}</span>
                  {currentStep.title.includes("—")
                    ? `—${currentStep.title.split("—").slice(1).join("—")}`
                    : ""}
                </>
              )}
            </p>
          </div>
        </div>
      </SelfHealingSubStepContext.Provider>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ScrollProto — root
// ─────────────────────────────────────────────────────────────────────────────

export function ScrollProto(): React.ReactElement {
  const [activeVariant, setActiveVariant] = useState<Variant>("C1");

  const activeVariantMeta = VARIANTS.find((v) => v.id === activeVariant) ?? VARIANTS[0];

  return (
    <div className="proto-root" data-testid="scroll-proto">
      {/* Sticky header with variant tabs */}
      <header className="proto-header" role="banner">
        <span className="proto-header__label" aria-hidden="true">
          Proto — Scrollytelling Highlights
        </span>

        <nav aria-label="Highlight variants" role="navigation">
          <ul
            role="tablist"
            aria-label="Highlight variants"
            className="proto-tabs"
          >
            {VARIANTS.map((v) => (
              <li key={v.id} role="presentation">
                <button
                  role="tab"
                  aria-selected={activeVariant === v.id}
                  aria-controls={`proto-panel-${v.id}`}
                  id={`proto-tab-${v.id}`}
                  className="proto-tab"
                  onClick={() => setActiveVariant(v.id)}
                >
                  {v.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <span className="proto-header__step" aria-live="polite">
          {activeVariantMeta.title}
        </span>
      </header>

      {/* Variant panels */}
      {VARIANTS.map((v) => (
        <div
          key={v.id}
          id={`proto-panel-${v.id}`}
          role="tabpanel"
          aria-labelledby={`proto-tab-${v.id}`}
        >
          {v.id === "C1" ? (
            <C1Section isVisible={activeVariant === v.id} />
          ) : (
            <VariantSection
              variant={v}
              isVisible={activeVariant === v.id}
            />
          )}
        </div>
      ))}
    </div>
  );
}
