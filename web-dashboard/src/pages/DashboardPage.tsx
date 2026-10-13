/**
 * DashboardPage.tsx — Route /dashboard
 *
 * The demo dashboard with live IoT telemetry, pipeline status, and
 * self-healing timeline. Extracted from App.tsx's DashboardShell.
 *
 * CHANGES from original DashboardShell:
 *  - All emojis replaced by CSS color dots or inline SVG icons (no emojis).
 *  - ConnectionBadge: dot divs instead of ⚫/🟡/🟢/🔴.
 *  - PipelineBadge: status dot instead of ✅/❌/⚪.
 *  - GoldenPath placeholder note: text only (removed ℹ️).
 *  - SelfHealing EVENT_CONFIG icons: inline SVG instead of emoji.
 *  - SelfHealing CREW_ROLES labels: text only (no emoji prefix).
 *  - SelfHealing degraded banner: text only (removed ⚠️).
 *  - SelfHealing PR card: inline SVG arrow icon (removed 🔀).
 *  - SelfHealing escalated badge: text only (removed 🚨).
 *  - LiveDashboard hex glyph ⬢: removed from heading.
 *
 * Accessibility: aria-labels preserved and updated to match new text.
 * CSP: all icons are inline SVG paths, no external resources.
 */

import React, { useState } from "react";
import { FleetHealth } from "../components/FleetHealth.js";
import { GoldenPath } from "../components/GoldenPath.js";
import { SelfHealing } from "../components/SelfHealing.js";

// ─────────────────────────────────────────────────────────────────────────────
// Inline SVG icons (Heroicons MIT paths, 24×24 viewBox)
// ─────────────────────────────────────────────────────────────────────────────

function IconBolt({ size = 20 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
      aria-hidden="true" focusable="false">
      <path fillRule="evenodd" clipRule="evenodd"
        d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" />
    </svg>
  );
}

function IconBeaker({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
      aria-hidden="true" focusable="false">
      <path fillRule="evenodd" clipRule="evenodd"
        d="M10.5 3.798v5.02a3 3 0 0 1-.879 2.121l-2.377 2.377a9.845 9.845 0 0 1 5.091 1.013 8.315 8.315 0 0 0 5.713.636l.285-.071-3.954-3.955a3 3 0 0 1-.879-2.121v-5.02a23.614 23.614 0 0 0-3 0Zm4.5.138a.75.75 0 0 0 .093-1.495A24.837 24.837 0 0 0 12 2.25a25.048 25.048 0 0 0-3.093.191A.75.75 0 0 0 9 3.938v4.88a1.5 1.5 0 0 1-.44 1.06L5.28 13.16a3.5 3.5 0 0 0-.599 3.977C5.274 18.41 6.588 19.5 8.25 19.5h7.5c1.662 0 2.976-1.09 3.569-2.363a3.5 3.5 0 0 0-.599-3.977l-3.28-3.22A1.5 1.5 0 0 1 15 8.818v-4.88Z" />
    </svg>
  );
}

function IconStar({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
      aria-hidden="true" focusable="false">
      <path fillRule="evenodd" clipRule="evenodd"
        d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" />
    </svg>
  );
}

function IconCpuChip({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
      aria-hidden="true" focusable="false">
      <path d="M16.5 7.5h-9v9h9v-9Z" />
      <path fillRule="evenodd" clipRule="evenodd"
        d="M8.25 2.25A.75.75 0 0 1 9 3v.75h2.25V3a.75.75 0 0 1 1.5 0v.75H15V3a.75.75 0 0 1 1.5 0v.75h.75a3 3 0 0 1 3 3v.75H21A.75.75 0 0 1 21 9h-.75v2.25H21a.75.75 0 0 1 0 1.5h-.75V15H21a.75.75 0 0 1 0 1.5h-.75v.75a3 3 0 0 1-3 3h-.75V21a.75.75 0 0 1-1.5 0v-.75h-2.25V21a.75.75 0 0 1-1.5 0v-.75H9V21a.75.75 0 0 1-1.5 0v-.75h-.75a3 3 0 0 1-3-3v-.75H3A.75.75 0 0 1 3 15h.75v-2.25H3a.75.75 0 0 1 0-1.5h.75V9H3a.75.75 0 0 1 0-1.5h.75v-.75a3 3 0 0 1 3-3h.75V3a.75.75 0 0 1 .75-.75ZM6 6.75A.75.75 0 0 1 6.75 6h10.5a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75V6.75Z" />
    </svg>
  );
}

function SlalomWordmark(): React.ReactElement {
  return (
    <svg className="slalom-wordmark" viewBox="0 0 96 22" fill="none"
      aria-label="Slalom" role="img">
      <text x="0" y="17"
        fontFamily="Inter, -apple-system, sans-serif"
        fontSize="18" fontWeight="300" letterSpacing="-0.3"
        fill="currentColor">
        slalom
      </text>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab config
// ─────────────────────────────────────────────────────────────────────────────

type Tab = "fleet" | "golden" | "healing";

const TAB_CONFIG: {
  id: Tab;
  label: string;
  icon: React.ReactElement;
  ariaLabel: string;
}[] = [
  {
    id: "fleet",
    label: "Fleet Health",
    icon: <IconBeaker />,
    ariaLabel: "Fleet Health — live telemetry",
  },
  {
    id: "golden",
    label: "Golden Path",
    icon: <IconStar />,
    ariaLabel: "Golden Path — pipeline status",
  },
  {
    id: "healing",
    label: "Self-Healing",
    icon: <IconCpuChip />,
    ariaLabel: "Self-Healing — auto-repair crew",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// DashboardPage
// ─────────────────────────────────────────────────────────────────────────────

export function DashboardPage(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>("fleet");

  return (
    <div className="app">
      <div className="app-chrome">
        <header className="app-header" role="banner">
          <div className="app-header__brand">
            <IconBolt size={22} />
            <span>Unified Golden Path</span>
          </div>
          <div className="app-header__meta">
            <SlalomWordmark />
            <p className="app-header__subtitle">
              Platform Engineering Demo · Read Only
            </p>
          </div>
        </header>

        <nav aria-label="Dashboard views" className="tab-nav">
          <ul role="tablist" className="tab-nav__list">
            {TAB_CONFIG.map(({ id, label, icon, ariaLabel }) => (
              <li key={id} role="presentation">
                <button
                  role="tab"
                  aria-selected={activeTab === id}
                  aria-controls={`panel-${id}`}
                  id={`tab-${id}`}
                  aria-label={ariaLabel}
                  className={`tab-nav__btn ${activeTab === id ? "tab-nav__btn--active" : ""}`}
                  onClick={() => setActiveTab(id)}
                >
                  {icon}
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <main className="app-main">
        <div id="panel-fleet" role="tabpanel" aria-labelledby="tab-fleet"
          hidden={activeTab !== "fleet"}>
          {activeTab === "fleet" && <FleetHealth />}
        </div>
        <div id="panel-golden" role="tabpanel" aria-labelledby="tab-golden"
          hidden={activeTab !== "golden"}>
          {activeTab === "golden" && <GoldenPath />}
        </div>
        <div id="panel-healing" role="tabpanel" aria-labelledby="tab-healing"
          hidden={activeTab !== "healing"}>
          {activeTab === "healing" && <SelfHealing />}
        </div>
      </main>

      <footer className="app-footer" role="contentinfo">
        <p>
          The Unified Golden Path — Slalom Innovation Labs GDL · us-east-1 ·{" "}
          <a href="https://github.com/slalom-talk-projects/unified-golden-path"
            target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}
