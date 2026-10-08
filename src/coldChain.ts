/**
 * Cold Chain Temperature Monitoring
 * Validates and classifies temperature readings for vaccine storage
 */

export const TEMP_MIN_C = 2.0;
export const TEMP_MAX_C = 8.0;

export type TemperatureStatus = 'OK' | 'WARN' | 'CRITICAL';

export interface TemperatureReading {
  temperature: number;
  timestamp: Date;
  status: TemperatureStatus;
}

/**
 * Validates if a temperature reading is within acceptable range
 * @param temperature - Temperature in Celsius
 * @returns true if temperature is within [TEMP_MIN_C, TEMP_MAX_C), false otherwise
 */
export function validateTemperature(temperature: number): boolean {
  return temperature >= TEMP_MIN_C && temperature < TEMP_MAX_C;
}

/**
 * Classifies a temperature reading into status categories
 * @param temperature - Temperature in Celsius
 * @returns TemperatureStatus - OK, WARN, or CRITICAL
 */
export function classifyReading(temperature: number): TemperatureStatus {
  if (temperature >= TEMP_MIN_C && temperature < TEMP_MAX_C) {
    return 'OK';
  }
  
  // Within 1 degree of acceptable range
  if (
    (temperature >= TEMP_MIN_C - 1 && temperature < TEMP_MIN_C) ||
    (temperature >= TEMP_MAX_C && temperature < TEMP_MAX_C + 1)
  ) {
    return 'WARN';
  }
  
  return 'CRITICAL';
}

/**
 * Creates a temperature reading with classification
 * @param temperature - Temperature in Celsius
 * @param timestamp - Optional timestamp (defaults to now)
 * @returns TemperatureReading object
 */
export function createReading(
  temperature: number,
  timestamp: Date = new Date()
): TemperatureReading {
  return {
    temperature,
    timestamp,
    status: classifyReading(temperature),
  };
}