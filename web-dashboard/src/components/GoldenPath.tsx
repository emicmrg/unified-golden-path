/**
 * GoldenPath.tsx — View 2: CI pipeline / IoT Job status.
 *
 * Displays the status of the last CI run and the last IoT job honestly:
 * - If real pipeline data is available (status !== 'unknown'), shows the badge + last-run link.
 * - If no real data is available, shows 'unknown' with the note from the handler — never fakes 'passing'.
 * - IoT Job / OTA: no data available yet; displayed as unknown without a development-block label.
 *
 * Phase 2 additions (presentation layer only — data logic untouched):
 *   - PipelineBadge color transitions via CSS (badge-status class, see presentation.css).
 *   - All text / aria-labels unified to English.
 */

import React from "react";
import { useStatus } from "../hooks/useStatus.js";
import type { PipelineStatus } from "../types.js";

// Inline SVG — Heroicons star (MIT) for the section heading
function IconStarLg(): React.ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"
      aria-hidden="true" focusable="false">
      <path fillRule="evenodd" clipRule="evenodd"
        d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PipelineBadge({ status }: { status: PipelineStatus }): React.ReactElement {
  const config: Record<PipelineStatus, { label: string; className: string }> = {
    passing: { label: "✅ Passing", className: "badge badge--green badge-status" },
    failing: { label: "❌ Failing", className: "badge badge--red badge-status" },
    unknown: { label: "⚪ Unknown", className: "badge badge--gray badge-status" },
  };
  const { label, className } = config[status];
  return (
    <span className={className} aria-label={`Pipeline status: ${label}`}>
      {label}
    </span>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="info-row">
      <span className="info-row__label">{label}</span>
      <span className="info-row__value">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GoldenPath(): React.ReactElement {
  const { loading, data, error, lastUpdated } = useStatus();

  const pipeline = data?.pipeline ?? { status: "unknown" as PipelineStatus };
  const lastRun = pipeline.lastRun;

  return (
    <section aria-labelledby="golden-path-title" className="view golden-path">
      <header className="view__header">
        <h2 id="golden-path-title">
          <IconStarLg />
          Golden Path — Pipeline Status
        </h2>
        {loading && (
          <span className="spinner" role="status" aria-label="Loading pipeline status…" />
        )}
      </header>

      {error && (
        <div role="alert" className="alert alert--warn">
          {error.toLowerCase().includes("failed to fetch") || error.toLowerCase().includes("network")
            ? "No connection to the backend — data temporarily unavailable."
            : error}
        </div>
      )}

      {!error && !loading && data === null && (
        <div className="empty-state">
          No pipeline runs recorded yet.
        </div>
      )}

      <div className="golden-path__content">
        {/* CI/CD pipeline status — real data from GitHub Actions via Lambda */}
        <article className="info-card" aria-label="CI/CD Pipeline">
          <h3>CI/CD Pipeline</h3>
          <PipelineBadge status={pipeline.status} />

          {/* Show handler note only when status is unknown and there is an explanatory note */}
          {pipeline.status === "unknown" && pipeline.note && (
            <p className="placeholder-note">
              ℹ️ {pipeline.note}
            </p>
          )}

          {/* Generic fallback when unknown and no note (e.g. data is null / loading) */}
          {pipeline.status === "unknown" && !pipeline.note && !loading && data !== null && (
            <p className="placeholder-note">
              ℹ️ Pipeline status unavailable — the GitHub Actions API did not return a result.
            </p>
          )}

          {/* Real last-run details when we have them */}
          {lastRun && (
            <dl className="run-details">
              <InfoRow label="Run ID">
                <a
                  href={lastRun.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View run ${lastRun.id} on GitHub Actions`}
                >
                  #{lastRun.id}
                </a>
              </InfoRow>
              <InfoRow label="Conclusion">
                <code>{lastRun.conclusion}</code>
              </InfoRow>
            </dl>
          )}
        </article>

        {/* Last IoT Job / OTA — no data source yet; honest unknown, no block label */}
        <article className="info-card" aria-label="Last IoT Job / OTA">
          <h3>IoT Job / OTA</h3>
          <span className="badge badge--gray badge-status" aria-label="Status: Unknown — no OTA data yet">
            ⚪ Unknown
          </span>
          <p className="placeholder-note">
            ℹ️ No OTA job data available yet. This will show the last firmware update once
            edge-firmware OTA is operational.
          </p>
        </article>
      </div>

      {lastUpdated && (
        <p className="last-update" aria-live="polite">
          Updated: {new Date(lastUpdated).toLocaleTimeString("en-US")}
        </p>
      )}
    </section>
  );
}
