/**
 * CrewDiagram.tsx — Diagrama B: Self-Healing Crew (CrewAI anatomy).
 *
 * PATTERN: mirrors ArchitectureDiagram (Diagrama A) exactly:
 *   Lucid SVG as full background + ScrimOverlay (SVG <mask> spotlight) +
 *   sidebar panel, all driven by SubStepContext from the Deck.
 *
 * SVG METADATA (crew-agents.svg):
 *   Root: width="2077.58" height="1653"
 *   Inner <g transform="translate(2056.083095113997 300)">
 *   All bounding boxes below are in outer (viewBox) coordinates:
 *     outer_x = svg_x + 2056.083
 *     outer_y = svg_y + 300
 *
 * FOCUS ORDER (approved by Emilio):
 *   Step 0  = Overview (full diagram, no highlight)
 *   Step 1  = CI Log Analyst agent card
 *   Step 2  = CI Repair Engineer agent card
 *   Step 3  = CI Patch Reviewer agent card
 *   Step 4  = Shared Runtime / Harness (Bedrock + guardrails)
 *   Step 5  = Full overview again (no highlight)
 *
 * BOUNDING BOX DERIVATION:
 *   Agent cards — outer rounded rect (path M-1360 212 → V988 for agent 1, etc.):
 *     Agent 1 (log-analyst):   M-1360 212 → w=380 h=776  →  x=696,   y=512
 *     Agent 2 (fix-engineer):  M-900  212 → w=380 h=776  →  x=1156,  y=512
 *     Agent 3 (reviewer):      M-440  212 → w=380 h≈749  →  x=1616,  y=512
 *   Outer container (orange border: M-1440-30.85H20V1080):
 *     x=616, y=269, w=1460, h=1111
 *   Amazon Bedrock section (large rect inside container, bottom area):
 *     Bedrock icon at M-1966.3 370.7 w=277.5 h=84.36 → viewBox: x=90, y=671
 *     The full bottom runtime row (roughly y=900..1380 based on SVG content):
 *     We use the outer container width clipped to Bedrock+process area:
 *       x=600, y=869, w=1480, h=480
 *
 * SCRIM / SPOTLIGHT TECHNIQUE — identical to ArchitectureDiagram:
 *   SVG <mask>: white base (scrim everywhere) + black holes (spotlight).
 *   NO clipPath (known broken approach). Cross-fade. reduced-motion: no anim.
 *
 * COORDINATION: SubStepContext (re-exported from ArchitectureDiagram — same
 * stable context, same Deck provider). No new context needed.
 *
 * ACCESSIBILITY: aria-live announces active agent. role="region".
 * REDUCED MOTION: overlay switches instantly (no cross-fade).
 */

import React, { createContext, useContext, useEffect, useId, useState } from "react";
// Reuse ArchitectureDiagram's CSS — same class names, same look.
import "./ArchitectureDiagram.css";
// Import SVG as URL (Vite asset URL import, same pattern as Diagram A).
import crewAgentsSvgUrl from "./assets/crew-agents.svg";
// Import SubStepContextValue type and BBox from ArchitectureDiagram.
// CrewDiagram uses its OWN CrewSubStepContext (defined below) to avoid
// contaminating ArchitectureDiagram when both are rendered simultaneously.
import type { BBox, SubStepContextValue } from "./ArchitectureDiagram.js";

// ─────────────────────────────────────────────────────────────────────────────
// SVG viewBox dimensions (from root <svg> attributes)
// ─────────────────────────────────────────────────────────────────────────────

export const CREW_SVG_VB_W = 2077.58;
export const CREW_SVG_VB_H = 1653;

// ─────────────────────────────────────────────────────────────────────────────
// Focus bounding boxes (in viewBox coordinates)
//
// Derivation: SVG element coords + translate(2056.083, 300).
// All three agent cards share the same top (y=512) and height (≈776px).
//
// Agent 1 (log-analyst):
//   SVG rect M-1360 212 → v(988-212)=776, w=380
//   viewBox: x=-1360+2056.083=696.083, y=212+300=512, w=380, h=776
//
// Agent 2 (fix-engineer):
//   SVG rect M-900 212 → h=776, w=380
//   viewBox: x=-900+2056.083=1156.083, y=512, w=380, h=776
//
// Agent 3 (reviewer):
//   SVG rect M-440 212 → h≈749, w=380
//   viewBox: x=-440+2056.083=1616.083, y=512, w=380, h=749
//
// Shared Runtime / Harness (Bedrock + process):
//   The orange outer border: M-1440-30.85H20V1080 →
//     x=-1440+2056.083=616.083, y=-30.85+300=269.15, w=1460, h=1110.85
//   We focus only on the lower ~half: the Bedrock icon + CI process block
//   are visually in y≈870..1380 (viewBox). Use a generous box that covers
//   the full-width of the container and the bottom half:
//     x=600, y=865, w=1480, h=490
// ─────────────────────────────────────────────────────────────────────────────

export const CREW_FOCUS_BOXES: (BBox | null)[] = [
  null,  // Step 0: overview (no highlight)
  // Step 1: CI Log Analyst (agent card 1, left)
  { x: 693, y: 509, w: 384, h: 783 },
  // Step 2: CI Repair Engineer (agent card 2, center)
  { x: 1153, y: 509, w: 384, h: 783 },
  // Step 3: CI Patch Reviewer (agent card 3, right)
  { x: 1613, y: 509, w: 384, h: 783 },
  // Step 4: crewai + Amazon Bedrock card (left panel, lower section)
  // Verified by reviewer with real render: x=1..457, y=611..1038
  { x: 1, y: 611, w: 456, h: 427 },
  null,  // Step 5: final overview (no highlight)
];

export const CREW_DIAGRAM_STEP_COUNT = CREW_FOCUS_BOXES.length; // 6 (steps 0..5)

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar step data — English, sourced from agents.py / tasks.py
// ─────────────────────────────────────────────────────────────────────────────

export interface CrewStepData {
  id: string;
  title: string;
  bullets: string[];
}

export const CREW_STEPS: CrewStepData[] = [
  {
    id: "overview",
    title: "Self-Healing Crew — CrewAI Agents",
    bullets: [
      "Sequential pipeline: CI Log Analyst → CI Repair Engineer → CI Patch Reviewer",
      "Shared runtime: Amazon Bedrock Claude Sonnet 4.5 (temp 0.1) for all three agents",
      "System guardrails: DynamoDB circuit breaker (max 2 attempts), anti-main branch lock, verdict gate",
    ],
  },
  {
    id: "log-analyst",
    title: "Agent 1 — CI Log Analyst",
    bullets: [
      "Role: CI Log Analyst — diagnoses root cause from the raw CI log",
      "Goal: identify error type, file:line, cause, and context; cite the exact log line",
      "Backstory: senior platform engineer, methodical, never guesses — always quotes evidence",
      "Harness: max_iter 3 · max_retry 2 · allow_delegation false",
      "Input: raw CI log → Output: structured RCA (root-cause analysis)",
    ],
  },
  {
    id: "fix-engineer",
    title: "Agent 2 — CI Repair Engineer",
    bullets: [
      "Role: CI Repair Engineer — produces the minimal, surgical patch",
      "Goal: return the COMPLETE corrected file (not a diff) using FILE_PATH / <<<FILE_CONTENT>>> markers",
      "Backstory: full-stack engineer, no new dependencies, smallest possible change",
      "Harness: max_iter 3 · max_retry 2 · allow_delegation false",
      "Input: real file content + RCA → Output: corrected file ready to commit",
    ],
  },
  {
    id: "reviewer",
    title: "Agent 3 — CI Patch Reviewer",
    bullets: [
      "Role: CI Patch Reviewer — final quality and security gate",
      "Goal: last line of output must be exactly VERDICT: APPLY or VERDICT: REJECT",
      "Backstory: senior reviewer, security & quality focus; if in doubt, reject",
      "Harness: max_iter 2 · max_retry 1 (strictest) · allow_delegation false",
      "Input: diagnosis + patch → Output: VERDICT: APPLY or VERDICT: REJECT",
    ],
  },
  {
    id: "shared-runtime",
    title: "Shared Runtime & Guardrails",
    bullets: [
      "LLM: Amazon Bedrock Claude Sonnet 4.5 (temperature 0.1) — same model for all 3 agents",
      "Orchestration: CrewAI sequential process with context chaining (each agent reads prior output)",
      "Runtime guardrails (outside this diagram): DynamoDB circuit breaker (max 2 attempts) · anti-main branch lock · verdict gate opens PR only on VERDICT: APPLY",
    ],
  },
  {
    id: "overview-final",
    title: "Self-Healing Crew — CrewAI Agents (Final)",
    bullets: [
      "Sequential pipeline: CI Log Analyst → CI Repair Engineer → CI Patch Reviewer",
      "Shared runtime: Amazon Bedrock Claude Sonnet 4.5 (temp 0.1) for all three agents",
      "System guardrails: DynamoDB circuit breaker (max 2 attempts), anti-main branch lock, verdict gate",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CrewSubStepContext — separate context for the Crew slide.
//
// Reason: the Deck renders ALL slides simultaneously (never unmounts) and uses
// a SINGLE SubStepContext shared by all MDX components. When navigating the
// Crew slide, ArchitectureDiagram would also receive the sub-step updates
// because it reads the same context.
//
// Solution: CrewDiagram reads its own CrewSubStepContext (provided by Deck
// only when the Crew slide is active). ArchitectureDiagram continues to read
// SubStepContext exclusively.
// ─────────────────────────────────────────────────────────────────────────────

export const CrewSubStepContext = createContext<SubStepContextValue>({
  subStep: 0,
  isActive: false,
});

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

// ─────────────────────────────────────────────────────────────────────────────
// ScrimOverlay — identical technique to ArchitectureDiagram.
//
// SVG <mask>: white rect (scrim visible everywhere) + black hole(s) at
// active bbox (scrim NOT drawn there → spotlight).
// Uses CREW_SVG_VB_W / CREW_SVG_VB_H so dimensions match crew-agents.svg.
// ─────────────────────────────────────────────────────────────────────────────

interface CrewScrimOverlayProps {
  bbox: BBox;
  reducedMotion: boolean;
}

function CrewScrimOverlay({ bbox, reducedMotion }: CrewScrimOverlayProps): React.ReactElement {
  const PAD = 12;
  const maskId = `crew-scrim-mask-${useId().replace(/:/g, "")}`;

  const padBBox = (b: BBox) => {
    const x = Math.max(0, b.x - PAD);
    const y = Math.max(0, b.y - PAD);
    const w = Math.min(CREW_SVG_VB_W - x, b.w + PAD * 2);
    const h = Math.min(CREW_SVG_VB_H - y, b.h + PAD * 2);
    return { x, y, w, h };
  };

  const primary = padBBox(bbox);
  const rx = 14;

  return (
    <svg
      className="arch-scrim"
      viewBox={`0 0 ${CREW_SVG_VB_W} ${CREW_SVG_VB_H}`}
      aria-hidden="true"
      data-reduced-motion={reducedMotion}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          {/* White base: scrim drawn everywhere */}
          <rect x="0" y="0" width={CREW_SVG_VB_W} height={CREW_SVG_VB_H} fill="white" />
          {/* Black hole: scrim NOT drawn at the active bbox (spotlight) */}
          <rect
            x={primary.x}
            y={primary.y}
            width={primary.w}
            height={primary.h}
            rx={rx}
            fill="black"
          />
        </mask>
      </defs>

      {/* Scrim — covers everything EXCEPT the punched-out bbox region */}
      <rect
        x="0"
        y="0"
        width={CREW_SVG_VB_W}
        height={CREW_SVG_VB_H}
        fill="rgba(0, 0, 0, 0.52)"
        mask={`url(#${maskId})`}
      />

      {/* Highlight ring around the active agent card */}
      <rect
        x={primary.x}
        y={primary.y}
        width={primary.w}
        height={primary.h}
        rx={rx}
        fill="none"
        stroke="#0C62FB"
        strokeWidth="3"
        opacity="0.85"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CrewDiagram — module-level stable component (same pattern as ArchitectureDiagram)
//
// Layout (same CSS classes as ArchitectureDiagram):
//   .arch-diagram (flex row):
//     .arch-canvas-wrap (flex-1): Lucid SVG background + scrim
//     .arch-sidebar (~30%): agent info panel (hidden when showSidebar=false)
//
// Props:
//   showSidebar — controls whether the internal sidebar panel is rendered.
//     Default: true (standalone use). Pass false when embedding inside
//     ScrollDeck, where the left-column narrative already shows step content.
// ─────────────────────────────────────────────────────────────────────────────

interface CrewDiagramProps {
  /** Show the internal sidebar step panel. Default true. */
  showSidebar?: boolean;
}

export function CrewDiagram({ showSidebar = true }: CrewDiagramProps): React.ReactElement {
  const { subStep: step, isActive } = useContext(CrewSubStepContext);
  const reducedMotion = usePrefersReducedMotion();

  const currentStepData = CREW_STEPS[step] ?? CREW_STEPS[0];
  const activeBBox = CREW_FOCUS_BOXES[step] ?? null;
  const isOverview = activeBBox === null;

  // aria-live announcement
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  useEffect(() => {
    if (!isActive) return;
    if (isOverview) {
      const suffix = step === 0 ? "— press → to explore each agent" : "— full overview";
      setLiveAnnouncement(`Self-Healing Crew diagram overview ${suffix}`);
    } else {
      setLiveAnnouncement(
        `Step ${step} of ${CREW_DIAGRAM_STEP_COUNT - 1}: ${currentStepData.title}. ${currentStepData.bullets.join(" ")}`,
      );
    }
  }, [step, isActive, currentStepData, isOverview]);

  const isFirstOverview = step === 0;

  return (
    <div
      className="arch-diagram"
      role="region"
      aria-label="CrewAI Agents Diagram"
      tabIndex={-1}
      data-reduced-motion={reducedMotion}
    >
      {/* Screen-reader live region — persistent (never remounted) */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="arch-sr-only"
      >
        {liveAnnouncement}
      </div>

      {/* ── Canvas area ──────────────────────────────────────────────── */}
      <div className="arch-canvas-wrap">
        {/* Lucid SVG background — self-hosted asset, meets CSP img-src 'self' */}
        <img
          src={crewAgentsSvgUrl}
          alt="CrewAI self-healing agents diagram showing CI Log Analyst, CI Repair Engineer, and CI Patch Reviewer with Amazon Bedrock shared runtime"
          className="arch-lucid-svg"
          draggable={false}
        />

        {/* Scrim overlay — only when a non-overview step has an active bbox */}
        {!isOverview && activeBBox && (
          <div
            key={step}
            className={`arch-scrim-wrap${reducedMotion ? " arch-scrim-wrap--no-anim" : ""}`}
          >
            <CrewScrimOverlay bbox={activeBBox} reducedMotion={reducedMotion} />
          </div>
        )}
      </div>

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      {showSidebar && (isFirstOverview ? (
        <aside
          className="arch-sidebar arch-sidebar--overview"
          aria-label="Diagram overview"
        >
          <div className="arch-sidebar__inner arch-sidebar__inner--overview">
            <h3 className="arch-sidebar__title">Self-Healing Crew</h3>
            <ul className="arch-sidebar__list">
              {CREW_STEPS[0].bullets.map((bullet, i) => (
                <li key={i} className="arch-sidebar__item">
                  {bullet}
                </li>
              ))}
            </ul>
            <div className="arch-sidebar__nav arch-sidebar__nav--hint" aria-label="Navigation hint">
              <span className="arch-sidebar__hint-big">
                Press <kbd>→</kbd> to explore each agent
              </span>
            </div>
          </div>
        </aside>
      ) : (
        <aside
          key={step}
          className="arch-sidebar"
          aria-label={`Explanation: ${currentStepData.title}`}
        >
          <div className="arch-sidebar__inner">
            <h3 className="arch-sidebar__title">{currentStepData.title}</h3>
            <ul className="arch-sidebar__list">
              {currentStepData.bullets.map((bullet, i) => (
                <li key={i} className="arch-sidebar__item">
                  {bullet}
                </li>
              ))}
            </ul>
            <div className="arch-sidebar__nav" aria-label="Step indicator">
              <span className="arch-sidebar__step">
                {step} / {CREW_DIAGRAM_STEP_COUNT - 1}
              </span>
              <span className="arch-sidebar__hint">← → to navigate</span>
            </div>
          </div>
        </aside>
      ))}
    </div>
  );
}
