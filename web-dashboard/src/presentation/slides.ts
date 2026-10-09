/**
 * slides.ts — Registro de slides del deck.
 *
 * Importa cada .mdx como componente React (compilado por @mdx-js/rollup en Vite).
 * El orden del array es el orden de la presentación.
 *
 * Para agregar una slide: importarla y añadirla a SLIDES + SLIDE_TITLES.
 */

import type { ComponentType } from "react";

import Portada from "./slides/01-portada.mdx";
import Plataforma from "./slides/02-plataforma.mdx";
import Dashboard from "./slides/03-dashboard-live.mdx";
import Cierre from "./slides/04-cierre.mdx";

export const SLIDES: ComponentType[] = [
  Portada,
  Plataforma,
  Dashboard,
  Cierre,
];

export const SLIDE_TITLES: string[] = [
  "The Unified Golden Path",
  "The Platform",
  "Live Dashboard",
  "What's Next?",
];
