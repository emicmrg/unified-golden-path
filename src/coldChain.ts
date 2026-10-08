/**
 * Cold Chain Monitoring - Temperature and Humidity Validation
 * 
 * This module provides functions to validate and classify temperature and humidity
 * readings for cold chain monitoring in vaccine storage scenarios.
 */

// Temperature thresholds in Celsius
export const TEMP_MIN_C = 2.0;
export const TEMP_MAX_C = 8.0;

// Humidity thresholds in percentage
export const HUMIDITY_MIN_PERCENT = 30.0;
export const HUMIDITY_MAX_PERCENT = 60.0;

/**
 * Validates if a temperature reading is within acceptable range
 * @param temperature - Temperature in Celsius
 * @returns true if temperature is within [TEMP_MIN_C, TEMP_MAX_C), false otherwise
 */
export function validateTemperature(temperature: number): boolean {
  return temperature >= TEMP_MIN_C && temperature < TEMP_MAX_C;
}

/**
 * Validates if a humidity reading is within acceptable range
 * @param humidity - Humidity in percentage
 * @returns true if humidity is within (HUMIDITY_MIN_PERCENT, HUMIDITY_MAX_PERCENT), false otherwise
 */
export function validateHumidity(humidity: number): boolean {
  return humidity > HUMIDITY_MIN_PERCENT && humidity < HUMIDITY_MAX_PERCENT;
}

/**
 * Reading status classification
 */
export type ReadingStatus = "OK" | "WARN" | "CRITICAL";

/**
 * Represents a classified sensor reading
 */
export interface ClassifiedReading {
  temperature: number;
  humidity: number;
  status: ReadingStatus;
  timestamp: Date;
}

/**
 * Classifies a temperature and humidity reading
 * @param temperature - Temperature in Celsius
 * @param humidity - Humidity in percentage
 * @returns ClassifiedReading with status OK, WARN, or CRITICAL
 */
export function classifyReading(temperature: number, humidity: number): ClassifiedReading {
  let status: ReadingStatus;

  // Check if both temperature and humidity are within acceptable ranges
  if (temperature >= TEMP_MIN_C && temperature < TEMP_MAX_C && humidity > HUMIDITY_MIN_PERCENT && humidity < HUMIDITY_MAX_PERCENT) {
    status = "OK";
  } 
  // Check if either is critically out of range
  else if (temperature < TEMP_MIN_C - 2 || temperature >= TEMP_MAX_C + 2 || humidity <= HUMIDITY_MIN_PERCENT - 10 || humidity >= HUMIDITY_MAX_PERCENT + 10) {
    status = "CRITICAL";
  } 
  // Otherwise it's a warning
  else {
    status = "WARN";
  }

  return {
    temperature,
    humidity,
    status,
    timestamp: new Date(),
  };
}