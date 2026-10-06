/**
 * App.tsx — Main shell with navigation between the 3 views.
 */

import React, { useState } from "react";
import { FleetHealth } from "./components/FleetHealth.js";
import { GoldenPath } from "./components/GoldenPath.js";
import { SelfHealing } from "./components/SelfHealing.js";

type Tab = "fleet" | "golden" | "healing";

const TAB_CONFIG: { id: Tab; label: string; icon: string }[] = [
  { id: "fleet", label: "Fleet Health", icon: "🌡️" },
  { id: "golden", label: "Golden Path", icon: "🏆" },
  { id: "healing", label: "Self-Healing", icon: "🤖" },
];

export function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>("fleet");

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header" role="banner">
        <div className="app-header__brand">
          <span aria-hidden="true">⚡</span>
          <span>Unified Golden Path</span>
        </div>
        <p className="app-header__subtitle">
          Platform Engineering Demo — Read Only
        </p>
      </header>

      {/* Navigation */}
      <nav aria-label="Dashboard views" className="tab-nav">
        <ul role="tablist" className="tab-nav__list">
          {TAB_CONFIG.map(({ id, label, icon }) => (
            <li key={id} role="presentation">
              <button
                role="tab"
                aria-selected={activeTab === id}
                aria-controls={`panel-${id}`}
                id={`tab-${id}`}
                className={`tab-nav__btn ${activeTab === id ? "tab-nav__btn--active" : ""}`}
                onClick={() => setActiveTab(id)}
              >
                <span aria-hidden="true">{icon}</span>
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Panels */}
      <main className="app-main">
        <div
          id="panel-fleet"
          role="tabpanel"
          aria-labelledby="tab-fleet"
          hidden={activeTab !== "fleet"}
        >
          {activeTab === "fleet" && <FleetHealth />}
        </div>

        <div
          id="panel-golden"
          role="tabpanel"
          aria-labelledby="tab-golden"
          hidden={activeTab !== "golden"}
        >
          {activeTab === "golden" && <GoldenPath />}
        </div>

        <div
          id="panel-healing"
          role="tabpanel"
          aria-labelledby="tab-healing"
          hidden={activeTab !== "healing"}
        >
          {activeTab === "healing" && <SelfHealing />}
        </div>
      </main>

      {/* Footer */}
      <footer className="app-footer" role="contentinfo">
        <p>
          The Unified Golden Path — Slalom Innovation Labs GDL · us-east-1 ·{" "}
          <a
            href="https://github.com/slalom-talk-projects/unified-golden-path"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}
