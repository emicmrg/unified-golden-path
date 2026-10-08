/**
 * coldChain.ts — Domain logic for clinical cold chain monitoring.
 *
 * Reference ranges (vaccines / clinical cold chain, WHO/CDC):
 *   Temperature: 2 °C – 8 °C  (both endpoints INCLUSIVE)
 *   Humidity:   30 %RH – 60 %RH (both endpoints INCLUSIVE)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classification status of an environmental reading */
export type ReadingStatus = "OK" | "WARN" | "ALARM";

/** Environmental reading from an edge device */
export interface Reading {
  /** Temperature in degrees Celsius */
  temperatureCelsius: number;
  /** Relative humidity in percent (0–100) */
  humidityPercent: number;
  /** Device identifier (optional) */
  deviceId?: string;
  /** ISO 8601 timestamp (optional) */
  timestamp?: string;
}

/** Result of classifying a reading */
export interface ClassificationResult {
  status: ReadingStatus;
  temperatureOk: boolean;
  humidityOk: boolean;
  details: string;
}

/** Result of evaluating a batch of readings */
export interface BatchEvaluation {
  totalReadings: number;
  okCount: number;
  warnCount: number;
  alarmCount: number;
  worstStatus: ReadingStatus;
  results: ClassificationResult[];
}

// ---------------------------------------------------------------------------
// Range constants
// ---------------------------------------------------------------------------

/** Minimum safe temperature (°C) — clinical cold chain */
export const TEMP_MIN_C = 2.0;
/** Maximum safe temperature (°C) — clinical cold chain */
export const TEMP_MAX_C = 8.0;

/** Minimum safe humidity (%RH) */
export const HUMIDITY_MIN_PCT = 30;
/** Maximum safe humidity (%RH) */
export const HUMIDITY_MAX_PCT = 60;

// Warning margins (slight deviation before alarm)
const TEMP_WARN_LOW_C = 1.0;   // >= 1.0 and < 2.0 → WARN
const TEMP_WARN_HIGH_C = 10.0; // > 8.0 and <= 10.0 → WARN
const HUMIDITY_WARN_LOW_PCT = 20;  // >= 20 and < 30 → WARN
const HUMIDITY_WARN_HIGH_PCT = 70; // > 60 and <= 70 → WARN

// trigger CI re-run for self-heal dry run (attempt 2 — litellm 1.88.6 image)

// ---------------------------------------------------------------------------
// Pure validation functions
// ---------------------------------------------------------------------------

/**
 * Validates that a temperature value is within the safe clinical range.
 * @throws {TypeError} if the value is not a finite number
 */
export function validateTemperature(celsius: number): boolean {
  if (!Number.isFinite(celsius)) {
    throw new TypeError(
      `validateTemperature: expected a finite number, received: ${celsius}`
    );
  }
  // BUG: operador > en lugar de >= excluye el límite inferior 2.0 °C
  return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;
}

/**
 * Validates that a humidity value is within the safe clinical range.
 * @throws {TypeError} if the value is not a finite number or is outside the physical domain (0–100)
 */
export function validateHumidity(humidityPercent: number): boolean {
  if (!Number.isFinite(humidityPercent)) {
    throw new TypeError(
      `validateHumidity: expected a finite number, received: ${humidityPercent}`
    );
  }
  if (humidityPercent < 0 || humidityPercent > 100) {
    throw new RangeError(
      `validateHumidity: value outside physical domain (0–100): ${humidityPercent}`
    );
  }
  return (
    humidityPercent >= HUMIDITY_MIN_PCT && humidityPercent <= HUMIDITY_MAX_PCT
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classifies an environmental reading as OK / WARN / ALARM.
 *
 * Logic:
 *   - ALARM: temperature or humidity outside the warning margin (dangerously extreme values).
 *   - WARN:  temperature or humidity outside the safe range but within the warning margin.
 *   - OK:    both values within the safe range.
 *
 * @throws {TypeError|RangeError} if any numeric field is invalid
 */
export function classifyReading(reading: Reading): ClassificationResult {
  const { temperatureCelsius, humidityPercent } = reading;

  // Validate inputs (propagate the error to the caller)
  const tempOk = validateTemperature(temperatureCelsius);
  const humOk = validateHumidity(humidityPercent);

  // Determine if in alarm zone
  const tempAlarm =
    temperatureCelsius < TEMP_WARN_LOW_C || temperatureCelsius > TEMP_WARN_HIGH_C;
  const humAlarm =
    humidityPercent < HUMIDITY_WARN_LOW_PCT || humidityPercent > HUMIDITY_WARN_HIGH_PCT;

  // Determine if in warning zone (outside safe range but not in alarm)
  const tempWarn = !tempOk && !tempAlarm;
  const humWarn = !humOk && !humAlarm;

  let status: ReadingStatus;
  if (tempAlarm || humAlarm) {
    status = "ALARM";
  } else if (tempWarn || humWarn) {
    status = "WARN";
  } else {
    status = "OK";
  }

  const details = buildDetails(temperatureCelsius, humidityPercent, tempOk, humOk);

  return { status, temperatureOk: tempOk, humidityOk: humOk, details };
}

function buildDetails(
  temp: number,
  hum: number,
  tempOk: boolean,
  humOk: boolean
): string {
  const parts: string[] = [];
  if (!tempOk) {
    parts.push(
      `temperature ${temp}°C outside range [${TEMP_MIN_C}, ${TEMP_MAX_C}]°C`
    );
  }
  if (!humOk) {
    parts.push(
      `humidity ${hum}%RH outside range [${HUMIDITY_MIN_PCT}, ${HUMIDITY_MAX_PCT}]%RH`
    );
  }
  return parts.length > 0 ? parts.join("; ") : "all parameters within range";
}

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates a batch of readings and returns aggregated statistics.
 * @throws {Error} if the batch is empty
 */
export function evaluateBatch(readings: Reading[]): BatchEvaluation {
  if (readings.length === 0) {
    throw new Error("evaluateBatch: batch cannot be empty");
  }

  const results = readings.map((r) => classifyReading(r));

  const okCount = results.filter((r) => r.status === "OK").length;
  const warnCount = results.filter((r) => r.status === "WARN").length;
  const alarmCount = results.filter((r) => r.status === "ALARM").length;

  let worstStatus: ReadingStatus = "OK";
  if (alarmCount > 0) worstStatus = "ALARM";
  else if (warnCount > 0) worstStatus = "WARN";

  return {
    totalReadings: readings.length,
    okCount,
    warnCount,
    alarmCount,
    worstStatus,
    results,
  };
}
