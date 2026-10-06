/**
 * @file app_main.c
 * @brief Entry point for the edge firmware — Unified Golden Path.
 *
 * Architecture:
 *   - Selects the environment source (SimulatedSource or Dht11Source)
 *     according to the compile-time option CONFIG_UGP_SOURCE_SIMULATED /
 *     CONFIG_UGP_SOURCE_DHT11 defined in Kconfig.projbuild.
 *   - Initializes the source.
 *   - Main loop (FreeRTOS task): reads temperature + humidity and logs
 *     them via ESP_LOGI.
 *
 * Placeholders for upcoming blocks:
 *   - TODO (Block 2): publish telemetry to AWS IoT Core via MQTT.
 *   - TODO (Block 2): subscribe to IoT Jobs to receive OTA commands.
 *   - TODO (Block 3): implement DHT11 protocol in env_source_dht11.c.
 */

#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"

#include "env_source.h"
#include "env_source_simulated.h"
#include "env_source_dht11.h"

#define TAG "app_main"

/** Sampling period in milliseconds (2 s by default). */
#define UGP_SAMPLE_PERIOD_MS 2000

/* ── Source selection via Kconfig ───────────────────────────────────────── */

/**
 * @brief Builds and returns the configured environment source.
 *
 * If the selected source is unavailable (DHT11 stub returns
 * ESP_ERR_NOT_SUPPORTED), the system logs the event but keeps running:
 * this allows verifying the loop without hardware.
 */
static EnvironmentSource build_source(void)
{
#if defined(CONFIG_UGP_SOURCE_DHT11)
    ESP_LOGI(TAG, "Selected source: DHT11 (GPIO %d)", CONFIG_UGP_DHT11_GPIO);
    return environment_source_dht11((gpio_num_t)CONFIG_UGP_DHT11_GPIO);
#else
    /* CONFIG_UGP_SOURCE_SIMULATED — default */
    ESP_LOGI(TAG, "Selected source: Simulated (clinical cold chain)");
    return environment_source_simulated();
#endif
}

/* ── app_main ───────────────────────────────────────────────────────────── */

void app_main(void)
{
    ESP_LOGI(TAG, "=== Unified Golden Path — Edge Firmware starting ===");
    ESP_LOGI(TAG, "Hardware: ESP32-D0WD-V3  MAC: 70:4b:ca:8f:23:10");

    /* TODO (Block 2): initialize NVS before WiFi/MQTT.
     *   esp_err_t nvs_err = nvs_flash_init();
     *   if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES ||
     *       nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
     *       nvs_flash_erase();
     *       nvs_flash_init();
     *   }
     */

    /* Build and initialize the environment source */
    EnvironmentSource src = build_source();
    ESP_LOGI(TAG, "EnvironmentSource: %s", src.name(&src));

    esp_err_t init_err = src.init(&src);
    if (init_err != ESP_OK) {
        ESP_LOGE(TAG, "init() failed: %s — aborting", esp_err_to_name(init_err));
        /* In production firmware this could retry or enter a safe mode.
         * For now, controlled halt for debugging. */
        return;
    }

    /* ── TODO (Block 2): initialize MQTT stack and connect to AWS IoT Core ── */
    /* mqtt_iot_init();        */
    /* mqtt_iot_connect();     */

    /* ── TODO (Block 2): register OTA Jobs handler ───────────────────────── */
    /* ota_jobs_start();       */

    ESP_LOGI(TAG, "Starting telemetry loop (period %d ms)", UGP_SAMPLE_PERIOD_MS);

    /* Main sampling loop */
    while (true) {
        float temp_c       = 0.0f;
        float humidity_pct = 0.0f;

        esp_err_t read_err = src.read(&src, &temp_c, &humidity_pct);

        if (read_err == ESP_OK) {
            ESP_LOGI(TAG, "[%s] Temp: %.2f °C  |  Humidity: %.1f %%RH",
                     src.name(&src), temp_c, humidity_pct);

            /* ── TODO (Block 2): publish JSON payload to AWS IoT Core ──── */
            /* mqtt_iot_publish_telemetry(temp_c, humidity_pct); */

        } else if (read_err == ESP_ERR_NOT_SUPPORTED) {
            /* DHT11 stub: expected until Block 3 */
            ESP_LOGW(TAG, "[%s] Read not supported (stub) — see Block 3",
                     src.name(&src));
        } else {
            ESP_LOGE(TAG, "[%s] Read error: %s",
                     src.name(&src), esp_err_to_name(read_err));
        }

        vTaskDelay(pdMS_TO_TICKS(UGP_SAMPLE_PERIOD_MS));
    }

    /* Note: in ESP-IDF app_main() must not return; the while(true) loop
     * prevents this. If a future break reaches here, ESP-IDF would delete
     * the task. It is not "unreachable" in the strict sense if exit logic
     * is added in future blocks. */
}
