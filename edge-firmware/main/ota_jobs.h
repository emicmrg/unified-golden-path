/**
 * @file ota_jobs.h
 * @brief AWS IoT Jobs OTA handler for the Unified Golden Path firmware.
 *
 * Subscribes to the AWS IoT Jobs MQTT topics that arrive on the existing
 * esp-mqtt connection (managed by mqtt_iot.c).  When a job with
 * operation == "ota-update" is received the handler:
 *
 *   1. Reports the execution as IN_PROGRESS.
 *   2. Downloads the firmware image from the S3 presigned URL via
 *      esp_https_ota() (TLS to AWS using the bundled root CA store).
 *   3. Validates the image (SHA-256 digest embedded by ESP-IDF).
 *   4. Marks the new partition as the boot partition.
 *   5. Reports the execution as SUCCEEDED and reboots.
 *
 * On any error the execution is immediately reported as FAILED so that
 * the AWS IoT Jobs service does not leave it stuck in IN_PROGRESS and can
 * retry / abort according to the Job Template policy.
 *
 * ## Rollback (A/B)
 *
 * When CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y the bootloader marks the
 * new image as ESP_OTA_IMG_PENDING_VERIFY on first boot.  app_main.c must
 * call ota_jobs_mark_valid_if_pending() after WiFi + MQTT are established
 * within the healthCheckSeconds window defined in the job document.
 *
 * If app_main.c does NOT call ota_jobs_mark_valid_if_pending() within that
 * window (or at all), the bootloader rolls back to the previous OTA
 * partition on the next reboot — which is the intended safety behaviour.
 *
 * NOTE: CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE must only be enabled AFTER
 * ota_jobs_mark_valid_if_pending() is wired into app_main.c.  Enabling it
 * without the call causes every OTA to roll back immediately.
 *
 * ## Shared MQTT handle
 *
 * ota_jobs uses the handle returned by mqtt_iot_get_client().
 * It does NOT open a second MQTT connection.
 *
 * Dependencies (CMakeLists.txt REQUIRES):
 *   esp_https_ota, app_update, mqtt, esp_event, json
 */

#pragma once

#include "esp_err.h"
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Register the IoT Jobs OTA event handler on the existing MQTT client.
 *
 * Must be called AFTER mqtt_iot_start() — the event handler is attached to
 * the MQTT client handle obtained from mqtt_iot_get_client().  Topics are
 * subscribed inside the MQTT_EVENT_CONNECTED callback so they are
 * re-subscribed automatically after a reconnection.
 *
 * Can be called at most once.  Calling it a second time returns
 * ESP_ERR_INVALID_STATE without re-registering.
 *
 * @return ESP_OK on success.
 *         ESP_ERR_INVALID_STATE if the MQTT client handle is NULL (init
 *             not done) or the handler has already been registered.
 *         Other esp_err_t on registration failure.
 */
esp_err_t ota_jobs_start(void);

/**
 * @brief Confirm the running firmware is healthy after an OTA reboot.
 *
 * When CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y, the bootloader marks the
 * freshly booted image as ESP_OTA_IMG_PENDING_VERIFY.  This function:
 *   - Checks whether the running partition is in PENDING_VERIFY state.
 *   - If yes, calls esp_ota_mark_app_valid_cancel_rollback() to make the
 *     image permanent.
 *   - If the partition is already VALID (normal boot after a non-OTA
 *     reboot), the call is a no-op and returns ESP_OK.
 *
 * Call this from app_main.c AFTER WiFi and MQTT have reconnected
 * successfully (within the healthCheckSeconds budget declared in the job
 * document).
 *
 * @return ESP_OK   — valid already, or successfully marked valid.
 *         Other esp_err_t — mark_valid failed; the system should reboot so
 *         the bootloader can roll back.
 */
esp_err_t ota_jobs_mark_valid_if_pending(void);

/* ── Pure reassembly helpers (testeable desde host) ─────────────────────── */

/**
 * @brief Accumulate one MQTT chunk into the shared reassembly buffer.
 *
 * Pure function: no ESP-IDF logging, no MQTT client, no FreeRTOS.  This
 * makes it callable from a host-side smoke test without any ESP-IDF stubs.
 *
 * See the full doc-comment in ota_jobs.c.
 *
 * @param offset       current_data_offset of this chunk.
 * @param data         Pointer to chunk bytes.
 * @param len          Chunk length in bytes (> 0).
 * @param total        Total expected payload (total_data_len; 0 == non-fragmented).
 * @param out_complete Set to true when the payload is complete.  May be NULL.
 * @return true on success, false if the chunk was rejected (state reset).
 */
bool ota_reassembly_feed(int offset, const char *data, int len, int total,
                         bool *out_complete);

/**
 * @brief Return a read-only pointer to the reassembly buffer.
 *
 * Valid only when ota_reassembly_feed returned true with *out_complete==true.
 */
const char *ota_reassembly_get_buf(void);

/**
 * @brief Return the total expected payload length stored in the reassembly state.
 */
int ota_reassembly_get_total(void);

#ifdef __cplusplus
}
#endif
