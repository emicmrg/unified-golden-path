/**
 * @file mqtt_iot.h
 * @brief AWS IoT Core MQTT client over mutual TLS (built-in esp-mqtt + esp-tls).
 *
 * Uses the esp-mqtt component that ships with ESP-IDF 5.x (no managed
 * component required).  Mutual TLS is configured via
 * esp_mqtt_client_config_t:
 *   - broker.verification.certificate  → Amazon Root CA 1 (trust anchor)
 *   - credentials.authentication.certificate → device certificate
 *   - credentials.authentication.key        → device private key
 *
 * The three PEM files are embedded into the firmware image at build time
 * via EMBED_TXTFILES in CMakeLists.txt.  The linker exposes them as:
 *
 *   extern const uint8_t device_crt_pem_start[]   asm("_binary_device_crt_pem_start");
 *   extern const uint8_t device_crt_pem_end[]     asm("_binary_device_crt_pem_end");
 *   extern const uint8_t device_key_pem_start[]   asm("_binary_device_key_pem_start");
 *   extern const uint8_t device_key_pem_end[]     asm("_binary_device_key_pem_end");
 *   extern const uint8_t AmazonRootCA1_pem_start[] asm("_binary_AmazonRootCA1_pem_start");
 *   extern const uint8_t AmazonRootCA1_pem_end[]   asm("_binary_AmazonRootCA1_pem_end");
 *
 * Note: ESP-IDF replaces every '.' and '/' in the file path with '_' when
 * generating the symbol names.
 *
 * Dependencies (CMakeLists.txt REQUIRES):
 *   mqtt, esp_event
 */

#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Initialises the MQTT client configuration.
 *
 * Creates the esp_mqtt_client handle with:
 *   - Broker URI  : mqtts://CONFIG_UGP_IOT_ENDPOINT:CONFIG_UGP_MQTT_PORT
 *   - Client ID   : CONFIG_UGP_IOT_THING_NAME  (must be "ugp-gateway-01")
 *   - CA cert     : embedded AmazonRootCA1.pem
 *   - Device cert : embedded device.crt.pem
 *   - Device key  : embedded device.key.pem
 *
 * Must be called AFTER WiFi has obtained an IP address.
 * Must be called BEFORE mqtt_iot_start().
 *
 * @return ESP_OK on success; ESP_FAIL if handle creation fails.
 */
esp_err_t mqtt_iot_init(void);

/**
 * @brief Starts the MQTT client (connects to the broker asynchronously).
 *
 * The client will negotiate TLS and send a CONNECT packet.
 * Connection status is reported via ESP_LOGI/ESP_LOGE from the event handler.
 *
 * @return esp_mqtt_client_start() return value (ESP_OK on success).
 */
esp_err_t mqtt_iot_start(void);

/**
 * @brief Returns the raw esp_mqtt_client_handle_t used by this module.
 *
 * Intended for use by ota_jobs.c, which registers its own MQTT event handler
 * on the same client instead of opening a second connection.
 *
 * @return The client handle, or NULL if mqtt_iot_init() has not been called.
 */
struct esp_mqtt_client *mqtt_iot_get_client(void);

/**
 * @brief Returns true if the MQTT client is currently connected to the broker.
 *
 * The flag is set in MQTT_EVENT_CONNECTED and cleared in
 * MQTT_EVENT_DISCONNECTED / MQTT_EVENT_ERROR.
 *
 * Used by app_main.c health-check (B3 fix): the firmware must only be marked
 * VALID after BOTH WiFi AND MQTT are confirmed up.  Because mqtt_iot_start()
 * is asynchronous, the caller must poll this function after starting the
 * client.
 *
 * @return true if connected, false otherwise.
 */
bool mqtt_iot_is_connected(void);

/**
 * @brief Publishes a telemetry payload to CONFIG_UGP_TELEMETRY_TOPIC at QoS 1.
 *
 * JSON shape (matches web-dashboard/src/types.ts TelemetryMessage):
 * @code
 * {
 *   "deviceId":           "ugp-gateway-01",
 *   "temperatureCelsius": 4.32,
 *   "humidityPercent":    46.10,
 *   "timestamp":          "2026-10-07T20:54:43.000Z"
 * }
 * @endcode
 *
 * If the client is not yet connected the publish is silently skipped and
 * the telemetry continues to be logged locally via ESP_LOGI.
 *
 * @param temp_c        Temperature in degrees Celsius.
 * @param humidity_pct  Relative humidity in percent (%RH).
 */
void mqtt_iot_publish_telemetry(float temp_c, float humidity_pct);

#ifdef __cplusplus
}
#endif
