/**
 * @file app_main.c
 * @brief Entry point for the edge firmware — Unified Golden Path.
 *
 * Initialization order:
 *   1. NVS flash init (required by WiFi driver).
 *   2. WiFi STA connect (blocks until IP obtained or retry limit).
 *   3. MQTT client init.
 *   4. OTA Jobs handler registration (subscribes to Jobs topics on MQTT connect).
 *   5. MQTT client start (async connect to AWS IoT Core).
 *   6. Rollback health check (B3/B4 fix):
 *      - Poll until MQTT is confirmed connected (or timeout).
 *      - Only THEN call ota_jobs_mark_valid_if_pending().
 *      - On failure: call esp_restart() so the bootloader can roll back
 *        to the previous OTA slot (not a bare return).
 *   7. Telemetry loop: reads sensor and publishes to AWS IoT Core every 2 s.
 *
 * Environment source:
 *   Selected at compile time via Kconfig (CONFIG_UGP_SOURCE_SIMULATED /
 *   CONFIG_UGP_SOURCE_DHT11).  DHT11 real driver is still a stub — Block 3.
 */

#include <stdint.h>
#include <stdbool.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"
#include "nvs_flash.h"

#include "env_source.h"
#include "env_source_simulated.h"
#include "env_source_dht11.h"
#include "wifi_sta.h"
#include "mqtt_iot.h"
#include "ota_jobs.h"

#define TAG "app_main"

/** Sampling period in milliseconds (2 s). */
#define UGP_SAMPLE_PERIOD_MS 2000

/**
 * Maximum time to wait for MQTT to connect after mqtt_iot_start(), in ms.
 *
 * FIX B3: mqtt_iot_start() is asynchronous — the TLS handshake and CONNACK
 * exchange happen in the background.  We poll mqtt_iot_is_connected() for up
 * to this many milliseconds before proceeding with the rollback health check.
 *
 * 30 s gives enough headroom for the TLS handshake over a mobile hotspot
 * without blocking the watchdog.
 */
#define MQTT_CONNECT_TIMEOUT_MS  30000

/** Poll interval while waiting for MQTT connection (ms). */
#define MQTT_CONNECT_POLL_MS  250

/* ── Source selection via Kconfig ───────────────────────────────────────── */

static EnvironmentSource build_source(void)
{
#if defined(CONFIG_UGP_SOURCE_DHT11)
    ESP_LOGI(TAG, "Selected source: DHT11 (GPIO %d)", CONFIG_UGP_DHT11_GPIO);
    return environment_source_dht11((gpio_num_t)CONFIG_UGP_DHT11_GPIO);
#else
    ESP_LOGI(TAG, "Selected source: Simulated (clinical cold chain)");
    return environment_source_simulated();
#endif
}

/* ── app_main ───────────────────────────────────────────────────────────── */

void app_main(void)
{
    ESP_LOGI(TAG, "=== Unified Golden Path — Edge Firmware starting ===");
    ESP_LOGI(TAG, "Hardware: ESP32-D0WD-V3  MAC: 70:4b:ca:8f:23:10");

    /* ── 1. NVS flash ───────────────────────────────────────────────────── */
    /* Required before WiFi driver initialises. */
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES ||
        nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS partition needs erase (err=%s)", esp_err_to_name(nvs_err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs_err = nvs_flash_init();
    }
    if (nvs_err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init failed: %s — rebooting",
                 esp_err_to_name(nvs_err));
        /*
         * FIX B4: NVS is critical infrastructure (WiFi/TLS use it).  A failure
         * here on a post-OTA boot should trigger rollback via esp_restart()
         * instead of silently hanging.  The bootloader with
         * CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y will revert to the previous
         * OTA slot if mark_valid was never called.
         */
        esp_restart();
        /* unreachable */
    }

    /* ── 2. WiFi STA ────────────────────────────────────────────────────── */
    esp_err_t wifi_err = wifi_sta_init_and_connect();
    if (wifi_err != ESP_OK) {
        ESP_LOGE(TAG, "wifi_sta_init_and_connect failed: %s — rebooting",
                 esp_err_to_name(wifi_err));
        /*
         * FIX B4: WiFi failure on a post-OTA boot means the health check
         * cannot be satisfied.  Reboot so the bootloader can roll back to the
         * previous good partition instead of running a degraded image.
         */
        esp_restart();
        /* unreachable */
    }

    /* ── 3. MQTT client init ────────────────────────────────────────────── */
    esp_err_t mqtt_err = mqtt_iot_init();
    if (mqtt_err != ESP_OK) {
        ESP_LOGE(TAG, "mqtt_iot_init failed: %s — rebooting",
                 esp_err_to_name(mqtt_err));
        /* FIX B4: same rationale — reboot to allow rollback. */
        esp_restart();
        /* unreachable */
    }

    /* ── 4. OTA Jobs handler ────────────────────────────────────────────── */
    /* Register the OTA handler BEFORE calling mqtt_iot_start() so that the
     * MQTT_EVENT_CONNECTED handler fires while ota_jobs is already listening.
     * ota_jobs_start() attaches to the shared MQTT client — no new connection. */
    esp_err_t ota_err = ota_jobs_start();
    if (ota_err != ESP_OK) {
        /* Non-fatal: telemetry can continue without OTA capability. */
        ESP_LOGW(TAG, "ota_jobs_start failed: %s — OTA disabled for this session",
                 esp_err_to_name(ota_err));
    }

    /* ── 5. MQTT client start ───────────────────────────────────────────── */
    mqtt_err = mqtt_iot_start();
    if (mqtt_err != ESP_OK) {
        ESP_LOGE(TAG, "mqtt_iot_start failed: %s — rebooting",
                 esp_err_to_name(mqtt_err));
        /* FIX B4: if we cannot even start the client, reboot for rollback. */
        esp_restart();
        /* unreachable */
    }

    /* ── 6. Rollback health check ───────────────────────────────────────── */
    /*
     * FIX B3: mqtt_iot_start() initiates the TLS handshake asynchronously.
     * The old code called ota_jobs_mark_valid_if_pending() immediately,
     * marking the image VALID before MQTT was confirmed — a firmware that
     * cannot reach AWS IoT Core would still be considered healthy.
     *
     * Correct behaviour: poll mqtt_iot_is_connected() until the broker
     * acknowledges our CONNECT packet (MQTT_EVENT_CONNECTED sets the flag)
     * or until MQTT_CONNECT_TIMEOUT_MS elapses.  Only then call mark_valid.
     *
     * If MQTT does not connect within the timeout on a post-OTA boot:
     *   → do NOT call mark_valid
     *   → reboot (FIX B4) so the bootloader rolls back to the previous slot.
     *
     * On non-OTA boots (partition state is already VALID or FACTORY):
     *   ota_jobs_mark_valid_if_pending() is a no-op, so the timeout is just
     *   a small startup delay — acceptable trade-off for correctness.
     */
    ESP_LOGI(TAG, "Health check: waiting for MQTT connection "
             "(timeout %d ms) …", MQTT_CONNECT_TIMEOUT_MS);

    int waited_ms = 0;
    while (!mqtt_iot_is_connected() && waited_ms < MQTT_CONNECT_TIMEOUT_MS) {
        vTaskDelay(pdMS_TO_TICKS(MQTT_CONNECT_POLL_MS));
        waited_ms += MQTT_CONNECT_POLL_MS;
    }

    if (!mqtt_iot_is_connected()) {
        ESP_LOGE(TAG,
                 "Health check FAILED: MQTT not connected after %d ms — "
                 "rebooting for rollback",
                 MQTT_CONNECT_TIMEOUT_MS);
        /*
         * FIX B3 + B4: do NOT call mark_valid; reboot so the bootloader
         * can revert to the previous OTA slot.
         */
        esp_restart();
        /* unreachable */
    }

    ESP_LOGI(TAG, "Health check: WiFi ✓  MQTT ✓  (waited %d ms)", waited_ms);

    /*
     * Both WiFi and MQTT are confirmed connected.  If this is the first boot
     * after an OTA (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y), the partition
     * is in PENDING_VERIFY state; mark it VALID to cancel the pending rollback.
     *
     * When CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE is NOT set this is a no-op.
     */
    esp_err_t mark_err = ota_jobs_mark_valid_if_pending();
    if (mark_err != ESP_OK) {
        ESP_LOGE(TAG,
                 "ota_jobs_mark_valid_if_pending failed: %s — rebooting for rollback",
                 esp_err_to_name(mark_err));
        /* FIX B4: mark_valid failure → reboot for rollback. */
        esp_restart();
        /* unreachable */
    }

    /* ── 7. Environment source ──────────────────────────────────────────── */
    EnvironmentSource src = build_source();
    ESP_LOGI(TAG, "EnvironmentSource: %s", src.name(&src));

    esp_err_t init_err = src.init(&src);
    if (init_err != ESP_OK) {
        ESP_LOGE(TAG, "init() failed: %s — aborting", esp_err_to_name(init_err));
        /* Sensor init failure is non-fatal for connectivity; we log and continue
         * (the telemetry loop will log errors on each read attempt). */
        return;
    }

    ESP_LOGI(TAG, "Starting telemetry loop (period %d ms)", UGP_SAMPLE_PERIOD_MS);

    /* ── 8. Telemetry loop ──────────────────────────────────────────────── */
    while (true) {
        float temp_c       = 0.0f;
        float humidity_pct = 0.0f;

        esp_err_t read_err = src.read(&src, &temp_c, &humidity_pct);

        if (read_err == ESP_OK) {
            ESP_LOGI(TAG, "[%s] Temp: %.2f °C  |  Humidity: %.1f %%RH",
                     src.name(&src), temp_c, humidity_pct);
            mqtt_iot_publish_telemetry(temp_c, humidity_pct);

        } else if (read_err == ESP_ERR_NOT_SUPPORTED) {
            /* DHT11 stub: expected until Block 3. */
            ESP_LOGW(TAG, "[%s] Read not supported (stub) — see Block 3",
                     src.name(&src));
        } else {
            ESP_LOGE(TAG, "[%s] Read error: %s",
                     src.name(&src), esp_err_to_name(read_err));
        }

        vTaskDelay(pdMS_TO_TICKS(UGP_SAMPLE_PERIOD_MS));
    }
}
