/**
 * index.ts — Entry point for the clinical cold chain sample-service.
 *
 * Exposes the domain functions and a Lambda-style handler that can
 * receive a batch of readings (JSON) and return the aggregated evaluation.
 */

export {
  validateTemperature,
  validateHumidity,
  classifyReading,
  evaluateBatch,
  TEMP_MIN_C,
  TEMP_MAX_C,
  HUMIDITY_MIN_PCT,
  HUMIDITY_MAX_PCT,
} from "./coldChain.js";

export type {
  Reading,
  ClassificationResult,
  BatchEvaluation,
  ReadingStatus,
} from "./coldChain.js";

import { evaluateBatch } from "./coldChain.js";
import type { Reading, BatchEvaluation } from "./coldChain.js";

// ---------------------------------------------------------------------------
// Lambda-style handler (no AWS runtime dependencies)
// ---------------------------------------------------------------------------

export interface LambdaEvent {
  readings: Reading[];
}

export interface LambdaResponse {
  statusCode: number;
  body: string;
}

/**
 * Lambda-compatible handler to evaluate a batch of cold chain readings.
 * Receives an event with a `readings` array and returns the aggregated evaluation.
 */
export function handler(event: LambdaEvent): LambdaResponse {
  try {
    if (!Array.isArray(event.readings)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "The 'readings' field must be an array" }),
      };
    }

    const evaluation: BatchEvaluation = evaluateBatch(event.readings);

    return {
      statusCode: 200,
      body: JSON.stringify(evaluation),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      statusCode: 422,
      body: JSON.stringify({ error: message }),
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal CLI (node dist/index.js)
// ---------------------------------------------------------------------------

// Only executed when this is the main module (invoked directly by node)
if (require.main === module) {
  const sampleReadings: Reading[] = [
    { deviceId: "edge-001", temperatureCelsius: 4.5, humidityPercent: 45, timestamp: new Date().toISOString() },
    { deviceId: "edge-002", temperatureCelsius: 8.0, humidityPercent: 60, timestamp: new Date().toISOString() },
    { deviceId: "edge-003", temperatureCelsius: 9.1, humidityPercent: 65, timestamp: new Date().toISOString() },
    { deviceId: "edge-004", temperatureCelsius: -1.0, humidityPercent: 15, timestamp: new Date().toISOString() },
  ];

  const result = handler({ readings: sampleReadings });
  console.log("=== Cold chain evaluation ===");
  console.log(JSON.stringify(JSON.parse(result.body), null, 2));
}
