/**
 * @file env_source.h
 * @brief EnvironmentSource abstraction — unified interface for temperature
 *        and humidity sources in the edge firmware (Unified Golden Path).
 *
 * Pattern: method table (vtable) using function pointers in a struct.
 * Allows swapping the data source at compile time (Kconfig) or at runtime:
 *
 *   - SimulatedSource : deterministic synthetic data, useful in development
 *                       and CI without hardware.
 *   - Dht11Source     : ARD-360 / DHT11 sensor (or compatible) via GPIO
 *                       1-wire DHT protocol. Stub in this block; completed
 *                       once hardware is validated.
 *
 * Units: temperature in degrees Celsius (°C), humidity in %RH.
 *
 * Typical usage:
 * @code
 *   EnvironmentSource src = environment_source_simulated();
 *   ESP_ERROR_CHECK(src.init(&src));
 *   float temp, hum;
 *   if (src.read(&src, &temp, &hum) == ESP_OK) {
 *       ESP_LOGI(TAG, "T=%.2f°C H=%.1f%%RH", temp, hum);
 *   }
 * @endcode
 */

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief EnvironmentSource interface struct.
 *
 * Each implementation fills in the function pointers and may store its
 * private state in the @p ctx field.
 */
typedef struct EnvironmentSource {
    /**
     * @brief Initializes the source (configures GPIO, allocates resources, etc.).
     *
     * Must be called exactly once before any call to read().
     *
     * @param self Pointer to the instance.
     * @return ESP_OK if initialization was successful.
     */
    esp_err_t (*init)(struct EnvironmentSource *self);

    /**
     * @brief Reads current temperature and humidity.
     *
     * @param self        Pointer to the instance.
     * @param temp_c      [out] Temperature in degrees Celsius.
     * @param humidity_pct [out] Relative humidity in percent (%RH).
     * @return ESP_OK on success; error code on failure.
     */
    esp_err_t (*read)(struct EnvironmentSource *self,
                      float *temp_c,
                      float *humidity_pct);

    /**
     * @brief Returns the descriptive name of the source (e.g. "simulated",
     *        "dht11").  Must not return NULL.
     *
     * @param self Pointer to the instance.
     * @return Constant string with the name.
     */
    const char *(*name)(struct EnvironmentSource *self);

    /** @brief Private implementation state (opaque to the caller). */
    void *ctx;
} EnvironmentSource;

#ifdef __cplusplus
}
#endif
