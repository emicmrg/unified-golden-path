/**
 * FleetHealth.tsx — View 1: Live telemetry from the IoT gateway.
 *
 * Displays temperature and humidity in real time with visual classification
 * (green OK / yellow WARN / red ALARM), MQTT connection status,
 * and an in-memory sparkline with the last MAX_HISTORY points.
 *
 * M4: the sparkline green band uses the SAFE range (safeMin/safeMax),
 *     not the chart domain limits.
 * #9: no duplicate calculations or non-null assertions.
 * #10: out-of-domain values are clamped before rendering.
 */

import React from "react";
import { useTelemetry } from "../hooks/useTelemetry.js";
import {
  classifyReading,
  statusColorClass,
  statusLabel,
  TEMP_MIN_C,
  TEMP_MAX_C,
  HUMIDITY_MIN_PCT,
  HUMIDITY_MAX_PCT,
} from "../classify.js";
import type { MqttConnectionStatus, TelemetryPoint } from "../types.js";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectionBadge({ status }: { status: MqttConnectionStatus }): React.ReactElement {
  const labels: Record<MqttConnectionStatus, string> = {
    disconnected: "⚫ Disconnected",
    connecting: "🟡 Connecting…",
    connected: "🟢 Connected",
    error: "🔴 Error",
  };
  return (
    <span
      className={`connection-badge connection-badge--${status}`}
      aria-label={`MQTT connection status: ${labels[status]}`}
    >
      {labels[status]}
    </span>
  );
}

/**
 * Minimal SVG sparkline.
 *
 * Props:
 *   min/max       — chart domain (for Y-axis scaling)
 *   safeMin/safeMax — actual safe range (for the green band)
 */
function Sparkline({
  points,
  getValue,
  label,
  min,
  max,
  safeMin,
  safeMax,
}: {
  points: TelemetryPoint[];
  getValue: (p: TelemetryPoint) => number;
  label: string;
  min: number;
  max: number;
  safeMin: number;
  safeMax: number;
}): React.ReactElement {
  const W = 200;
  const H = 50;
  const PAD = 4;

  if (points.length < 2) {
    return (
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={`${label} sparkline: insufficient data`}
      >
        <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="10" fill="#888">
          No history
        </text>
      </svg>
    );
  }

  const range = max - min || 1;

  // #10: clamp out-of-domain values before computing coordinates
  const clamp = (v: number): number => Math.max(min, Math.min(max, v));
  const toY = (v: number): number =>
    PAD + (H - PAD * 2) * (1 - (clamp(v) - min) / range);
  const toX = (i: number): number =>
    PAD + ((W - PAD * 2) / (points.length - 1)) * i;

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(getValue(p)).toFixed(1)}`)
    .join(" ");

  // M4: safe zone uses safeMin/safeMax (correct range), not the domain limits
  const safeTop = toY(safeMax);
  const safeBottom = toY(safeMin);

  const lastPoint = points[points.length - 1];

  return (
    <svg
      width={W}
      height={H}
      role="img"
      aria-label={`${label} sparkline: ${points.length} points`}
    >
      {/* Green band: actual safe range */}
      <rect
        x={PAD}
        y={safeTop}
        width={W - PAD * 2}
        height={Math.max(0, safeBottom - safeTop)}
        fill="rgba(34,197,94,0.12)"
      />
      {/* History line */}
      <path d={pathD} fill="none" stroke="#0e7490" strokeWidth="1.5" />
      {/* Most recent point — only if it exists */}
      {lastPoint !== undefined && (
        <circle
          cx={toX(points.length - 1)}
          cy={toY(getValue(lastPoint))}
          r="3"
          fill="#0e7490"
        />
      )}
    </svg>
  );
}

/** Individual metric card */
function MetricCard({
  label,
  value,
  unit,
  statusClass,
  statusText,
  rangeLabel,
  children,
}: {
  label: string;
  value: string;
  unit: string;
  statusClass: string;
  statusText: string;
  rangeLabel: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <article
      className={`metric-card ${statusClass}`}
      aria-label={`${label}: ${value} ${unit} — ${statusText}`}
    >
      <h3 className="metric-card__title">{label}</h3>
      <p className="metric-card__value">
        <span className="metric-card__number">{value}</span>
        <span className="metric-card__unit">{unit}</span>
      </p>
      <p className={`metric-card__status ${statusClass}__label`}>{statusText}</p>
      <p className="metric-card__range">Safe range: {rangeLabel}</p>
      {children}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FleetHealth(): React.ReactElement {
  const { connectionStatus, latest, history, error } = useTelemetry();

  // #9: independent classifications per metric, no duplicates or non-null assertions
  const tempClassification =
    latest !== null
      ? classifyReading(latest.temperatureCelsius, 45 /* neutral humidity */)
      : null;
  const humClassification =
    latest !== null
      ? classifyReading(5 /* neutral temperature */, latest.humidityPercent)
      : null;

  return (
    <section aria-labelledby="fleet-health-title" className="view fleet-health">
      <header className="view__header">
        <h2 id="fleet-health-title">🌡️ Fleet Health — Live Telemetry</h2>
        <ConnectionBadge status={connectionStatus} />
      </header>

      {error && (
        <div role="alert" className="alert alert--warn">
          {error}
        </div>
      )}

      {latest === null && connectionStatus !== "error" && !error && (
        <div className="empty-state" aria-live="polite">
          {connectionStatus === "connecting"
            ? "Connecting to the MQTT broker…"
            : "No telemetry data. Waiting for gateway messages."}
        </div>
      )}

      {latest !== null && (
        <div className="metrics-grid">
          <MetricCard
            label="Temperature"
            value={latest.temperatureCelsius.toFixed(1)}
            unit="°C"
            statusClass={statusColorClass(tempClassification?.status ?? "OK")}
            statusText={statusLabel(tempClassification?.status ?? "OK")}
            rangeLabel={`${TEMP_MIN_C} – ${TEMP_MAX_C} °C`}
          >
            {/* M4: safeMin/safeMax are the real safe limits; min/max are the axis domain */}
            <Sparkline
              points={history}
              getValue={(p) => p.temperatureCelsius}
              label="temperature"
              min={-5}
              max={15}
              safeMin={TEMP_MIN_C}
              safeMax={TEMP_MAX_C}
            />
          </MetricCard>

          <MetricCard
            label="Humidity"
            value={latest.humidityPercent.toFixed(1)}
            unit="%RH"
            statusClass={statusColorClass(humClassification?.status ?? "OK")}
            statusText={statusLabel(humClassification?.status ?? "OK")}
            rangeLabel={`${HUMIDITY_MIN_PCT} – ${HUMIDITY_MAX_PCT} %RH`}
          >
            {/* M4: safeMin/safeMax are the real safe limits; min/max are the axis domain */}
            <Sparkline
              points={history}
              getValue={(p) => p.humidityPercent}
              label="humidity"
              min={0}
              max={100}
              safeMin={HUMIDITY_MIN_PCT}
              safeMax={HUMIDITY_MAX_PCT}
            />
          </MetricCard>
        </div>
      )}

      {latest !== null && (
        <p className="last-update" aria-live="polite">
          Last reading: {new Date(latest.timestamp).toLocaleTimeString("en-US")} —
          device: <code>{latest.deviceId}</code>
        </p>
      )}
    </section>
  );
}
