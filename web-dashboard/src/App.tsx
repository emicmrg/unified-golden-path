/**
 * App.tsx — SPA shell with react-router-dom v6.
 *
 * Routes:
 *   /           → ScrollDeck (scrollytelling presentation)
 *   /dashboard  → DashboardPage (live demo dashboard)
 *
 * Legacy query params (?mode=dashboard, ?proto=scroll) redirect to
 * the clean routes on first load for backwards compatibility with any
 * existing links shared during the talk.
 *
 * CSP: no external fonts or scripts — @fontsource is self-hosted.
 */

import React, { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { ScrollDeck } from "./presentation/ScrollDeck.js";
import { DashboardPage } from "./pages/DashboardPage.js";

// ─────────────────────────────────────────────────────────────────────────────
// LegacyRedirect — handles ?mode=dashboard and ?proto=scroll query params
// by redirecting to the clean route. Runs once on mount then removes itself.
// ─────────────────────────────────────────────────────────────────────────────

function LegacyRedirect(): null {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const mode = params.get("mode");
    if (mode === "dashboard") {
      navigate("/dashboard", { replace: true });
    }
    // ?proto=scroll used to render ScrollProto; the deck IS the scroll experience now.
    // No redirect needed — / is already the deck.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

export function App(): React.ReactElement {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <LegacyRedirect />
      <Routes>
        {/* Primary route: scrollytelling deck */}
        <Route path="/" element={<ScrollDeck />} />

        {/* Dashboard demo */}
        <Route path="/dashboard" element={<DashboardPage />} />

        {/* Fallback — redirect unknown paths to the deck */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
