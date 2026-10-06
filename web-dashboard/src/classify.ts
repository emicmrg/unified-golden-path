/**
 * classify.ts — Classification logic for environmental readings.
 *
 * Ranges consistent with classifyReading() in the sample-service (coldChain.ts):
 *   Temperature:  OK  [2, 8] °C
 *                 WARN [1, 2) ∪ (8, 10] °C
 *                 ALARM < 1 ∪ > 10 °C
 *   Humidity:     OK  [30, 60] %RH
 *                 WARN [20, 30) ∪ (60, 70] %RH
 *                 ALARM < 20 ∪ > 70 %RH
 */

import type { ReadingStatus } from "./types.js";

// Safe ranges
export const TEMP_MIN_C = 2.0;
export const TEMP_MAX_C = 8.0;
export const HUMIDITY_MIN_PCT = 30;
export const HUMIDITY_MAX_PCT = 60;

// Warning margins
const TEMP_WARN_LOW = 1.0;
const TEMP_WARN_HIGH = 10.0;
const HUMIDITY_WARN_LOW = 20;
const HUMIDITY_WARN_HIGH = 70;

export interface ReadingClassification {
  status: ReadingStatus;
  temperatureOk: boolean;
  humidityOk: boolean;
}

export function classifyReading(
  temperatureCelsius: number,
  humidityPercent: number
): ReadingClassification {
  const tempOk = temperatureCelsius >= TEMP_MIN_C && temperatureCelsius <= TEMP_MAX_C;
  const humOk = humidityPercent >= HUMIDITY_MIN_PCT && humidityPercent <= HUMIDITY_MAX_PCT;

  const tempAlarm = temperatureCelsius < TEMP_WARN_LOW || temperatureCelsius > TEMP_WARN_HIGH;
  const humAlarm = humidityPercent < HUMIDITY_WARN_LOW || humidityPercent > HUMIDITY_WARN_HIGH;

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

  return { status, temperatureOk: tempOk, humidityOk: humOk };
}

/** Returns CSS color classes based on the reading status */
export function statusColorClass(status: ReadingStatus): string {
  switch (status) {
    case "OK":
      return "status-ok";
    case "WARN":
      return "status-warn";
    case "ALARM":
      return "status-alarm";
  }
}

/** Status label */
export function statusLabel(status: ReadingStatus): string {
  switch (status) {
    case "OK":
      return "✅ OK";
    case "WARN":
      return "⚠️ WARNING";
    case "ALARM":
      return "🚨 ALARM";
  }
}
