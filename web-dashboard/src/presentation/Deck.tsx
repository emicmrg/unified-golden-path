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
 *   - Keys 1-9: jump directly to slide N. Direction is derived automatically
 *     by SlideWrapper (index vs current) — no extra logic needed.
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { MDXProvider } from "@mdx-js/react";
import { SLIDES, SLIDE_TITLES } from "./slides.js";
import { LiveDashboard } from "../presentation/LiveDashboard.js";
import type { MDXComponents } from "mdx/types";

// ---------------------------------------------------------------------------
// MDX component map — disponible en todos los .mdx sin import local
// ---------------------------------------------------------------------------

const mdxComponents: MDXComponents = {
  LiveDashboard: LiveDashboard as MDXComponents[string],
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
  // Solo añadir slide-body si el <p> no viene ya con className desde el MDX
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
// Posición derivada del ÍNDICE relativo al slide actual (no del estado direction):
//   past   → translateX(-100%)  index < current
//   present → translateX(0)     index === current
//   future  → translateX(+100%) index > current
// Al avanzar: la entrante (future→present) viene desde la DERECHA (+100%→0) ✓
// Al retroceder: la entrante (past→present) viene desde la IZQUIERDA (-100%→0) ✓
// Esto es el comportamiento simétrico esperado.
//
// ACCESIBILIDAD — visibility:hidden con transition-delay:
//   SÍ usamos visibility:hidden, pero con delay = var(--dur-base) para que
//   se aplique AL FINAL de la transición de transform (no en frame 0).
//   Esto saca el subtree del tab order (los <a> de slides inactivas no reciben foco)
//   y resuelve axe aria-hidden-focus (WCAG 2.4.3/2.4.7), sin causar flash
//   porque visibility cambia cuando la slide ya salió del canvas.
//   La slide 'present' recupera visibility:visible inmediatamente (delay 0s).
//   React 18.3.1 no soporta el atributo `inert`, de ahí esta solución CSS.
//
// MODO NORMAL — opacity fijo a 1 (sin fade):
//   Las slides past/future salen del canvas por overflow:hidden de .deck-stage,
//   así que no hace falta animarlas con opacity. Fade de opacity SOLO en
//   prefers-reduced-motion (donde no hay translate y el cross-fade es la única señal).
// ---------------------------------------------------------------------------

interface SlideWrapperProps {
  index: number;
  current: number;
  children: React.ReactNode;
}

function SlideWrapper({ index, current, children }: SlideWrapperProps): React.ReactElement {
  const isActive = index === current;
  // Deriva la posición semántica por índice, no por estado direction global.
  const position: "past" | "present" | "future" =
    index < current ? "past" : index === current ? "present" : "future";

  return (
    <div
      className="slide-wrapper"
      data-active={isActive}
      data-position={position}
      aria-hidden={!isActive}
      // visibility:hidden con delay (ver CSS .slide-wrapper):
      // las slides inactivas salen del tab order al final de la transición.
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar del deck
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
// DotNav — discrete dot navigation (Phase 3A)
// Uses plain <button>s with aria-current — simpler and cheaper than
// aria Tabs pattern (which clashes with existing arrow-key navigation).
// Enter/Space work for free on <button> natively.
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
            // A5: Guard — do NOT navigate when focus-mode dialog is open.
            // jsdom does not evaluate CSS visibility, so this JS guard is
            // necessary for tests (and reliable in all environments).
            if (document.querySelector('[role="dialog"]')) return;
            onJump(i);
          }}
        />
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Controles de navegación flotantes
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
  const deckRef = useRef<HTMLDivElement>(null);
  const total = SLIDES.length;

  const prev = useCallback(() => {
    setCurrent((i) => Math.max(0, i - 1));
  }, []);

  const next = useCallback(() => {
    setCurrent((i) => Math.min(total - 1, i + 1));
  }, [total]);

  // jumpTo: used by DotNav clicks and 1-9 key presses.
  // SlideWrapper derives direction automatically from index vs current —
  // no extra state needed; forward jump enters from right, backward from left.
  const jumpTo = useCallback(
    (i: number) => {
      setCurrent(Math.max(0, Math.min(total - 1, i)));
    },
    [total]
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

  // Sincronizar estado isFullscreen con el evento del browser
  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Guard: target must be an Element (not window/document) to call getAttribute
      if (!(e.target instanceof Element)) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;

      // No interferir si el foco está en un input/textarea
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // B3b FIX: if a focus-mode dialog is open, block ALL deck navigation keys.
      // The only allowed keyboard actions are: Esc (handled in FocusOverlay) and
      // Tab (focus trap, also in FocusOverlay). Arrow keys, Space, PageUp/Down, F,
      // 1-9 and dot-nav clicks must NOT change the slide while the overlay is open.
      const isFocusOpen = !!document.querySelector('[role="dialog"]');

      // No interceptar Space/Enter si el foco está en un elemento interactivo
      // (button nativo, enlace, role=group expand button) — dejar que ellos manejen.
      const isInteractiveTarget =
        tag === "BUTTON" ||
        tag === "A" ||
        target.getAttribute("role") === "button";

      // Phase 3A: numeric keys 1-9 → jump to slide N.
      // Guard: not if focus-mode is open, and not if a modifier key is held
      // (Ctrl+1, Meta+1, Alt+1 have browser-level meanings — do not intercept).
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
          // B3b: block navigation if focus-mode is open
          if (isFocusOpen) { e.preventDefault(); return; }
          if (!isInteractiveTarget) {
            e.preventDefault();
            next();
          }
          break;
        case " ":
          // B3b: block navigation if focus-mode is open
          if (isFocusOpen) { e.preventDefault(); return; }
          // Space on interactive targets: let the element handle it
          if (!isInteractiveTarget) {
            e.preventDefault();
            next();
          }
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          // B3b: block navigation if focus-mode is open
          if (isFocusOpen) { e.preventDefault(); return; }
          if (!isInteractiveTarget) {
            e.preventDefault();
            prev();
          }
          break;
        case "f":
        case "F":
          // B3b: block fullscreen toggle if focus-mode is open
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

  // Slide title for the page/document title (useful when screensharing)
  const currentTitle = useMemo(() => SLIDE_TITLES[current] ?? `Slide ${current + 1}`, [current]);
  useEffect(() => {
    document.title = `${currentTitle} — The Unified Golden Path`;
  }, [currentTitle]);

  return (
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

        {/* Barra de progreso — borde inferior */}
        <ProgressBar current={current} total={total} />
      </div>
    </MDXProvider>
  );
}
