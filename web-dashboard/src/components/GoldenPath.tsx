/**
 * GoldenPath.tsx — View 2: CI pipeline / IoT Job status.
 *
 * Displays the status of the last CI run and the last IoT job honestly:
 * if no real data is available, shows 'unknown' / placeholder — never fakes 'passing'.
 */

import React from "react";
import { useStatus } from "../hooks/useStatus.js";
import type { PipelineStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PipelineBadge({ status }: { status: PipelineStatus }): React.ReactElement {
  const config: Record<PipelineStatus, { label: string; className: string }> = {
    passing: { label: "✅ Passing", className: "badge badge--green" },
    failing: { label: "❌ Failing", className: "badge badge--red" },
    unknown: { label: "⚪ Unknown", className: "badge badge--gray" },
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
        <h2 id="golden-path-title">🏆 Golden Path — Pipeline Status</h2>
        {loading && (
          <span className="spinner" aria-label="Loading pipeline status…" />
        )}
      </header>

      {error && (
        <div role="alert" className="alert alert--warn">
          {error}
        </div>
      )}

      {!error && !loading && data === null && (
        <div className="empty-state">
          No status data. Configure <code>VITE_STATUS_API_URL</code>.
        </div>
      )}

      <div className="golden-path__content">
        {/* CI/CD pipeline status */}
        <article className="info-card" aria-label="CI/CD Pipeline">
          <h3>CI/CD Pipeline</h3>
          <PipelineBadge status={pipeline.status} />

          {pipeline.status === "unknown" && (
            <p className="placeholder-note">
              ℹ️ Pipeline status will be available in Block 6 (CI/CD). Showing an honest
              placeholder for now.
            </p>
          )}

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

        {/* Last IoT Job */}
        <article className="info-card" aria-label="Last IoT Job / OTA">
          <h3>IoT Job / OTA</h3>
          <span className="badge badge--gray" aria-label="Status: Unknown — pending block 3">
            ⚪ Pending (Block 3)
          </span>
          <p className="placeholder-note">
            ℹ️ The last OTA job status will be available once Block 3 (edge firmware OTA)
            is complete.
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
