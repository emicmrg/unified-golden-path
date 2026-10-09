/**
 * FocusOverlay.tsx — Focus-mode overlay for bento protagonist cards.
 *
 * A1 — Simple centered panel (replaces FLIP):
 *   The overlay is a fixed, centered panel that animates with a simple
 *   scale 0.92→1.0 + opacity 0→1 entrance (spring: damping 1.0, response ~0.3).
 *   transform-origin: center.  Close is the inverse: 1.0→0.96 + fade-out.
 *   No getBoundingClientRect, no originScale, no FLIP logic.
 *
 * A2 — aria-controls IDREF fix:
 *   Accepts `dialogId` prop and applies it to the <div role="dialog"> so
 *   aria-controls on the expand button always points to a real element.
 *
 * Portal:
 *   Rendered via createPortal(…, document.body) so it escapes the
 *   .slide-wrapper stacking context created by translateX, painting above
 *   .deck-nav / .deck-progress (z-index 200).
 *
 * Reduced-motion:
 *   - Normal mode: spring scale + opacity animation (OUTSIDE media query).
 *   - prefers-reduced-motion: useSpring snaps to the target immediately so
 *     the opacity settles in the same tick; the scrim-out and overlay fade
 *     are therefore imperceptible (< 1 frame). This is intentional: the
 *     reduced-motion contract removes animation, not content.
 *
 * Accessibility:
 *   - role="dialog" aria-modal="true" with stable dialogId.
 *   - Focus moves to the close button on open (rAF, cancelled on unmount).
 *   - Tab is trapped inside the overlay.
 *   - Focus returns to the trigger element on close (synchronous — triggerRef
 *     is always mounted; focus is called before onRequestClose so it is never
 *     cancelled by an unmount rAF race under prefers-reduced-motion).
 *   - Escape closes.
 */

import React, {
  useEffect,
  useRef,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { useSpring } from "../hooks/useSpring.js";

// FocusRect kept for backwards compatibility (still exported in case importers use it)
export interface FocusRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FocusOverlayProps {
  /** Title shown as aria-label and visible heading */
  title: string;
  /** Stable id applied to the <div role="dialog"> — must match aria-controls on the trigger */
  dialogId: string;
  /** Whether the overlay is in its closing animation phase */
  closing: boolean;
  /** Called when the close animation has settled (unmount trigger) */
  onSettledClose: () => void;
  /** Called to initiate the close sequence */
  onRequestClose: () => void;
  /** The trigger element — focus is restored here on close */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Content to display inside the overlay */
  children: React.ReactNode;
}

export function FocusOverlay({
  title,
  dialogId,
  closing,
  onSettledClose,
  onRequestClose,
  triggerRef,
  children,
}: FocusOverlayProps): React.ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // ── A1: Simple scale+opacity spring — no rect measurement ──────────────
  //
  // Open:  scale 0.92 → 1.0  (initialValue = 0.92 so spring starts there)
  //        opacity 0 → 1
  // Close: scale 1.0 → 0.96  (spring continues from current ≈1.0)
  //        opacity 1 → 0
  //
  // useSpring(target, response, initialValue?)
  //   - For open: initialValue=0.92 ensures the spring starts at the small value
  //     and grows to 1. Without initialValue it would start at 1 (no animation).
  //   - For close: no initialValue; spring continues from wherever open settled.
  const scaleTarget  = closing ? 0.96 : 1.0;
  const scaleInitial = closing ? undefined : 0.92;   // only seed on open
  const opacityTarget  = closing ? 0 : 1;
  const opacityInitial = closing ? undefined : 0;    // only seed on open

  const scale   = useSpring(scaleTarget,   0.3, scaleInitial);
  const opacity = useSpring(opacityTarget, 0.3, opacityInitial);

  // Detect settle after close to trigger unmount.
  useEffect(() => {
    if (!closing) return;
    if (Math.abs(opacity - 0) < 0.01 && Math.abs(scale - 0.96) < 0.01) {
      onSettledClose();
    }
  }, [closing, opacity, scale, onSettledClose]);

  // Move focus to close button on open — cancel rAF on unmount.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Mark body[data-focus-open="true"] while the overlay is mounted so the deck
  // chrome (.deck-nav, .deck-progress) can be hidden/inert via CSS without
  // needing shared state between FocusOverlay and Deck.
  useEffect(() => {
    document.body.setAttribute("data-focus-open", "true");
    return () => {
      document.body.removeAttribute("data-focus-open");
    };
  }, []);

  // Restore focus to trigger on close — synchronous so it is never cancelled
  // by an unmount race under prefers-reduced-motion (where useSpring snaps
  // instantly → settle → onSettledClose → setActiveCard(null) → unmount,
  // all before the next animation frame fires).
  // The trigger button (Expand) is ALWAYS mounted during closing
  // (closing=true → hidden=false → [data-hidden=true]{visibility:hidden} no
  // longer applies), so focus() is safe to call before onRequestClose().
  const handleClose = useCallback(() => {
    triggerRef.current?.focus(); // sync: trigger is mounted during closing
    onRequestClose();
  }, [onRequestClose, triggerRef]);

  // Keyboard: Escape closes; Tab is trapped inside the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }

      // Focus trap: keep Tab inside the overlay.
      if (e.key === "Tab") {
        const overlay = overlayRef.current;
        if (!overlay) return;

        const focusable = Array.from(
          overlay.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => {
          if (el.hasAttribute("disabled")) return false;
          const ti = el.getAttribute("tabindex");
          if (ti !== null && parseInt(ti, 10) > 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          return true;
        });

        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusable[0];
        const last  = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const overlayContent = (
    <>
      {/* Scrim — dim background behind overlay */}
      <div
        className="bento-focus-scrim"
        aria-hidden="true"
        onClick={handleClose}
        data-closing={closing}
      />

      {/* Overlay panel — A1: animated with scale+opacity spring, transform-origin: center */}
      <div
        ref={overlayRef}
        id={dialogId}
        className="bento-focus-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-closing={closing}
        style={{
          transformOrigin: "center",
          transform: `scale(${scale})`,
          opacity,
        }}
      >
        <button
          ref={closeButtonRef}
          className="bento-focus-overlay__close"
          onClick={handleClose}
          aria-label="Close panel"
        >
          ✕
        </button>
        <div className="bento-focus-overlay__content">
          {children}
        </div>
      </div>
    </>
  );

  return createPortal(overlayContent, document.body);
}
