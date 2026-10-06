/**
 * types.ts — Shared data contract between the SPA and the infrastructure (4c).
 * The shape of StatusResponse is what the read-only Lambda returns.
 */

// ---------------------------------------------------------------------------
// Live telemetry (MQTT via PubSub)
// ---------------------------------------------------------------------------

/** Classification status consistent with classifyReading in the sample-service */
export type ReadingStatus = "OK" | "WARN" | "ALARM";

/** Telemetry message published by the gateway on the VITE_TELEMETRY_TOPIC topic */
export interface TelemetryMessage {
  deviceId: string;
  temperatureCelsius: number;
  humidityPercent: number;
  timestamp: string; // ISO 8601
}

/** In-memory history point for the sparkline */
export interface TelemetryPoint {
  timestamp: string;
  temperatureCelsius: number;
  humidityPercent: number;
  status: ReadingStatus;
}

/** Connection status of the useTelemetry hook */
export type MqttConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface TelemetryState {
  connectionStatus: MqttConnectionStatus;
  latest: TelemetryMessage | null;
  history: TelemetryPoint[]; // last N points in memory
  error: string | null;
}

// ---------------------------------------------------------------------------
// Status (polling a Function URL Lambda)
// ---------------------------------------------------------------------------

export type PipelineStatus = "passing" | "failing" | "unknown";

export interface PipelineLastRun {
  id: string;
  conclusion: string;
  url: string;
}

export interface PipelineState {
  status: PipelineStatus;
  lastRun?: PipelineLastRun;
  /** Informational note from the handler (e.g. block 6 pending) */
  note?: string;
}

/**
 * Real timeline event as emitted by the handler.
 * Canonical shape (source of truth: dashboard-status-handler.ts).
 */
export type CrewTimelineEvent =
  | "first-attempt"
  | "attempt-recorded"
  | "escalated-to-human";

export interface CrewTimelineEntry {
  ts: string;
  runKey: string;
  event: CrewTimelineEvent;
  detail?: string;
}

export interface CrewPr {
  url: string;
  branch: string;
}

export interface CrewState {
  timeline: CrewTimelineEntry[];
  pr: CrewPr | null;
}

export interface CircuitBreakerEntry {
  runKey: string;
  attempts: number;
  maxAttempts: number;
  escalated: boolean;
}

/**
 * Exact shape of the JSON response from the Lambda Function URL (VITE_STATUS_API_URL).
 * The 4c infra emits this contract.
 */
export interface StatusResponse {
  pipeline: PipelineState;
  circuitBreaker: CircuitBreakerEntry[];
  crew: CrewState;
  /** ISO timestamp of when the handler generated the response */
  generatedAt?: string;
  /**
   * If not null/undefined, some secondary stack is not deployed.
   * Display as a warning banner to avoid appearing healthy.
   */
  degraded?: string | null;
}

/** State of the useStatus hook */
export interface StatusState {
  loading: boolean;
  data: StatusResponse | null;
  error: string | null;
  lastUpdated: string | null; // ISO timestamp of the last successful response
}
