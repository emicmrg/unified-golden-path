/**
 * main.tsx — SPA entry point.
 *
 * Inter is self-hosted via @fontsource/inter so it is served from the Amplify
 * bundle (font-src 'self') and never hits fonts.googleapis.com / fonts.gstatic.com.
 * This satisfies the dashboard CSP without widening it.
 *
 * Phase 3A: Poppins added (@fontsource/poppins@5.3.0, pinned exact version)
 * for headings/display. Same self-hosted pattern as Inter — zero new external
 * domains, CSP unchanged. Weights mapped to actual uses in presentation.css:
 *   600 → slide-h3, 700 → slide-h2, 800 → slide-h1, 900 → slide-h1--display
 */

// Inter — weights used by the design system (300 light, 400 regular, 500 medium, 600 semibold, 700 bold, 800/900 for display titles)
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/inter/900.css";

// Poppins — self-hosted, headings/display only (presentation mode)
// Weights match the real uses in presentation.css:
//   .slide-h3 → 600, .slide-h2 → 700, .slide-h1 → 800, .slide-h1--display → 900
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource/poppins/900.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./presentation/presentation.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Could not find the #root element in the DOM.");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
