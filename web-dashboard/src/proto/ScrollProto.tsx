/**
 * ScrollProto.tsx — Prototipo scrollytelling con 6 variantes de resalte (A, B, C, C1, C2, C3).
 *
 * Acceso: ?proto=scroll en la URL
 *
 * ARQUITECTURA:
 *   - Patrón sticky/pinned: diagrama fijo a la derecha, texto desplazable a la izquierda.
 *   - IntersectionObserver activa el sub-paso cuando el bloque de texto entra en la zona
 *     de lectura (rootMargin: -35% 0px -45% 0px) — scroll-triggered, no scroll-linked.
 *   - Cada variante comparte la misma lógica de estado (activeStep) pero implementa
 *     su propio mecanismo de resalte.
 *
 * VARIANTES ORIGINALES:
 *   A — Desaturar/atenuar: dos capas de <img> (gris + color); la activa se recorta
 *       con clip-path polygon en coordenadas % del canvas DOM.
 *   B — Zoom/pan cámara: transform scale+translate con spring críticamente amortiguado.
 *   C — Borde/halo: la imagen se atenúa; un ring DOM posicionado sobre la bbox activa.
 *
 * VARIANTES NUEVAS (PR #15 — round 2):
 *   C1 — Halo suave sin contorno: glow difuso (box-shadow grande) + scale 1.02 con spring.
 *        Sin borde nítido, tolera ±3px de imprecisión en la proyección de la bbox.
 *        HARDENED (PR #15 round 3): scroll-snap + hysteresis + keyboard nav +
 *        ResizeObserver + halo cross-fade. VARIANTE DEFINITIVA.
 *   C2 — Halo suave + atenuación: C1 más atenuación del fondo (como A pero suave).
 *        Doble señal de foco; la precisión del halo importa menos.
 *   C3 — Resalte pintado dentro del SVG: el SVG se importa como texto raw (?raw),
 *        se parsea e inyecta inline, y se dibuja un <rect> de realce en coords del
 *        viewBox (con SVG drop-shadow filter). El realce escala junto al diagrama
 *        sin posicionamiento DOM — imposible el desajuste.
 *
 * LIMITACIÓN CONOCIDA — SVG-as-img + CSP:
 *   Variantes A/B/C operan sobre capas DOM superpuestas a una <img>.
 *   Variantes C1/C2 también (mismo approach, sin border).
 *   Variante C3 inlinea el SVG: accede al viewBox directamente. El SVG de Lucid
 *   NO tiene <g id="..."> semánticos; C3 dibuja los <rect> de realce por bbox en
 *   el mismo sistema de coords que SH_FOCUS_BOXES — robusto y siempre alineado.
 *
 * REDUCED-MOTION: sticky desactivado, transforms eliminados, reveal estático.
 *   C1 específico: scroll-snap y scroll-behavior:smooth se eliminan con reduced-motion.
 * ACCESIBILIDAD: aria-live anuncia el paso activo, roles region/tablist, foco por teclado.
 *   C1 específico: navegación ArrowUp/ArrowDown/Space/ArrowLeft/ArrowRight.
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
    title: "Desaturar / Atenuar",
    desc: "El grupo activo mantiene color; el resto se desatura y atenúa. Sin scrim oscuro.",
  },
  {
    id: "B",
    label: "B",
    title: "Zoom / Pan de cámara",
    desc: "El diagrama hace zoom y pan con spring hacia la bbox activa, como una cámara.",
  },
  {
    id: "C",
    label: "C — original",
    title: "Borde / Halo de marca",
    desc: "Ring DOM con borde Slalom Blue sobre la bbox. Puede desalinearse 2-3px (ver C1/C2).",
  },
  {
    id: "C1",
    label: "C1",
    title: "Halo suave sin contorno",
    desc: "Glow difuso (box-shadow grande) + scale 1.02. Sin borde nítido, perdona imprecisiones de bbox.",
  },
  {
    id: "C2",
    label: "C2",
    title: "Halo suave + atenuación",
    desc: "C1 con atenuación leve del fondo. Doble señal de foco; la precision del halo importa menos.",
  },
  {
    id: "C3",
    label: "C3",
    title: "Resalte dentro del SVG",
    desc: "SVG inline: <rect> de realce en coords del viewBox. Escala perfecto, imposible desalinearse.",
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
// Variant A — Desaturar / Atenuar
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
// Variant B — Zoom / Pan de cámara
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
// Variant C — Borde / Halo de marca (ORIGINAL — mantener para comparar)
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
// Variant C1 — Halo suave sin contorno  [VARIANTE DEFINITIVA — hardened]
//
// Hardening PR #15 round 3:
//   • ResizeObserver en el canvas para recomputar proyección bbox cuando cambia
//     el tamaño del contenedor o el zoom del navegador (mismo patrón que VariantBZoom).
//   • Cross-fade del halo: al cambiar de paso, el glow hace fade-out (opacity 0)
//     y luego fade-in en la nueva posición, eliminando el salto visual en seco.
//     Implementado con dos elementos glow (A/B) que se intercalan (double-buffer).
//   • El posicionamiento lo maneja el propio componente vía ResizeObserver +
//     recompute, por eso ya no depende del useEffect exterior a la proyección.
//
// NOTA: el IntersectionObserver y scroll-snap/hysteresis están en C1Section
// (ver abajo), que sustituye a VariantSection para la variante C1.
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

  // ── Double-buffer glow: glowA and glowB alternate to create cross-fade ──
  // bufferIdx tells which buffer is "current" (visible). The other fades out.
  const glowARef = useRef<HTMLDivElement>(null);
  const glowBRef = useRef<HTMLDivElement>(null);
  const bufferIdx = useRef<0 | 1>(0);
  const prevStepRef = useRef<number>(-1);

  // Computed glow position (reused by both resize and step change)
  const positionRef = useRef<GlowPosition | null>(null);

  const recomputeGlow = useCallback(() => {
    const canvas = canvasRef.current;
    const glowA = glowARef.current;
    const glowB = glowBRef.current;
    if (!canvas || !glowA || !glowB) return;

    if (isOverview) {
      // Hide both buffers
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

    // Apply to the current active buffer (no cross-fade on resize — just reposition)
    const cur = bufferIdx.current === 0 ? glowA : glowB;
    cur.style.left = `${pos.left}px`;
    cur.style.top = `${pos.top}px`;
    cur.style.width = `${pos.width}px`;
    cur.style.height = `${pos.height}px`;
  }, [bbox, isOverview, canvasRef]);

  // ResizeObserver — recompute on container resize / zoom (same pattern as VariantBZoom)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { recomputeGlow(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasRef, recomputeGlow]);

  // Step change — cross-fade between buffers
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
      // Just update scale on the current active buffer
      const cur = bufferIdx.current === 0 ? glowA : glowB;
      cur.style.transform = `scale(${springScale.toFixed(4)})`;
      return;
    }

    // Cross-fade: prepare the INCOMING buffer at the new position (invisible),
    // then swap — incoming fades in, outgoing fades out.
    const next: 0 | 1 = bufferIdx.current === 0 ? 1 : 0;
    const incoming = next === 0 ? glowA : glowB;
    const outgoing = bufferIdx.current === 0 ? glowA : glowB;

    // Position incoming at new spot before making it visible
    incoming.style.left = `${pos.left}px`;
    incoming.style.top = `${pos.top}px`;
    incoming.style.width = `${pos.width}px`;
    incoming.style.height = `${pos.height}px`;
    incoming.style.transform = `scale(${springScale.toFixed(4)})`;

    // Swap visibility
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
      {/* Double-buffer glow — glowA and glowB alternate for cross-fade */}
      <div ref={glowARef} className="proto-soft-halo-glow" data-hidden="true" />
      <div ref={glowBRef} className="proto-soft-halo-glow" data-hidden="true" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant C2 — Halo suave + atenuación
//
// Técnica: C1 (glow difuso) + capa de desaturación del fondo (como A, pero
// con atenuación más suave: opacity 0.5 / saturate 0.15 en lugar de 0.08/0.38).
// Doble señal de foco: el ojo sigue el área con color + glow; la imprecisión
// del halo es menos perceptible porque la atenuación global ya dirige la atención.
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

  // Reuse clip-path mechanism from A for the color layer
  useEffect(() => {
    if (isOverview || !canvasRef.current) {
      setClipPath("inset(0 0 0 0)");
      return;
    }
    const canvas = canvasRef.current;
    const projected = projectBBox(bbox!, canvas);
    if (!projected) return;

    const { left, top, width, height } = projected;
    const PAD = 14; // slightly larger pad than A for a softer edge
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;

    const t = Math.max(0, top - PAD);
    const r = Math.max(0, cw - (left + width + PAD));
    const b = Math.max(0, ch - (top + height + PAD));
    const l = Math.max(0, left - PAD);

    setClipPath(`inset(${t}px ${r}px ${b}px ${l}px round 14px)`);
  }, [activeStep, bbox, isOverview, canvasRef]);

  // Glow overlay positioning
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
      {/* Capa gris base — siempre visible, atenuación suave */}
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-halo-dim-base"
        draggable={false}
        aria-hidden="true"
        data-overview={isOverview ? "true" : "false"}
      />
      {/* Capa color — recortada a la bbox activa */}
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
      {/* Glow overlay — sin border, sombra difusa */}
      <div
        ref={glowRef}
        className="proto-soft-halo-glow proto-soft-halo-glow--c2"
        data-hidden="true"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant C3 — Resalte pintado dentro del SVG (inline SVG)
//
// Técnica: el SVG se importa como texto raw (selfHealingFlowSvgRaw) y se inyecta
// directamente en el DOM con dangerouslySetInnerHTML. Sobre el <g> raíz del SVG
// se añade un <g class="proto-c3-highlights"> con <rect> elements en coords del
// viewBox (los mismos SH_FOCUS_BOXES), con un SVG filter de blur/glow.
//
// Como el <rect> de realce vive en el viewBox del SVG, escala junto con el
// diagrama sin ningún cálculo DOM — imposible desalinearse.
//
// LIMITACIÓN CONOCIDA: el SVG de Lucid no tiene <g id="..."> semánticos. Los
// <rect> de realce se dibujan por bbox (SH_FOCUS_BOXES) en el mismo sistema de
// coords, lo cual es robusto. El translate(-259 0) del <g> raíz ya está
// compensado en SH_FOCUS_BOXES (son coords del viewBox externo, no del <g> interno).
//
// SEGURIDAD: dangerouslySetInnerHTML se usa sobre un asset bundleado (no datos
// externos); el SVG es un archivo local controlado. No hay contenido dinámico
// de usuario. El filtro SVG es markup inerte, no ejecuta scripts.
// ─────────────────────────────────────────────────────────────────────────────

// Lucid exports SVG with fixed width/height attributes but NO viewBox.
// For inline SVG to scale correctly via CSS, we need to:
//   1. Add a viewBox matching the original dimensions (SH_SVG_VB_W x SH_SVG_VB_H)
//   2. Strip the fixed width/height so CSS controls the size
//   3. Add preserveAspectRatio="xMidYMid meet" so it behaves like object-fit:contain
//
// All coordinate systems (SH_FOCUS_BOXES, the translate(-259 0) on the inner <g>)
// remain unchanged because viewBox "0 0 W H" with original W/H is identity.
const C3_SVG_BASE: string = (() => {
  let s = selfHealingFlowSvgRaw;
  // 1. Add viewBox (Lucid SVG has no viewBox — uses absolute width/height)
  if (!s.match(/<svg\b[^>]*viewBox/)) {
    s = s.replace(
      /(<svg\b[^>]*?)>/,
      `$1 viewBox="0 0 ${SH_SVG_VB_W} ${SH_SVG_VB_H}" preserveAspectRatio="xMidYMid meet">`,
    );
  }
  // 2. Strip fixed width/height from <svg> so CSS controls size
  s = s.replace(/(<svg\b[^>]*?)\s+width="[^"]*"/, "$1");
  s = s.replace(/(<svg\b[^>]*?)\s+height="[^"]*"/, "$1");
  return s;
})();

// Build the SVG markup with the highlight <rect> injected for the active step.
// We insert a <defs> with the glow filter and a <g> with the highlight rect
// BEFORE the closing </svg> tag.
function buildC3Svg(activeStep: number): string {
  const bbox = SH_FOCUS_BOXES[activeStep] ?? null;

  // The filter id must be stable per step to avoid React reconciliation issues
  const filterId = "proto-c3-glow";
  const PAD = 14;
  const rx = 14; // rounded corners, same as existing highlight rings

  // Slalom Blue color components for the glow
  const glowColor = "#0C62FB";

  // Build the highlight overlay group
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
    <!-- Soft fill background — painted in viewBox coords, scales with SVG -->
    <rect
      x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="${rx}"
      fill="${glowColor}" fill-opacity="0.07"
      filter="url(#${filterId})"
    />
    <!-- Soft ring — no hard border, uses drop-shadow filter -->
    <rect
      x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="${rx}"
      fill="none"
      stroke="${glowColor}" stroke-width="2.5" stroke-opacity="0.65"
      filter="url(#${filterId}-ring)"
    />
  </g>`;
  }

  // Inject before </svg>
  return C3_SVG_BASE.replace(/<\/svg>\s*$/, `${highlightGroup}</svg>`);
}

function VariantC3InlineSvg({
  activeStep,
}: {
  activeStep: number;
}): React.ReactElement {
  // Build the SVG string with the highlight for this step
  const svgMarkup = useMemo(() => buildC3Svg(activeStep), [activeStep]);

  return (
    <div
      className="proto-canvas proto-canvas--inline-svg"
      aria-hidden="true"
    >
      {/*
        dangerouslySetInnerHTML: safe here because selfHealingFlowSvgRaw is a
        bundled asset (not user input). The injected highlight is static markup.
        No script elements, no external loads. Meets self-hosted CSP.
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
// Hook: useC1ActiveStep — deterministic step selection via center-distance
//
// Replaces IntersectionObserver for C1. Strategy:
//   1. On every scroll event of the steps container (throttled with rAF), compute
//      each step's distance from the container's visible center.
//   2. Pick the step with minimum distance — DETERMINISTIC, no ambiguity.
//   3. Hysteresis deadband: only commit a step change when the new winner's
//      center-distance is < (prevWinner's center-distance - DEADBAND), preventing
//      oscillation when two steps are nearly equidistant.
//
// Result: activeStep never oscillates, regardless of scroll speed.
// ─────────────────────────────────────────────────────────────────────────────

const C1_HYSTERESIS_PX = 40; // deadband: 40px margin before switching step

function useC1ActiveStep(
  stepRefs: React.RefObject<(HTMLElement | null)[]>,
  scrollContainerRef: React.RefObject<HTMLDivElement>,
  stepCount: number,
  enabled: boolean,
): number {
  const [activeStep, setActiveStep] = useState(0);
  const committedRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const compute = useCallback(() => {
    const container = scrollContainerRef.current;
    const steps = stepRefs.current;
    if (!container || !steps) return;

    // Visible center of the scroll container (in the container's coordinate space)
    const containerRect = container.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;

    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < stepCount; i++) {
      const el = steps[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const elCenter = rect.top + rect.height / 2;
      const dist = Math.abs(elCenter - containerCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    // Hysteresis: only switch if the new winner beats the current by DEADBAND
    const prevIdx = committedRef.current;
    if (bestIdx !== prevIdx) {
      // Re-compute distance for the currently committed step
      const prevEl = steps[prevIdx];
      if (prevEl) {
        const prevRect = prevEl.getBoundingClientRect();
        const prevCenter = prevRect.top + prevRect.height / 2;
        const prevDist = Math.abs(prevCenter - containerCenter);
        if (bestDist < prevDist - C1_HYSTERESIS_PX) {
          committedRef.current = bestIdx;
          setActiveStep(bestIdx);
        }
      } else {
        committedRef.current = bestIdx;
        setActiveStep(bestIdx);
      }
    }
  }, [scrollContainerRef, stepRefs, stepCount]);

  useEffect(() => {
    if (!enabled) return;

    // The scroll container is the steps div (overflow-y: auto with snap),
    // NOT window. We listen on the container element directly.
    const container = scrollContainerRef.current;
    if (!container) return;

    const onScroll = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        compute();
      });
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    // Initial compute
    compute();

    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, compute, scrollContainerRef]);

  return activeStep;
}

// ─────────────────────────────────────────────────────────────────────────────
// C1Section — hardened VariantSection specific to C1
//
// Differences from the generic VariantSection:
//   • Uses useC1ActiveStep (center-distance + hysteresis) instead of
//     IntersectionObserver → eliminates oscillation between neighbors.
//   • Adds CSS scroll-snap on the steps container so the browser settles on
//     exactly one step at a time, removing ambiguous intermediate positions.
//     Uses scroll-snap-type: y proximity (not mandatory) — proximity is less
//     aggressive: it only snaps if the scroll lands within ~50% of a snap point,
//     so a deliberate fast flick still works. Mandatory would lock every scroll
//     which feels too mechanical for a talk demo on a trackpad.
//     With prefers-reduced-motion: snap is removed entirely.
//   • Keyboard navigation: ArrowDown / Space / ArrowRight → next step;
//     ArrowUp / ArrowLeft → prev step. Smooth scroll to step section.
//     focus is managed: the scroll container gets focus on mount so arrows work
//     without first clicking.
//   • aria-live region announces each step transition.
//   • Keyboard hint: a subtle label at the bottom of the sticky panel.
// ─────────────────────────────────────────────────────────────────────────────

function C1Section({ isVisible }: { isVisible: boolean }): React.ReactElement {
  const variant = VARIANTS.find((v) => v.id === "C1")!;
  const [announcement, setAnnouncement] = useState("");
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  // stepsScrollRef: the overflow-y scroll container that houses the step articles
  const stepsScrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const announcerId = useId();

  // Deterministic step via center-distance + hysteresis
  // The scroll container is stepsScrollRef (overflow-y: auto with snap), not window.
  const activeStep = useC1ActiveStep(stepRefs, stepsScrollRef, SH_STEPS.length, isVisible);

  // Announce step change for screen readers
  useEffect(() => {
    const step = SH_STEPS[activeStep];
    if (!step) return;
    setAnnouncement(`${variant.title} — Paso ${activeStep}: ${step.title}`);
  }, [activeStep, variant.title]);

  // Reduced-motion detection for keyboard scroll behavior
  const prefersReducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  // Keyboard navigation: smooth-scroll to a step by index
  const scrollToStep = useCallback(
    (idx: number) => {
      const el = stepRefs.current[idx];
      if (!el) return;
      el.scrollIntoView({
        behavior: prefersReducedMotion ? "instant" : "smooth",
        block: "center",
      });
    },
    [prefersReducedMotion],
  );

  // Keyboard handler — ArrowDown/Up/Space/Left/Right
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const last = SH_STEPS.length - 1;
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        scrollToStep(Math.min(activeStep + 1, last));
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        scrollToStep(Math.max(activeStep - 1, 0));
      } else if (e.key === "Home") {
        e.preventDefault();
        scrollToStep(0);
      } else if (e.key === "End") {
        e.preventDefault();
        scrollToStep(last);
      }
    },
    [activeStep, scrollToStep],
  );

  const currentStep = SH_STEPS[activeStep] ?? SH_STEPS[0];

  return (
    <section
      className={`proto-section proto-section--c1${isVisible ? "" : " proto-section--hidden"}`}
      aria-label={`Variante C1 — definitiva: ${variant.title}`}
    >
      {/* Accessible live region */}
      <div
        id={announcerId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="proto-sr-only"
      >
        {announcement}
      </div>

      {/* Variant banner with "definitiva" badge */}
      <div className="proto-variant-label" aria-hidden="true">
        <span className="proto-variant-label__tag">C1</span>
        <p className="proto-variant-label__title">{variant.title}</p>
        <span className="proto-variant-label__badge">Variante definitiva</span>
        <p className="proto-variant-label__desc">{variant.desc}</p>
      </div>

      {/* Story layout */}
      <SelfHealingSubStepContext.Provider
        value={{ subStep: activeStep, isActive: isVisible }}
      >
        <div
          className="proto-story"
          role="region"
          aria-label="Navegacion por teclado: flechas Arriba/Abajo para avanzar pasos"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {/* ── Text column with scroll-snap ── */}
          <div className="proto-steps proto-steps--c1-snap" ref={stepsScrollRef}>
            {SH_STEPS.map((step, idx) => (
              <article
                key={step.id}
                ref={(el) => {
                  stepRefs.current[idx] = el;
                }}
                data-step-idx={idx}
                className="proto-step proto-step--snap"
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

          {/* ── Diagram column (sticky pin) ── */}
          <div className="proto-diagram-pin" aria-hidden="true">
            <VariantC1SoftHalo activeStep={activeStep} canvasRef={canvasRef} />

            {/* Step label under diagram */}
            <p className="proto-step-label" aria-hidden="true">
              {activeStep === 0 || activeStep === SH_STEPS.length - 1 ? (
                "Overview — scroll down to walk through each step"
              ) : (
                <>
                  <span>{currentStep.title.split("—")[0]}</span>
                  {currentStep.title.includes("—")
                    ? `—${currentStep.title.split("—").slice(1).join("—")}`
                    : ""}
                </>
              )}
            </p>

            {/* Keyboard hint — subtle, aria-hidden */}
            <p className="proto-keyboard-hint" aria-hidden="true">
              Use arrow keys to navigate steps
            </p>
          </div>
        </div>
      </SelfHealingSubStepContext.Provider>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VariantSection — una instancia completa de la sección scrollytelling
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

  // IntersectionObserver: activa el paso cuando entra en zona de lectura
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
      { rootMargin: "-30% 0px -40% 0px", threshold: [0, 0.25, 0.6] },
    );

    stepRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [isVisible]);

  // Announce step change for screen readers
  useEffect(() => {
    const step = SH_STEPS[activeStep];
    if (!step) return;
    setAnnouncement(`${variant.title} — Paso ${activeStep}: ${step.title}`);
  }, [activeStep, variant.title]);

  const currentStep = SH_STEPS[activeStep] ?? SH_STEPS[0];

  return (
    <section
      className={`proto-section${isVisible ? "" : " proto-section--hidden"}`}
      aria-label={`Variante ${variant.id}: ${variant.title}`}
    >
      {/* Accessible live region */}
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
        <span className="proto-variant-label__tag">{variant.id}</span>
        <p className="proto-variant-label__title">{variant.title}</p>
        <p className="proto-variant-label__desc">{variant.desc}</p>
      </div>

      {/* Story layout */}
      <SelfHealingSubStepContext.Provider
        value={{ subStep: activeStep, isActive: isVisible }}
      >
        <div className="proto-story">
          {/* ── Text column ── */}
          <div className="proto-steps">
            {SH_STEPS.map((step, idx) => (
              <article
                key={step.id}
                ref={(el) => {
                  stepRefs.current[idx] = el;
                }}
                data-step-idx={idx}
                className="proto-step"
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

          {/* ── Diagram column (sticky pin) ── */}
          <div className="proto-diagram-pin" aria-hidden="true">
            {variant.id === "A" && (
              <VariantADesaturate
                activeStep={activeStep}
                canvasRef={canvasRef}
              />
            )}
            {variant.id === "B" && (
              <VariantBZoom
                activeStep={activeStep}
                canvasRef={canvasRef}
              />
            )}
            {variant.id === "C" && (
              <VariantCHalo
                activeStep={activeStep}
                canvasRef={canvasRef}
              />
            )}
            {variant.id === "C1" && (
              <VariantC1SoftHalo
                activeStep={activeStep}
                canvasRef={canvasRef}
              />
            )}
            {variant.id === "C2" && (
              <VariantC2HaloPlusDim
                activeStep={activeStep}
                canvasRef={canvasRef}
              />
            )}
            {variant.id === "C3" && (
              <VariantC3InlineSvg
                activeStep={activeStep}
              />
            )}

            {/* Step label under diagram */}
            <p className="proto-step-label" aria-hidden="true">
              {activeStep === 0 || activeStep === SH_STEPS.length - 1 ? (
                "Overview — scroll down to walk through each step"
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
// ScrollProto — raíz del prototipo
// ─────────────────────────────────────────────────────────────────────────────

export function ScrollProto(): React.ReactElement {
  const [activeVariant, setActiveVariant] = useState<Variant>("C1");

  const activeVariantMeta = VARIANTS.find((v) => v.id === activeVariant) ?? VARIANTS[0];

  return (
    <div className="proto-root" data-testid="scroll-proto">
      {/* ── Header sticky con tabs de variante ── */}
      <header className="proto-header" role="banner">
        <span className="proto-header__label" aria-hidden="true">
          Proto — Scrollytelling Highlights
        </span>

        <nav aria-label="Variantes de resalte" role="navigation">
          <ul
            role="tablist"
            aria-label="Variantes"
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

      {/* ── Variant sections ── */}
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
