/**
 * main.tsx — SPA entry point.
 *
 * Fonts: Inter + Poppins self-hosted via @fontsource — served from the Amplify
 * bundle (font-src 'self'), never from fonts.googleapis.com / fonts.gstatic.com.
 * CSP unchanged.
 *
 * CSS import order:
 *   1. styles.css       — global dashboard dark-mode base (reset + components)
 *   2. theme-light.css  — Slalom light theme tokens + typography + arch classes
 *   3. presentation.css — MDX slide engine classes (kept for legacy; theme tokens
 *                         now come from theme-light.css)
 */

// Inter weights used by the design system
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/inter/900.css";

// Poppins — self-hosted, headings/display only
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource/poppins/900.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./presentation/theme-light.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Could not find the #root element in the DOM.");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
