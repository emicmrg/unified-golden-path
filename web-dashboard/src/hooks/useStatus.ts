/**
 * useStatus.ts — Polling hook for the Lambda Function URL (VITE_STATUS_API_URL).
 *
 * - GETs every POLL_INTERVAL_MS milliseconds.
 * - Cancels in-flight requests with AbortController on unmount or re-run.
 * - If the URL is not configured, returns an honest error state without crashing.
 * - Minimally validates the response shape before updating state.
 * - #7: rejects null on pipeline/crew, validates each circuitBreaker item.
 */

import { useEffect, useState } from "react";
import type { CircuitBreakerEntry, StatusResponse, StatusState } from "../types.js";
import { config } from "../config.js";

const POLL_INTERVAL_MS = 5_000;

const INITIAL_STATE: StatusState = {
  loading: false,
  data: null,
  error: null,
  lastUpdated: null,
};

/** #7: Validates a circuit breaker item to avoid NaN% width in the progress bar */
function isValidCircuitBreakerEntry(item: unknown): item is CircuitBreakerEntry {
  if (typeof item !== "object" || item === null) return false;
  const e = item as Record<string, unknown>;
  return (
    typeof e["runKey"] === "string" &&
    typeof e["attempts"] === "number" &&
    Number.isFinite(e["attempts"]) &&
    typeof e["maxAttempts"] === "number" &&
    Number.isFinite(e["maxAttempts"]) &&
    (e["maxAttempts"] as number) > 0 && // avoid division by zero
    typeof e["escalated"] === "boolean"
  );
}

function isValidStatusResponse(obj: unknown): obj is StatusResponse {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;

  // #7: pipeline and crew cannot be null (typeof null === "object")
  if (typeof r["pipeline"] !== "object" || r["pipeline"] === null) return false;
  if (typeof r["crew"] !== "object" || r["crew"] === null) return false;
  if (!Array.isArray(r["circuitBreaker"])) return false;

  // #7: every circuit breaker item must be valid
  const cb = r["circuitBreaker"] as unknown[];
  if (!cb.every(isValidCircuitBreakerEntry)) return false;

  return true;
}

export function useStatus(): StatusState {
  const [state, setState] = useState<StatusState>(INITIAL_STATE);

  useEffect(() => {
    if (!config.statusApiConfigured) {
      setState({
        loading: false,
        data: null,
        error:
          "Status API not configured. Check VITE_STATUS_API_URL.",
        lastUpdated: null,
      });
      return;
    }

    let intervalId: ReturnType<typeof setInterval>;
    let abortController: AbortController;

    const fetchStatus = async (): Promise<void> => {
      abortController = new AbortController();
      try {
        const response = await fetch(config.statusApiUrl!, {
          signal: abortController.signal,
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const json: unknown = await response.json();

        if (!isValidStatusResponse(json)) {
          throw new Error("API response does not match the expected format.");
        }

        setState({
          loading: false,
          data: json,
          error: null,
          lastUpdated: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Request intentionally cancelled — do not update state
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({
          ...prev,
          loading: false,
          error: `Error fetching status: ${message}`,
        }));
      }
    };

    // Initial load immediately
    setState((prev) => ({ ...prev, loading: true }));
    void fetchStatus();

    // Periodic polling
    intervalId = setInterval(() => {
      void fetchStatus();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      abortController?.abort();
    };
  }, []); // No dependencies: runs once on mount

  return state;
}
