/**
 * slides.ts — Registro de slides del deck.
 *
 * Importa cada .mdx como componente React (compilado por @mdx-js/rollup en Vite).
 * El orden del array es el orden de la presentación.
 *
 * Para agregar una slide: importarla y añadirla a SLIDES + SLIDE_TITLES.
 * Para registrar sub-steps de un diagrama nuevo, añade una entrada a SLIDE_REGISTRY
 * con el índice explícito → stepCount.
 *
 * SINGLE SOURCE OF TRUTH — SLIDE_REGISTRY is defined here and exported so both
 * Deck.tsx (runtime navigation) and tests can read from the same object.
 * SLIDE_STEP_COUNTS is derived from SLIDE_REGISTRY below so they can never diverge.
 */

import type { ComponentType } from "react";

import { ARCH_DIAGRAM_STEP_COUNT } from "./ArchitectureDiagram.js";
import { CREW_DIAGRAM_STEP_COUNT } from "./CrewDiagram.js";

import Portada from "./slides/01-portada.mdx";
import Plataforma from "./slides/02-plataforma.mdx";
import Dashboard from "./slides/03-dashboard-live.mdx";
import Architecture from "./slides/05-architecture.mdx";
import CrewAgents from "./slides/06-crew-agents.mdx";
import Cierre from "./slides/04-cierre.mdx";

export const SLIDES: ComponentType[] = [
  Portada,
  Plataforma,
  Dashboard,
  Architecture,
  CrewAgents,
  Cierre,
];

export const SLIDE_TITLES: string[] = [
  "AI, IoT & Cloud: Building a Recovery Path from Edge to Cloud",
  "The Platform",
  "Live Dashboard",
  "AWS Architecture",
  "Self-Healing Crew — CrewAI Agents",
  "What's Next?",
];

// ---------------------------------------------------------------------------
// SLIDE_REGISTRY — SINGLE SOURCE OF TRUTH for sub-step counts.
//
// Key: slide index (0-based, matches SLIDES[]).
// Value: stepCount for that slide (0 = no sub-steps).
//
// This is the canonical definition; Deck.tsx imports it from here.
// SLIDE_STEP_COUNTS is derived from this registry so they can never diverge.
//
// To add diagram B on slide index 5:
//   import { DIAGRAM_B_STEP_COUNT } from "./DiagramB.js";
//   SLIDE_REGISTRY[5] = { stepCount: DIAGRAM_B_STEP_COUNT };
// ---------------------------------------------------------------------------

export interface SlideRegistryEntry {
  stepCount: number;
}

export const SLIDE_REGISTRY: Record<number, SlideRegistryEntry> = {
  3: { stepCount: ARCH_DIAGRAM_STEP_COUNT }, // Architecture diagram (index 3)
  4: { stepCount: CREW_DIAGRAM_STEP_COUNT }, // Crew Agents diagram (index 4)
};

/**
 * Explicit slide indices for the two diagram slides.
 * Exported here (single source of truth) so Deck.tsx and tests never hardcode
 * magic numbers like subSteps[3] or subSteps[4].
 */
export const ARCH_SLIDE_INDEX = 3;
export const CREW_SLIDE_INDEX = 4;

/**
 * Sub-step counts per slide — derived from SLIDE_REGISTRY so there is only
 * one source of truth. Kept for test-compatibility (tests use findIndex on it
 * to locate the arch slide index; that pattern still works).
 */
export const SLIDE_STEP_COUNTS: number[] = SLIDES.map(
  (_, i) => SLIDE_REGISTRY[i]?.stepCount ?? 0,
);
