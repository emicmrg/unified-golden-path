/**
 * coldChain.test.ts — Full test suite for the clinical cold chain module.
 *
 * Coverage:
 *  - validateTemperature: range boundaries, values inside/outside, invalid inputs
 *  - validateHumidity:    range boundaries, values inside/outside, invalid inputs
 *  - classifyReading:     OK / WARN / ALARM classification for all cases
 *  - evaluateBatch:       batch aggregation, empty batch
 *  - handler:             200 / 400 / 422 responses
 */

import { describe, it, expect } from "vitest";
import {
  validateTemperature,
  validateHumidity,
  classifyReading,
  evaluateBatch,
  TEMP_MIN_C,
  TEMP_MAX_C,
  HUMIDITY_MIN_PCT,
  HUMIDITY_MAX_PCT,
} from "../coldChain";
import { handler } from "../index";
import type { Reading } from "../coldChain";

// ---------------------------------------------------------------------------
// validateTemperature
// ---------------------------------------------------------------------------
describe("validateTemperature", () => {
  it("returns true for the exact minimum temperature (2.0 °C)", () => {
    expect(validateTemperature(TEMP_MIN_C)).toBe(true);
  });

  it("returns true for the exact maximum temperature (8.0 °C)", () => {
    expect(validateTemperature(TEMP_MAX_C)).toBe(true);
  });

  it("returns true for a value in the middle of the range (5.0 °C)", () => {
    expect(validateTemperature(5.0)).toBe(true);
  });

  it("returns false for temperature just below the minimum (1.9 °C)", () => {
    expect(validateTemperature(1.9)).toBe(false);
  });

  it("returns false for temperature just above the maximum (8.1 °C)", () => {
    expect(validateTemperature(8.1)).toBe(false);
  });

  it("returns false for a clearly low temperature (-5.0 °C)", () => {
    expect(validateTemperature(-5.0)).toBe(false);
  });

  it("returns false for a clearly high temperature (25.0 °C)", () => {
    expect(validateTemperature(25.0)).toBe(false);
  });

  it("throws TypeError for NaN", () => {
    expect(() => validateTemperature(NaN)).toThrow(TypeError);
  });

  it("throws TypeError for Infinity", () => {
    expect(() => validateTemperature(Infinity)).toThrow(TypeError);
  });

  it("throws TypeError for -Infinity", () => {
    expect(() => validateTemperature(-Infinity)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// validateHumidity
// ---------------------------------------------------------------------------
describe("validateHumidity", () => {
  it("returns true for the exact minimum humidity (30 %RH)", () => {
    expect(validateHumidity(HUMIDITY_MIN_PCT)).toBe(true);
  });

  it("returns true for the exact maximum humidity (60 %RH)", () => {
    expect(validateHumidity(HUMIDITY_MAX_PCT)).toBe(true);
  });

  it("returns true for a value in the middle of the range (45 %RH)", () => {
    expect(validateHumidity(45)).toBe(true);
  });

  it("returns false for humidity just below the minimum (29.9 %RH)", () => {
    expect(validateHumidity(29.9)).toBe(false);
  });

  it("returns false for humidity just above the maximum (60.1 %RH)", () => {
    expect(validateHumidity(60.1)).toBe(false);
  });

  it("returns false for clearly low humidity (5 %RH)", () => {
    expect(validateHumidity(5)).toBe(false);
  });

  it("returns false for clearly high humidity (90 %RH)", () => {
    expect(validateHumidity(90)).toBe(false);
  });

  it("throws TypeError for NaN", () => {
    expect(() => validateHumidity(NaN)).toThrow(TypeError);
  });

  it("throws RangeError for -1 (outside physical domain)", () => {
    expect(() => validateHumidity(-1)).toThrow(RangeError);
  });

  it("throws RangeError for 101 (outside physical domain)", () => {
    expect(() => validateHumidity(101)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// classifyReading — OK status
// ---------------------------------------------------------------------------
describe("classifyReading → OK", () => {
  it("classifies OK for nominal reading (5.0 °C, 45 %RH)", () => {
    const r: Reading = { temperatureCelsius: 5.0, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.status).toBe("OK");
    expect(result.temperatureOk).toBe(true);
    expect(result.humidityOk).toBe(true);
  });

  it("classifies OK for exact lower boundary (2.0 °C, 30 %RH)", () => {
    const r: Reading = { temperatureCelsius: 2.0, humidityPercent: 30 };
    const result = classifyReading(r);
    expect(result.status).toBe("OK");
  });

  it("classifies OK for exact upper boundary (8.0 °C, 60 %RH)", () => {
    const r: Reading = { temperatureCelsius: 8.0, humidityPercent: 60 };
    const result = classifyReading(r);
    expect(result.status).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// classifyReading — WARN status
// ---------------------------------------------------------------------------
describe("classifyReading → WARN", () => {
  it("classifies WARN for slightly low temperature (1.5 °C) with OK humidity", () => {
    const r: Reading = { temperatureCelsius: 1.5, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.status).toBe("WARN");
    expect(result.temperatureOk).toBe(false);
  });

  it("classifies WARN for slightly high temperature (9.0 °C) with OK humidity", () => {
    const r: Reading = { temperatureCelsius: 9.0, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.status).toBe("WARN");
    expect(result.temperatureOk).toBe(false);
  });

  it("classifies WARN for slightly low humidity (25 %RH) with OK temperature", () => {
    const r: Reading = { temperatureCelsius: 5.0, humidityPercent: 25 };
    const result = classifyReading(r);
    expect(result.status).toBe("WARN");
    expect(result.humidityOk).toBe(false);
  });

  it("classifies WARN for slightly high humidity (65 %RH) with OK temperature", () => {
    const r: Reading = { temperatureCelsius: 5.0, humidityPercent: 65 };
    const result = classifyReading(r);
    expect(result.status).toBe("WARN");
    expect(result.humidityOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyReading — ALARM status
// ---------------------------------------------------------------------------
describe("classifyReading → ALARM", () => {
  it("classifies ALARM for very low temperature (0.5 °C)", () => {
    const r: Reading = { temperatureCelsius: 0.5, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.status).toBe("ALARM");
  });

  it("classifies ALARM for very high temperature (12.0 °C)", () => {
    const r: Reading = { temperatureCelsius: 12.0, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.status).toBe("ALARM");
  });

  it("classifies ALARM for negative temperature (-3.0 °C)", () => {
    const r: Reading = { temperatureCelsius: -3.0, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.status).toBe("ALARM");
  });

  it("classifies ALARM for extremely low humidity (5 %RH)", () => {
    const r: Reading = { temperatureCelsius: 5.0, humidityPercent: 5 };
    const result = classifyReading(r);
    expect(result.status).toBe("ALARM");
  });

  it("classifies ALARM for extremely high humidity (95 %RH)", () => {
    const r: Reading = { temperatureCelsius: 5.0, humidityPercent: 95 };
    const result = classifyReading(r);
    expect(result.status).toBe("ALARM");
  });

  it("classifies ALARM when both parameters are in the alarm zone", () => {
    const r: Reading = { temperatureCelsius: -5.0, humidityPercent: 5 };
    const result = classifyReading(r);
    expect(result.status).toBe("ALARM");
  });

  it("ALARM takes priority over WARN: temp WARN + hum ALARM → ALARM", () => {
    const r: Reading = { temperatureCelsius: 1.5, humidityPercent: 5 };
    const result = classifyReading(r);
    expect(result.status).toBe("ALARM");
  });
});

// ---------------------------------------------------------------------------
// classifyReading — details and deviceId
// ---------------------------------------------------------------------------
describe("classifyReading — details", () => {
  it("includes deviceId in the reading without issue", () => {
    const r: Reading = {
      temperatureCelsius: 5.0,
      humidityPercent: 45,
      deviceId: "sensor-01",
      timestamp: "2026-10-06T00:00:00Z",
    };
    const result = classifyReading(r);
    expect(result.status).toBe("OK");
  });

  it("details indicates 'within range' for an OK reading", () => {
    const r: Reading = { temperatureCelsius: 5.0, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.details).toMatch(/within range/);
  });

  it("details mentions the out-of-range temperature", () => {
    const r: Reading = { temperatureCelsius: 15.0, humidityPercent: 45 };
    const result = classifyReading(r);
    expect(result.details).toMatch(/temperature/);
  });

  it("throws TypeError if temperatureCelsius is NaN", () => {
    const r: Reading = { temperatureCelsius: NaN, humidityPercent: 45 };
    expect(() => classifyReading(r)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// evaluateBatch
// ---------------------------------------------------------------------------
describe("evaluateBatch", () => {
  const okReading: Reading = { temperatureCelsius: 5.0, humidityPercent: 45 };
  const warnReading: Reading = { temperatureCelsius: 9.0, humidityPercent: 45 };
  const alarmReading: Reading = { temperatureCelsius: -5.0, humidityPercent: 5 };

  it("throws Error for an empty batch", () => {
    expect(() => evaluateBatch([])).toThrow(Error);
  });

  it("returns worstStatus OK when all readings are OK", () => {
    const batch = evaluateBatch([okReading, okReading, okReading]);
    expect(batch.worstStatus).toBe("OK");
    expect(batch.okCount).toBe(3);
    expect(batch.warnCount).toBe(0);
    expect(batch.alarmCount).toBe(0);
    expect(batch.totalReadings).toBe(3);
  });

  it("returns worstStatus WARN when there is at least one WARN and no alarms", () => {
    const batch = evaluateBatch([okReading, warnReading, okReading]);
    expect(batch.worstStatus).toBe("WARN");
    expect(batch.warnCount).toBe(1);
    expect(batch.alarmCount).toBe(0);
  });

  it("returns worstStatus ALARM when there is at least one ALARM", () => {
    const batch = evaluateBatch([okReading, warnReading, alarmReading]);
    expect(batch.worstStatus).toBe("ALARM");
    expect(batch.alarmCount).toBe(1);
  });

  it("correctly counts mixed readings (2 OK, 1 WARN, 1 ALARM)", () => {
    const batch = evaluateBatch([okReading, okReading, warnReading, alarmReading]);
    expect(batch.totalReadings).toBe(4);
    expect(batch.okCount).toBe(2);
    expect(batch.warnCount).toBe(1);
    expect(batch.alarmCount).toBe(1);
  });

  it("results has the same length as the input", () => {
    const readings = [okReading, warnReading, alarmReading];
    const batch = evaluateBatch(readings);
    expect(batch.results).toHaveLength(3);
  });

  it("correctly classifies a single reading", () => {
    const batch = evaluateBatch([okReading]);
    expect(batch.totalReadings).toBe(1);
    expect(batch.worstStatus).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// handler (Lambda-compatible)
// ---------------------------------------------------------------------------
describe("handler", () => {
  it("responds 200 with evaluation for a valid batch", () => {
    const event = {
      readings: [
        { temperatureCelsius: 5.0, humidityPercent: 45 },
        { temperatureCelsius: 8.0, humidityPercent: 60 },
      ],
    };
    const response = handler(event);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalReadings).toBe(2);
    expect(body.worstStatus).toBe("OK");
  });

  it("responds 400 when readings is not an array", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = handler({ readings: "no-array" as any });
    expect(response.statusCode).toBe(400);
  });

  it("responds 422 when a reading contains NaN temperature", () => {
    const event = {
      readings: [{ temperatureCelsius: NaN, humidityPercent: 45 }],
    };
    const response = handler(event);
    expect(response.statusCode).toBe(422);
  });

  it("responds 422 for an empty batch", () => {
    const response = handler({ readings: [] });
    expect(response.statusCode).toBe(422);
  });

  it("detects ALARM in the response for a -5 °C reading", () => {
    const event = {
      readings: [{ temperatureCelsius: -5.0, humidityPercent: 5 }],
    };
    const response = handler(event);
    const body = JSON.parse(response.body);
    expect(body.worstStatus).toBe("ALARM");
  });
});
