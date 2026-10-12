/**
 * ScrollProto.tsx — Prototipo scrollytelling con 3 variantes de resalte (sin scrim).
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
 * VARIANTES:
 *   A — Desaturar/atenuar: dos capas de <img> (gris + color); la activa se recorta
 *       con clip-path polygon en coordenadas % del canvas DOM.
 *   B — Zoom/pan cámara: transform scale+translate con spring críticamente amortiguado
 *       (useSpring) calculado desde SH_FOCUS_BOXES (coords viewBox).
 *   C — Borde/halo: la imagen entera se atenúa levemente; un ring DOM se posiciona
 *       sobre la bbox activa proyectada al canvas.
 *
 * LIMITACIÓN CONOCIDA (SVG-as-img + CSP):
 *   Como el SVG se sirve como <img> (asset URL de Vite, CSP img-src 'self'),
 *   no es posible acceder al DOM interno del SVG para aplicar filtros por grupo.
 *   Las tres variantes operan sobre capas DOM superpuestas encima de la imagen.
 *
 * REDUCED-MOTION: sticky desactivado, transforms eliminados, reveal estático.
 *   skill: apple-design + scroll-storytelling §4, §8.
 *
 * ACCESIBILIDAD: aria-live anuncia el paso activo, roles region/tablist, foco por teclado.
 */

import React, {
  useCallback,
  useEffect,
  useId,
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
import "./ScrollProto.css";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Variant = "A" | "B" | "C";

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
    label: "C",
    title: "Borde / Halo de marca",
    desc: "El grupo activo recibe un halo ring Slalom Blue. El resto queda casi sin atenuar.",
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
//
// The <img> fits inside .proto-canvas via object-fit:contain, centered.
// We must compute the letterboxed area and then map viewBox coords to it.
//
// Returns {left, top, width, height} in px relative to the canvas element.
// Returns null if canvas has no size yet.
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

  // Compute the rendered size of the image (object-fit:contain)
  const imgAspect = SH_SVG_VB_W / SH_SVG_VB_H;
  const canvasAspect = cw / ch;

  let renderedW: number;
  let renderedH: number;
  let offsetX: number;
  let offsetY: number;

  if (imgAspect > canvasAspect) {
    // Image is wider than canvas → letterbox top/bottom
    renderedW = cw;
    renderedH = cw / imgAspect;
    offsetX = 0;
    offsetY = (ch - renderedH) / 2;
  } else {
    // Image is taller → pillarbox left/right
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
//
// Técnica: dos <img> superpuestas.
//   1. proto-desat-layer: toda la imagen desaturada/atenuada (base permanente)
//   2. proto-desat-active: misma imagen a color, clip-path en la bbox activa
//
// clip-path se expresa en coordenadas absolutas relativas al canvas (inset()).
// La transición de clip-path es nativa CSS → smooth sin rAF extra.
//
// LIMITACIÓN: clip-path con `inset` o `polygon` en % funciona bien en todos
// los browsers modernos. Si el browser no soporta clip-path (IE), se muestra
// la imagen a color normal (degradación segura).
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

    // inset(top right bottom left)
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
      {/* Capa gris base — siempre visible */}
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-desat-layer"
        draggable={false}
        aria-hidden="true"
      />
      {/* Capa color — recortada a la bbox activa */}
      <img
        src={selfHealingFlowSvgUrl}
        alt=""
        className="proto-canvas__img proto-desat-active"
        draggable={false}
        aria-hidden="true"
        style={{
          clipPath: isOverview ? "inset(0 0 0 0)" : clipPath,
          opacity: isOverview ? 1 : 1,
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant B — Zoom / Pan de cámara
//
// Técnica: transform (scale + translate) con spring críticamente amortiguado.
// El encuadre se calcula a partir de SH_FOCUS_BOXES (coords viewBox):
//   1. Encontrar el centro de la bbox en coords viewBox normalizadas [0..1].
//   2. Calcular el scale necesario para que la bbox llene el canvas con margen.
//   3. Calcular el translate para centrar la bbox en el viewport del canvas.
//
// El spring anima scale, translateX, translateY por separado (3 springs) →
// garantiza interpolación sin desyncs en diagonal.
//
// LIMITACIÓN: con object-fit:contain, el transform se aplica a toda la imagen.
// Áreas fuera del canvas original se recortan por overflow:hidden del .proto-canvas.
// ─────────────────────────────────────────────────────────────────────────────

interface CameraTarget {
  scale: number;
  tx: number; // px, relativo al centro del canvas
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

  // Center of bbox in DOM px (relative to canvas origin)
  const bboxCenterX = offsetX + (bbox.x + bbox.w / 2) * scaleX;
  const bboxCenterY = offsetY + (bbox.y + bbox.h / 2) * scaleY;

  // Scale factor: zoom enough so the bbox fills the canvas minus margin
  const bboxDomW = bbox.w * scaleX;
  const bboxDomH = bbox.h * scaleY;
  const scaleNeeded = Math.min(
    (cw * (1 - margin)) / bboxDomW,
    (ch * (1 - margin)) / bboxDomH,
    3.2, // max zoom cap
  );

  // Translate: move bboxCenter to canvas center
  // After scale, point P at (bboxCenterX, bboxCenterY) maps to:
  //   P' = scale * P + translate  (transform-origin: center = cw/2, ch/2)
  // We want P' = (cw/2, ch/2), so:
  //   translate = (cw/2, ch/2) - scale * (bboxCenterX - cw/2, bboxCenterY - ch/2) - (cw/2, ch/2)
  //             = -scale * (bboxCenterX - cw/2, bboxCenterY - ch/2)
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

  // Recompute camera on step change or resize
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

  // Springs for smooth camera motion
  const springScale = useSpringValue(camera.scale, 0.5);
  const springTx = useSpringValue(camera.tx, 0.5);
  const springTy = useSpringValue(camera.ty, 0.5);

  const transform =
    `translate(${springTx.toFixed(2)}px, ${springTy.toFixed(2)}px) scale(${springScale.toFixed(4)})`;

  // Ring overlay: only shown when zoomed in (not overview)
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
// Variant C — Borde / Halo de marca
//
// Técnica: la imagen base se atenúa levemente (brightness + saturate).
// Un ring DOM (div absolutamente posicionado) marca la bbox activa
// con borde Slalom Blue + sombra/glow.
//
// El indicador de conexión (línea del texto al ring) se implementa con un
// <svg> posicionado absolute que se regenera cuando cambia el paso.
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
      if (ring) {
        ring.dataset.hidden = "true";
      }
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
// VariantSection — una instancia completa de la sección scrollytelling
// para una variante dada. Tiene su propio estado de paso activo.
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
  // React 18: useRef<T>(null) produces RefObject<T> where current is T | null at runtime
  const canvasRef = useRef<HTMLDivElement>(null);
  const announcerId = useId();

  // IntersectionObserver: activa el paso cuando entra en zona de lectura
  useEffect(() => {
    if (!isVisible) return;

    // rootMargin: activar cuando el bloque está en el 20-65% central de la viewport
    const observer = new IntersectionObserver(
      (entries) => {
        // Seleccionar el que tenga más intersección (skill §1)
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

  // Announce step change
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
            {/* Diagram canvas — switches by variant */}
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
  const [activeVariant, setActiveVariant] = useState<Variant>("A");

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
                  {v.id} — {v.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <span className="proto-header__step" aria-live="polite">
          {activeVariant === "A" && "Desaturar"}
          {activeVariant === "B" && "Zoom / Pan"}
          {activeVariant === "C" && "Halo"}
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
          <VariantSection
            variant={v}
            isVisible={activeVariant === v.id}
          />
        </div>
      ))}
    </div>
  );
}
