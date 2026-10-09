/**
 * LiveDashboard.tsx — Bento layout for the live dashboard slide.
 *
 * A1 — FocusOverlay no longer receives `origin` (FLIP removed).
 *
 * A2 — aria-controls IDREF fix:
 *   dialogId is now passed to FocusOverlay and applied to <div role="dialog">.
 *   The Expand button's aria-controls always points to a real element in the DOM.
 *
 * A3 — role=group accessible name fix:
 *   Each card container has aria-labelledby pointing to the card heading's id.
 *   cardHeadingId is now wired to both the heading element and the container —
 *   no longer shadowed with _cardHeadingId.
 *
 * B1 — Reliable mouse click:
 *   Explicit "Expand" button plus card-body onClick (skips interactive children).
 *
 * Data logic (hooks, types, classify, config) is NOT touched here.
 */

import React, { useState, useRef, useCallback, useId } from "react";
import { FleetHealth } from "../components/FleetHealth.js";
import { GoldenPath } from "../components/GoldenPath.js";
import { SelfHealing } from "../components/SelfHealing.js";
import { FocusOverlay } from "./FocusOverlay.js";

// ---------------------------------------------------------------------------
// FocusableCard — bento protagonist card that can expand into focus-mode.
// ---------------------------------------------------------------------------

interface FocusableCardProps {
  /** BEM modifier class, e.g. "bento-card--golden" */
  modifierClass: string;
  /**
   * A3: ID of the card's heading element.
   * Applied to the heading <h2> so the container's aria-labelledby reference
   * resolves to a real element (IDREF valid).
   */
  cardHeadingId: string;
  /** Visible heading text */
  cardHeadingText: string;
  /** ARIA label for the "Expand" button */
  expandAriaLabel: string;
  /** Whether this card is currently expanded (focus-mode open) */
  expanded: boolean;
  /** Whether this card should be visually hidden (overlay is open over it) */
  hidden: boolean;
  /** ID of the dialog panel (for aria-controls on the expand button) */
  dialogId: string;
  /** Forwarded ref so the parent can reference the card */
  cardRef: React.RefObject<HTMLDivElement>;
  /** Called when the user activates the expand trigger */
  onOpen: () => void;
  children: React.ReactNode;
}

function FocusableCard({
  modifierClass,
  cardHeadingId,
  cardHeadingText,
  expandAriaLabel,
  expanded,
  hidden,
  dialogId,
  cardRef,
  onOpen,
  children,
}: FocusableCardProps): React.ReactElement {
  // Click on the card body: open focus-mode unless the click originated from
  // a nested interactive element (link or button).
  const handleCardClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("a, button")) return;
      onOpen();
    },
    [onOpen],
  );

  return (
    <div
      ref={cardRef}
      className={`bento-card bento-card--clickable ${modifierClass}`}
      // A3: aria-labelledby now points to the real heading id (IDREF valid).
      role="group"
      aria-labelledby={cardHeadingId}
      data-hidden={hidden}
      onClick={handleCardClick}
    >
      {/* A3: heading has the id that aria-labelledby above references */}
      <h2 id={cardHeadingId} className="sr-only-heading">
        {cardHeadingText}
      </h2>

      {/* Explicit "Expand" button — aria-controls points to the dialog id (A2) */}
      <button
        className="bento-card__expand-btn"
        aria-label={expandAriaLabel}
        aria-expanded={expanded}
        aria-controls={dialogId}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <span aria-hidden="true">⤢</span>
        <span className="bento-card__expand-btn-label">Expand</span>
      </button>

      <div className="bento-card__scroll">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LiveDashboard
// ---------------------------------------------------------------------------

type ActiveCard = "golden" | "healing" | null;

export function LiveDashboard(): React.ReactElement {
  const [activeCard, setActiveCard] = useState<ActiveCard>(null);
  const [closing, setClosing] = useState(false);

  // Stable IDs for aria-controls / aria-labelledby
  const goldenHeadingId = useId();
  const healingHeadingId = useId();
  const dialogId = useId();

  // Refs for the card DOM elements
  const goldenRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
  const healingRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;

  // Ref for the trigger element — focus is restored here on close
  const triggerRef = useRef<HTMLElement | null>(null);

  const openCard = useCallback((which: ActiveCard) => {
    if (!which) return;
    const ref = which === "golden" ? goldenRef : healingRef;
    const el = ref.current;
    if (!el) return;

    // Save the trigger (the Expand button inside the card) for focus-restore.
    const expandBtn = el.querySelector<HTMLElement>(".bento-card__expand-btn");
    triggerRef.current = expandBtn ?? el;

    setActiveCard(which);
    setClosing(false);
  }, []);

  const requestClose = useCallback(() => {
    setClosing(true);
  }, []);

  const onSettledClose = useCallback(() => {
    setActiveCard(null);
    setClosing(false);
  }, []);

  const overlayTitle =
    activeCard === "golden"
      ? "Golden Path — Pipeline Status (expanded)"
      : activeCard === "healing"
        ? "Self-Healing — Auto-Repair Crew (expanded)"
        : "";

  return (
    <div className="live-dashboard" aria-label="Live dashboard — Unified Golden Path">
      {/* Protagonists: GoldenPath + SelfHealing */}
      <div className="bento-hero">
        <FocusableCard
          modifierClass="bento-card--golden"
          cardHeadingId={goldenHeadingId}
          cardHeadingText="Golden Path — Pipeline Status"
          expandAriaLabel="Expand Golden Path panel"
          expanded={activeCard === "golden" && !closing}
          hidden={activeCard === "golden" && !closing}
          dialogId={dialogId}
          cardRef={goldenRef}
          onOpen={() => openCard("golden")}
        >
          <GoldenPath />
        </FocusableCard>

        <FocusableCard
          modifierClass="bento-card--healing"
          cardHeadingId={healingHeadingId}
          cardHeadingText="Self-Healing — Auto-Repair Crew"
          expandAriaLabel="Expand Self-Healing panel"
          expanded={activeCard === "healing" && !closing}
          hidden={activeCard === "healing" && !closing}
          dialogId={dialogId}
          cardRef={healingRef}
          onOpen={() => openCard("healing")}
        >
          <SelfHealing />
        </FocusableCard>
      </div>

      {/* Support: FleetHealth (not expandable) */}
      <div className="bento-support">
        <div className="bento-card bento-card--fleet">
          <div className="bento-card__scroll">
            <FleetHealth />
          </div>
        </div>
      </div>

      {/* A1: FocusOverlay — simple centered panel, no origin rect needed */}
      {activeCard !== null && (
        <FocusOverlay
          title={overlayTitle}
          dialogId={dialogId}
          closing={closing}
          onSettledClose={onSettledClose}
          onRequestClose={requestClose}
          triggerRef={triggerRef}
        >
          {activeCard === "golden" ? <GoldenPath /> : <SelfHealing />}
        </FocusOverlay>
      )}
    </div>
  );
}
