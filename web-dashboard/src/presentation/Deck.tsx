/**
 * Deck.tsx — Motor de slides para The Unified Golden Path.
 *
 * Arquitectura:
 * - Todas las slides se renderizan simultáneamente (nunca unmount) para
 *   mantener <LiveDashboard/> montado y haciendo polling aunque no esté visible.
 * - Transición horizontal CSS con spring críticamente amortiguado (bounce=0).
 * - Respeta prefers-reduced-motion: cross-fade 200ms en vez de slide.
 * - Teclas: ← → (y Espacio/PageDown/PageUp) para navegar; 'f' para fullscreen.
 * - Teclas 1-9: salto directo a la slide N (Phase 3A).
 * - Formato 16:9 centrado, escalable con transform: scale() al viewport.
 *
 * Phase 3A additions:
 *   - DotNav: discrete dot row below the slide counter, one per slide,
 *     aria-current on active, keyboard-navigable (Tab + Enter/Space).
 *   - Keys 1-9: jump directly to slide N.
 *
 * Sub-step coordination — CONTEXT-BASED (remount fix):
 *
 *   ROOT CAUSE of previous remount: buildMdxComponents was called with
 *   deps=[current, subSteps], creating a NEW BoundArchDiagram function type
 *   on every step change. React unmounts and remounts components when their
 *   type reference changes inside MDXProvider.
 *
 *   FIX: the MDX component map is built ONCE via useMemo(deps=[]) — stable
 *   identity across all renders. The ArchitectureDiagram reads the current
 *   sub-step via SubStepContext instead of props. The Deck wraps MDXProvider
 *   in <SubStepContext.Provider value={ctxValue}> where ctxValue updates on
 *   every step change. The diagram re-reads context → re-renders without
 *   unmounting. The aria-live region is the SAME DOM node across steps.
 *
 *   Pattern scales to diagrams B and C: each diagram registers itself in
 *   SLIDE_REGISTRY (in slides.ts — single source of truth) with an explicit
 *   slideIndex and stepCount. No findIndex fragility.
 *
 * SLIDE_REGISTRY (explicit slide→diagram mapping) — defined in slides.ts:
 *   Maps slideIndex → { stepCount } so that:
 *   - stepCount: how many sub-steps this slide has (0 = none).
 *   This is the SINGLE SOURCE OF TRUTH; SLIDE_STEP_COUNTS is derived from it
 *   so they can never diverge. Deck.tsx imports SLIDE_REGISTRY from slides.ts.
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { MDXProvider } from "@mdx-js/react";
import { SLIDES, SLIDE_TITLES, SLIDE_REGISTRY, ARCH_SLIDE_INDEX, CREW_SLIDE_INDEX, SH_SLIDE_INDEX } from "./slides.js";
import { LiveDashboard } from "../presentation/LiveDashboard.js";
import {
  ArchitectureDiagram,
  SubStepContext,
} from "../presentation/ArchitectureDiagram.js";
import { CrewDiagram, CrewSubStepContext } from "../presentation/CrewDiagram.js";
import { SelfHealingDiagram, SelfHealingSubStepContext } from "../presentation/SelfHealingDiagram.js";
import type { MDXComponents } from "mdx/types";

// ---------------------------------------------------------------------------
// SLIDE_REGISTRY — imported from slides.ts (single source of truth).
// Deck reads it here to drive sub-step navigation without duplicating the data.
// To add a diagram B or C, add it to slides.ts SLIDE_REGISTRY.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MDX component map — STABLE (built once, useMemo deps=[]).
//
// ArchitectureDiagram is defined at module level in ArchitectureDiagram.tsx
// (stable type reference). It reads sub-step from SubStepContext — NO props
// bound here. This is the key to preventing remounts.
//
// The Deck wraps the MDXProvider in a SubStepContext.Provider whose value
// changes on each step, causing only a context update (re-render without
// unmount) in the diagram component.
// ---------------------------------------------------------------------------

const STABLE_MDX_COMPONENTS: MDXComponents = {
  LiveDashboard: LiveDashboard as MDXComponents[string],
  ArchitectureDiagram: ArchitectureDiagram as MDXComponents[string],
  CrewDiagram: CrewDiagram as MDXComponents[string],
  SelfHealingDiagram: SelfHealingDiagram as MDXComponents[string],
  // Tipografía display estilo Apple — Slalom light theme
  h1: ({ children, ...props }) => (
    <h1 className="slide-h1" {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="slide-h2" {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="slide-h3" {...props}>{children}</h3>
  ),
  p: ({ children, className, ...props }) => (
    <p className={className ?? "slide-body"} {...props}>{children}</p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="slide-list" {...props}>{children}</ul>
  ),
  li: ({ children, ...props }) => (
    <li className="slide-list__item" {...props}>{children}</li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="slide-strong" {...props}>{children}</strong>
  ),
  code: ({ children, ...props }) => (
    <code className="slide-code" {...props}>{children}</code>
  ),
};

// ---------------------------------------------------------------------------
// Slide wrapper con transición CSS horizontal
// ─────────────────────────────────────────────────────────────────────────
// Position derived from index vs current (not direction state):
//   past    → translateX(-100%)
//   present → translateX(0)
//   future  → translateX(+100%)
//
// ACCESSIBILITY — visibility:hidden con transition-delay:
//   SÍ usamos visibility:hidden, pero con delay = var(--dur-base) para que
//   se aplique AL FINAL de la transición de transform (no en frame 0).
//   Esto saca el subtree del tab order (los <a> de slides inactivas no reciben
//   foco) sin causar flash porque visibility cambia cuando la slide ya salió.
// ---------------------------------------------------------------------------

interface SlideWrapperProps {
  index: number;
  current: number;
  children: React.ReactNode;
}

function SlideWrapper({ index, current, children }: SlideWrapperProps): React.ReactElement {
  const isActive = index === current;
  const position: "past" | "present" | "future" =
    index < current ? "past" : index === current ? "present" : "future";

  return (
    <div
      className="slide-wrapper"
      data-active={isActive}
      data-position={position}
      aria-hidden={!isActive}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar({ current, total }: { current: number; total: number }): React.ReactElement {
  const pct = ((current + 1) / total) * 100;
  return (
    <div
      className="deck-progress"
      role="progressbar"
      aria-label={`Slide ${current + 1} of ${total}`}
      aria-valuenow={current + 1}
      aria-valuemin={1}
      aria-valuemax={total}
    >
      <div
        className="deck-progress__fill"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DotNav — Phase 3A
// ---------------------------------------------------------------------------

interface DotNavProps {
  current: number;
  total: number;
  titles: string[];
  onJump: (index: number) => void;
}

function DotNav({ current, total, titles, onJump }: DotNavProps): React.ReactElement {
  return (
    <nav className="deck-dotnav" aria-label="Jump to slide">
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          className="deck-dotnav__dot"
          data-active={i === current}
          aria-current={i === current ? "true" : undefined}
          aria-label={`Slide ${i + 1}: ${titles[i] ?? `Slide ${i + 1}`}`}
          onClick={() => {
            if (document.querySelector('[role="dialog"]')) return;
            onJump(i);
          }}
        />
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// NavControls
// ---------------------------------------------------------------------------

interface NavControlsProps {
  current: number;
  total: number;
  titles: string[];
  onPrev: () => void;
  onNext: () => void;
  onFullscreen: () => void;
  onJump: (index: number) => void;
  isFullscreen: boolean;
}

function NavControls({
  current,
  total,
  titles,
  onPrev,
  onNext,
  onFullscreen,
  onJump,
  isFullscreen,
}: NavControlsProps): React.ReactElement {
  return (
    <nav className="deck-nav" aria-label="Slide navigation">
      <button
        className="deck-nav__btn deck-nav__btn--prev"
        onClick={onPrev}
        disabled={current === 0}
        aria-label="Previous slide"
      >
        ‹
      </button>

      <div className="deck-nav__center">
        <span className="deck-nav__counter" aria-live="polite" aria-atomic="true">
          {current + 1} <span aria-hidden="true">/</span> {total}
        </span>
        <DotNav current={current} total={total} titles={titles} onJump={onJump} />
      </div>

      <button
        className="deck-nav__btn deck-nav__btn--next"
        onClick={onNext}
        disabled={current === total - 1}
        aria-label="Next slide"
      >
        ›
      </button>

      <button
        className="deck-nav__btn deck-nav__btn--fs"
        onClick={onFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen (F)"}
        title={isFullscreen ? "Exit (Esc)" : "Fullscreen (f)"}
      >
        {isFullscreen ? "⤡" : "⤢"}
      </button>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Deck principal
// ---------------------------------------------------------------------------

export function Deck(): React.ReactElement {
  const [current, setCurrent] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Sub-step state: maps slideIndex → current sub-step (0-based).
  const [subSteps, setSubSteps] = useState<Record<number, number>>({});
  const deckRef = useRef<HTMLDivElement>(null);
  const total = SLIDES.length;

  // Helper: how many sub-steps does a slide have (from SLIDE_REGISTRY; 0 = none)
  const getStepCount = useCallback((slideIndex: number): number => {
    return SLIDE_REGISTRY[slideIndex]?.stepCount ?? 0;
  }, []);

  // Helper: current sub-step for a slide
  const getSubStep = useCallback(
    (slideIndex: number): number => subSteps[slideIndex] ?? 0,
    [subSteps],
  );

  // Navigate to prev: either retreat sub-step or go to prev slide
  const prev = useCallback(() => {
    const stepCount = getStepCount(current);
    const subStep = getSubStep(current);
    if (stepCount > 0 && subStep > 0) {
      setSubSteps((s) => ({ ...s, [current]: subStep - 1 }));
    } else {
      setCurrent((i) => Math.max(0, i - 1));
    }
  }, [current, getStepCount, getSubStep]);

  // Navigate to next: either advance sub-step or go to next slide
  const next = useCallback(() => {
    const stepCount = getStepCount(current);
    const subStep = getSubStep(current);
    if (stepCount > 0 && subStep < stepCount - 1) {
      setSubSteps((s) => ({ ...s, [current]: subStep + 1 }));
    } else {
      setCurrent((i) => Math.min(total - 1, i + 1));
    }
  }, [current, total, getStepCount, getSubStep]);

  // jumpTo: used by DotNav clicks and 1-9 key presses.
  // Resets sub-step of the target slide to 0 (fresh start).
  const jumpTo = useCallback(
    (i: number) => {
      const target = Math.max(0, Math.min(total - 1, i));
      setCurrent(target);
      setSubSteps((s) => ({ ...s, [target]: 0 }));
    },
    [total],
  );

  const toggleFullscreen = useCallback(() => {
    const el = deckRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch((err) => {
        console.warn("Fullscreen not available:", err);
      });
    } else {
      document.exitFullscreen().catch(console.warn);
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.target instanceof Element)) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;

      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const isFocusOpen = !!document.querySelector('[role="dialog"]');
      const isInteractiveTarget =
        tag === "BUTTON" ||
        tag === "A" ||
        target.getAttribute("role") === "button";

      if (e.key >= "1" && e.key <= "9") {
        if (isFocusOpen) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const n = Number(e.key);
        if (n <= total) {
          e.preventDefault();
          jumpTo(n - 1);
        }
        return;
      }

      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
          if (isFocusOpen) { e.preventDefault(); return; }
          if (!isInteractiveTarget) { e.preventDefault(); next(); }
          break;
        case " ":
          if (isFocusOpen) { e.preventDefault(); return; }
          if (!isInteractiveTarget) { e.preventDefault(); next(); }
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          if (isFocusOpen) { e.preventDefault(); return; }
          if (!isInteractiveTarget) { e.preventDefault(); prev(); }
          break;
        case "f":
        case "F":
          if (isFocusOpen) return;
          toggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [next, prev, jumpTo, toggleFullscreen, total]);

  // Document title
  const currentTitle = useMemo(() => SLIDE_TITLES[current] ?? `Slide ${current + 1}`, [current]);
  useEffect(() => {
    document.title = `${currentTitle} — AI, IoT & Cloud`;
  }, [currentTitle]);

  // ── STABLE MDX component map — useMemo(deps=[]) ───────────────────────
  // This never changes identity, so ArchitectureDiagram is NEVER remounted
  // between sub-steps. Sub-step state is delivered via SubStepContext below.
  const mdxComponents = useMemo(() => STABLE_MDX_COMPONENTS, []);

  // ── SubStepContext value — drives ArchitectureDiagram (ARCH_SLIDE_INDEX) ─
  // Uses subSteps[ARCH_SLIDE_INDEX] regardless of the current slide, so the
  // Architecture diagram doesn't jump to the Crew diagram's step.
  const subStepCtxValue = useMemo(
    () => ({
      subStep: subSteps[ARCH_SLIDE_INDEX] ?? 0,
      isActive: current === ARCH_SLIDE_INDEX,
    }),
    [current, subSteps],
  );

  // ── CrewSubStepContext value — drives CrewDiagram (CREW_SLIDE_INDEX) ──────
  // Uses subSteps[CREW_SLIDE_INDEX] regardless of the current slide, so the
  // Crew diagram doesn't affect ArchitectureDiagram.
  const crewSubStepCtxValue = useMemo(
    () => ({
      subStep: subSteps[CREW_SLIDE_INDEX] ?? 0,
      isActive: current === CREW_SLIDE_INDEX,
    }),
    [current, subSteps],
  );

  // ── SelfHealingSubStepContext value — drives SelfHealingDiagram (SH_SLIDE_INDEX) ──
  // Uses subSteps[SH_SLIDE_INDEX] regardless of the current slide, so the
  // Self-Healing diagram doesn't affect ArchitectureDiagram or CrewDiagram.
  const shSubStepCtxValue = useMemo(
    () => ({
      subStep: subSteps[SH_SLIDE_INDEX] ?? 0,
      isActive: current === SH_SLIDE_INDEX,
    }),
    [current, subSteps],
  );

  return (
    <SubStepContext.Provider value={subStepCtxValue}>
      <CrewSubStepContext.Provider value={crewSubStepCtxValue}>
      <SelfHealingSubStepContext.Provider value={shSubStepCtxValue}>
      <MDXProvider components={mdxComponents}>
        <div
          ref={deckRef}
          className="deck"
          data-fullscreen={isFullscreen}
          aria-roledescription="presentation"
          aria-label={`Presentation: ${currentTitle}`}
        >
          {/* Stage — contiene todos los slides solapados */}
          <div className="deck-stage">
            {SLIDES.map((SlideContent, i) => (
              <SlideWrapper key={i} index={i} current={current}>
                <div className="slide-inner">
                  <SlideContent />
                </div>
              </SlideWrapper>
            ))}
          </div>

          {/* Controles flotantes con DotNav integrado */}
          <NavControls
            current={current}
            total={total}
            titles={SLIDE_TITLES}
            onPrev={prev}
            onNext={next}
            onFullscreen={toggleFullscreen}
            onJump={jumpTo}
            isFullscreen={isFullscreen}
          />

          {/* Barra de progreso */}
          <ProgressBar current={current} total={total} />
        </div>
      </MDXProvider>
      </SelfHealingSubStepContext.Provider>
      </CrewSubStepContext.Provider>
    </SubStepContext.Provider>
  );
}
