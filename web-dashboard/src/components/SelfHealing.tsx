/**
 * SelfHealing.tsx — View 3: Self-healing crew timeline and circuit breaker.
 *
 * M2: the timeline shows the REAL EVENTS emitted by the handler
 *     (shape: { ts, runKey, event, detail? }) and a static/explanatory block
 *     of the 3 crew roles as context (real data is never discarded).
 * M3: if data.degraded is not null, renders a role=status warning banner.
 */

import React from "react";
import { useStatus } from "../hooks/useStatus.js";
import type { CircuitBreakerEntry, CrewTimelineEntry, CrewTimelineEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Real timeline event configuration
// ---------------------------------------------------------------------------

const EVENT_CONFIG: Record<CrewTimelineEvent, { label: string; icon: string }> = {
  "first-attempt": { label: "First attempt recorded", icon: "🔍" },
  "attempt-recorded": { label: "Crew attempt", icon: "🔄" },
  "escalated-to-human": { label: "Escalated to human", icon: "🚨" },
};

// ---------------------------------------------------------------------------
// Static block of the 3 crew roles (explanatory context)
// ---------------------------------------------------------------------------

const CREW_ROLES = [
  { id: "log-analyst", label: "🔍 Log Analyst", desc: "Analyzes logs and classifies the failure" },
  { id: "fix-engineer", label: "🔧 Fix Engineer", desc: "Proposes and applies the fix on a branch" },
  { id: "reviewer", label: "🧐 Reviewer", desc: "Validates the fix and approves the PR" },
];

function CrewRolesContext(): React.ReactElement {
  return (
    <aside className="crew-roles-context" aria-label="Crew roles (context)">
      <p className="crew-roles-context__note">
        <em>No per-step crew telemetry (the crew does not persist it yet)</em>
      </p>
      <ol className="crew-roles-list">
        {CREW_ROLES.map((role) => (
          <li key={role.id} className="crew-role-item">
            <strong>{role.label}</strong>
            <span className="crew-role-item__desc"> — {role.desc}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Real timeline event item
// ---------------------------------------------------------------------------

function TimelineEventItem({ entry }: { entry: CrewTimelineEntry }): React.ReactElement {
  const cfg = EVENT_CONFIG[entry.event] ?? { label: entry.event, icon: "📌" };
  const time = new Date(entry.ts).toLocaleTimeString("en-US");
  return (
    <li className="timeline-event" aria-label={`${cfg.label} — ${entry.runKey} — ${time}`}>
      <span className="timeline-event__icon" aria-hidden="true">{cfg.icon}</span>
      <div className="timeline-event__body">
        <strong className="timeline-event__label">{cfg.label}</strong>
        <code className="timeline-event__run">{entry.runKey}</code>
        {entry.detail && (
          <span className="timeline-event__detail"> — {entry.detail}</span>
        )}
        <time className="timeline-event__time" dateTime={entry.ts}>{time}</time>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

function CircuitBreakerCard({
  entry,
}: {
  entry: CircuitBreakerEntry;
}): React.ReactElement {
  // maxAttempts already validated > 0 by useStatus (#7), but for robustness:
  const pct = Math.min(100, (entry.attempts / entry.maxAttempts) * 100);
  return (
    <article
      className={`circuit-breaker-card ${entry.escalated ? "circuit-breaker-card--escalated" : ""}`}
      aria-label={`Circuit breaker ${entry.runKey}: ${entry.attempts}/${entry.maxAttempts} attempts${entry.escalated ? ", escalated to human" : ""}`}
    >
      <header className="circuit-breaker-card__header">
        <code className="circuit-breaker-card__key">{entry.runKey}</code>
        {entry.escalated && (
          <span className="badge badge--red" role="status">
            🚨 Escalated to human
          </span>
        )}
      </header>
      <div className="circuit-breaker-card__progress" aria-hidden="true">
        <div
          className="progress-bar"
          style={{ width: `${pct}%` }}
          title={`${entry.attempts} of ${entry.maxAttempts} attempts`}
        />
      </div>
      <p className="circuit-breaker-card__counter">
        Attempts:{" "}
        <strong>
          {entry.attempts}/{entry.maxAttempts}
        </strong>
      </p>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SelfHealing(): React.ReactElement {
  const { loading, data, error, lastUpdated } = useStatus();

  const crew = data?.crew;
  const circuitBreakers = data?.circuitBreaker ?? [];
  // M2: real events as received from the handler (no step filtering)
  const timelineEvents: CrewTimelineEntry[] = crew?.timeline ?? [];
  const pr = crew?.pr ?? null;
  // M3: degradation message (secondary stack not deployed)
  const degraded = data?.degraded ?? null;

  return (
    <section aria-labelledby="self-healing-title" className="view self-healing">
      <header className="view__header">
        <h2 id="self-healing-title">🤖 Self-Healing — Auto-Repair Crew</h2>
        {loading && (
          <span className="spinner" aria-label="Loading crew status…" />
        )}
      </header>

      {/* M3: degradation banner */}
      {degraded != null && (
        <div role="status" className="alert alert--degraded">
          ⚠️ {degraded}
        </div>
      )}

      {error && (
        <div role="alert" className="alert alert--warn">
          {error}
        </div>
      )}

      {!error && !loading && data === null && (
        <div className="empty-state">
          No crew data. Configure <code>VITE_STATUS_API_URL</code>.
        </div>
      )}

      {/* Static crew roles block (context) */}
      <div className="self-healing__section">
        <h3>Crew Roles</h3>
        <CrewRolesContext />
      </div>

      {/* Real event timeline */}
      <div className="self-healing__section">
        <h3>Crew Events</h3>
        {timelineEvents.length === 0 && data !== null && (
          <p className="placeholder-note">
            No events yet. The crew will act when the pipeline fails.
          </p>
        )}
        {timelineEvents.length > 0 && (
          <ol
            className="timeline"
            aria-label="Real events from the self-healing crew"
          >
            {timelineEvents.map((entry, idx) => (
              <TimelineEventItem key={`${entry.ts}-${entry.runKey}-${idx}`} entry={entry} />
            ))}
          </ol>
        )}

        {/* Generated PR */}
        {pr !== null && (
          <div className="pr-card" aria-label={`Pull Request: ${pr.branch}`}>
            <strong>🔀 Pull Request generated:</strong>{" "}
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View Pull Request on branch ${pr.branch}`}
            >
              <code>{pr.branch}</code>
            </a>
          </div>
        )}

        {pr === null && data !== null && (
          <p className="placeholder-note">
            The crew has not generated a fix PR yet.
          </p>
        )}
      </div>

      {/* Circuit Breakers */}
      <div className="self-healing__section">
        <h3>Circuit Breaker</h3>
        {circuitBreakers.length === 0 && data !== null && (
          <p className="placeholder-note">
            No active entries in the circuit breaker.
          </p>
        )}
        <div className="circuit-breakers-grid">
          {circuitBreakers.map((cb) => (
            <CircuitBreakerCard key={cb.runKey} entry={cb} />
          ))}
        </div>
      </div>

      {lastUpdated && (
        <p className="last-update" aria-live="polite">
          Updated: {new Date(lastUpdated).toLocaleTimeString("en-US")}
        </p>
      )}
    </section>
  );
}
