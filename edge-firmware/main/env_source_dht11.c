/**
 * @file env_source_dht11.c
 * @brief STUB — Dht11Source implementation of EnvironmentSource.
 *
 * Target sensor: ARD-360 (labelled on the module; assumed DHT11 —
 * confirm physical IC marking before implementing the protocol).
 *
 * The DHT11 uses a proprietary 40-bit 1-wire protocol:
 *   8b humidity integer + 8b humidity decimal + 8b temp integer +
 *   8b temp decimal + 8b checksum.
 *
 * Start protocol (host → sensor):
 *   1. Pull DATA line LOW ≥ 18 ms  (start pull-down).
 *   2. Pull HIGH and wait for sensor response (20–40 µs).
 *   3. Sensor pulls LOW 80 µs, HIGH 80 µs → "ready" signal.
 *   4. Read 40 bits: '0' = 50µs low + 26–28µs high;
 *                    '1' = 50µs low + 70µs high.
 *
 * TODO (Block 3 — hardware confirmed):
 *   1. Confirm that the ARD-360 is a DHT11 (not DHT22/AM2302).
 *   2. Implement dht11_send_start() with gpio_set_direction /
 *      gpio_set_level / esp_rom_delay_us.
 *   3. Implement dht11_read_bits() reading pulses via
 *      gpio_get_level + esp_timer_get_time() to measure widths.
 *   4. Validate 8-bit checksum.
 *   5. Consider using the idf-extra-components/dht component if available
 *      in the IDF Component Manager to avoid reinventing the wheel.
 *
 * Default GPIO: CONFIG_UGP_DHT11_GPIO (Kconfig, default 4).
 * Recommended ESP32 pin: GPIO4 (digital input/output, not ADC-only).
 *
 * FIX Block 1d (MAJOR 3): added NULL-checks in dht11_init, dht11_read
 *   and dht11_name to avoid crash with NULL self or NULL self->ctx.
 * FIX Block 1d (MINOR): dht11_init validates the GPIO range and rejects
 *   GPIOs incompatible with bidirectional DHT11 (6–11 = SPI flash,
 *   34–39 = input-only).
 */

#include "env_source.h"

#include <stdint.h>
#include "driver/gpio.h"
#include "esp_log.h"

#define TAG "env_dht11"

/* ── GPIOs incompatible with bidirectional DHT11 ───────────────────────── */

/**
 * @brief Validates that a GPIO is suitable for DHT11 on ESP32.
 *
 * Rejects:
 *   - GPIO 6–11: connected to the internal SPI flash (guaranteed brick).
 *   - GPIO 34–39: input-only; DHT11 requires a bidirectional pin.
 *
 * @return true if the GPIO is usable, false if it must be rejected.
 */
static bool gpio_valid_for_dht11(gpio_num_t gpio)
{
    if (gpio < GPIO_NUM_0 || gpio > GPIO_NUM_39) {
        return false; /* outside absolute range */
    }
    if (gpio >= 6 && gpio <= 11) {
        return false; /* internal SPI flash — do not touch */
    }
    if (gpio >= 34 && gpio <= 39) {
        return false; /* input-only — DHT11 also needs output */
    }
    return true;
}

/* ── Private state ─────────────────────────────────────────────────────── */

typedef struct {
    gpio_num_t data_gpio; /**< GPIO connected to the DHT11 DATA pin */
    bool       initialized;
} Dht11Ctx;

/* Singleton: the firmware instantiates a single DHT11 source */
static Dht11Ctx s_dht11_ctx = {
    .data_gpio   = GPIO_NUM_4,
    .initialized = false,
};

/* ── Interface implementation ───────────────────────────────────────────── */

/**
 * FIX (MAJOR 3): validate self before dereferencing.
 *   In init, ctx can only be NULL if someone manually constructs an
 *   EnvironmentSource with ctx=NULL; we reject that case.
 * FIX (MINOR): validate GPIO suitable for bidirectional DHT11.
 */
static esp_err_t dht11_init(EnvironmentSource *self)
{
    if (self == NULL || self->ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    Dht11Ctx *ctx = (Dht11Ctx *)self->ctx;

    /* Validate GPIO before proceeding */
    if (!gpio_valid_for_dht11(ctx->data_gpio)) {
        ESP_LOGE(TAG, "Dht11Source: GPIO=%d is not suitable for DHT11 "
                 "(6-11 = SPI flash, 34-39 = input-only)",
                 (int)ctx->data_gpio);
        return ESP_ERR_INVALID_ARG;
    }

    ESP_LOGI(TAG, "Dht11Source: GPIO=%d (ARD-360, assumed DHT11 — confirm marking)",
             (int)ctx->data_gpio);

    /* TODO (Block 3): configure GPIO as open-drain with internal pull-up.
     *   gpio_config_t io_conf = {
     *       .pin_bit_mask = (1ULL << ctx->data_gpio),
     *       .mode         = GPIO_MODE_INPUT_OUTPUT_OD,
     *       .pull_up_en   = GPIO_PULLUP_ENABLE,
     *       .pull_down_en = GPIO_PULLDOWN_DISABLE,
     *       .intr_type    = GPIO_INTR_DISABLE,
     *   };
     *   esp_err_t ret = gpio_config(&io_conf);
     *   if (ret != ESP_OK) return ret;
     */

    ctx->initialized = true;
    ESP_LOGW(TAG, "Dht11Source: STUB — init OK (GPIO not configured yet)");
    return ESP_OK;
}

/**
 * FIX (MAJOR 3): validate self and self->ctx before dereferencing.
 */
static esp_err_t dht11_read(EnvironmentSource *self,
                            float *temp_c,
                            float *humidity_pct)
{
    if (self == NULL || self->ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (temp_c == NULL || humidity_pct == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    Dht11Ctx *ctx = (Dht11Ctx *)self->ctx;
    if (!ctx->initialized) {
        ESP_LOGE(TAG, "Dht11Source: call init() before read()");
        return ESP_ERR_INVALID_STATE;
    }

    /* TODO (Block 3): implement 1-wire DHT11 protocol.
     *   Steps:
     *   1. dht11_send_start(ctx->data_gpio)
     *   2. uint8_t raw[5] = {0};
     *      esp_err_t ret = dht11_read_bits(ctx->data_gpio, raw, 40);
     *      if (ret != ESP_OK) return ret;
     *   3. uint8_t chk = raw[0]+raw[1]+raw[2]+raw[3];
     *      if (chk != raw[4]) return ESP_ERR_INVALID_CRC;
     *   4. *humidity_pct = raw[0] + raw[1] * 0.1f;
     *      *temp_c       = raw[2] + raw[3] * 0.1f;
     */

    /* STUB: returns fixed values marked as unsupported for now */
    ESP_LOGW(TAG, "Dht11Source: STUB — real read not implemented (Block 3)");
    *temp_c       = 0.0f; /* placeholder — NOT a real reading */
    *humidity_pct = 0.0f; /* placeholder — NOT a real reading */
    return ESP_ERR_NOT_SUPPORTED;
}

/**
 * FIX (MAJOR 3): return safe literal if self is NULL.
 */
static const char *dht11_name(EnvironmentSource *self)
{
    if (self == NULL) {
        return "dht11(null)";
    }
    (void)self;
    return "dht11";
}

/* ── Public factory ─────────────────────────────────────────────────────── */

/**
 * @brief Returns an EnvironmentSource instance backed by DHT11.
 *
 * @param data_gpio GPIO where the ARD-360 sensor DATA pin is connected.
 *                  Use CONFIG_UGP_DHT11_GPIO (Kconfig) as the default value.
 *                  GPIOs 6–11 and 34–39 are rejected in dht11_init().
 * @return EnvironmentSource struct with function pointers for DHT11.
 */
EnvironmentSource environment_source_dht11(gpio_num_t data_gpio)
{
    s_dht11_ctx.data_gpio   = data_gpio;
    s_dht11_ctx.initialized = false;

    EnvironmentSource src = {
        .init         = dht11_init,
        .read         = dht11_read,
        .name         = dht11_name,
        .ctx          = &s_dht11_ctx,
    };
    return src;
}
