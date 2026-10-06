/**
 * classify.test.ts — Tests for the environmental reading classification logic.
 * Consistent with coldChain.ts in the sample-service.
 */

import { describe, it, expect } from "vitest";
import { classifyReading } from "../classify.js";

describe("classifyReading", () => {
  // ---------------------------------------------------------------------------
  // OK — within the safe range
  // ---------------------------------------------------------------------------
  describe("OK status", () => {
    it("temperature and humidity in the center of the range → OK", () => {
      const result = classifyReading(5, 45);
      expect(result.status).toBe("OK");
      expect(result.temperatureOk).toBe(true);
      expect(result.humidityOk).toBe(true);
    });

    it("temperature at the exact lower limit (2°C) → OK", () => {
      expect(classifyReading(2, 45).status).toBe("OK");
    });

    it("temperature at the exact upper limit (8°C) → OK", () => {
      expect(classifyReading(8, 45).status).toBe("OK");
    });

    it("humidity at the exact lower limit (30%RH) → OK", () => {
      expect(classifyReading(5, 30).status).toBe("OK");
    });

    it("humidity at the exact upper limit (60%RH) → OK", () => {
      expect(classifyReading(5, 60).status).toBe("OK");
    });
  });

  // ---------------------------------------------------------------------------
  // WARN — outside the safe range but within the warning margin
  // ---------------------------------------------------------------------------
  describe("WARN status", () => {
    it("slightly low temperature (1.5°C) → WARN", () => {
      const result = classifyReading(1.5, 45);
      expect(result.status).toBe("WARN");
      expect(result.temperatureOk).toBe(false);
    });

    it("slightly high temperature (9°C) → WARN", () => {
      expect(classifyReading(9, 45).status).toBe("WARN");
    });

    it("slightly low humidity (25%RH) → WARN", () => {
      expect(classifyReading(5, 25).status).toBe("WARN");
    });

    it("slightly high humidity (65%RH) → WARN", () => {
      expect(classifyReading(5, 65).status).toBe("WARN");
    });

    it("temperature at the lower warn margin limit (1.0°C) → WARN", () => {
      expect(classifyReading(1.0, 45).status).toBe("WARN");
    });

    it("temperature at the upper warn margin limit (10.0°C) → WARN", () => {
      expect(classifyReading(10.0, 45).status).toBe("WARN");
    });
  });

  // ---------------------------------------------------------------------------
  // ALARM — outside the warning margin (dangerous values)
  // ---------------------------------------------------------------------------
  describe("ALARM status", () => {
    it("very low temperature (0°C) → ALARM", () => {
      expect(classifyReading(0, 45).status).toBe("ALARM");
    });

    it("very high temperature (12°C) → ALARM", () => {
      expect(classifyReading(12, 45).status).toBe("ALARM");
    });

    it("negative temperature (-5°C) → ALARM", () => {
      expect(classifyReading(-5, 45).status).toBe("ALARM");
    });

    it("very low humidity (10%RH) → ALARM", () => {
      expect(classifyReading(5, 10).status).toBe("ALARM");
    });

    it("very high humidity (80%RH) → ALARM", () => {
      expect(classifyReading(5, 80).status).toBe("ALARM");
    });

    it("both in alarm zone → ALARM (worst case dominates)", () => {
      expect(classifyReading(-5, 5).status).toBe("ALARM");
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed cases: one metric OK, the other WARN → result is WARN
  // ---------------------------------------------------------------------------
  describe("mixed cases", () => {
    it("temperature OK + humidity WARN → WARN", () => {
      expect(classifyReading(5, 25).status).toBe("WARN");
    });

    it("temperature WARN + humidity OK → WARN", () => {
      expect(classifyReading(1.5, 45).status).toBe("WARN");
    });

    it("temperature OK + humidity ALARM → ALARM", () => {
      expect(classifyReading(5, 10).status).toBe("ALARM");
    });

    it("temperature ALARM + humidity OK → ALARM", () => {
      expect(classifyReading(-5, 45).status).toBe("ALARM");
    });
  });
});
