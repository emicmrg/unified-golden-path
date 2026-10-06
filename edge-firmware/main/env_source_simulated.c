/**
 * @file env_source_simulated.c
 * @brief SimulatedSource implementation of EnvironmentSource.
 *
 * Generates synthetic temperature and humidity simulating a clinical
 * cold chain (pharmaceutical / vaccines):
 *   - Nominal temperature : ~4 °C  (WHO valid range: 2–8 °C)
 *   - Nominal humidity     : ~45 %RH
 *
 * The variation is pseudo-deterministic: uses a sample counter as the
 * seed of a no-costly-trigonometry function (zig-zag), suitable for
 * running on FreeRTOS without a full FPU.
 *
 * Requires no hardware or GPIO. Useful in development and CI.
 *
 * FIX Block 1d (MAJOR 3): added NULL-checks in sim_init, sim_read and
 *   sim_name to avoid null-pointer dereference (crash with self/ctx NULL).
 * FIX Block 1d (MINOR): triangle_noise now guards against period==0
 *   to avoid division by zero.
 */

#include "env_source.h"

#include <stdint.h>
#include "esp_log.h"

#define TAG "env_sim"

/* ── Private state ─────────────────────────────────────────────────────── */

typedef struct {
    uint32_t sample_count; /**< Incremental read counter */
} SimulatedCtx;

static SimulatedCtx s_ctx = {0};

/* ── Variation helpers ─────────────────────────────────────────────────── */

/**
 * @brief Generates a pseudo-random value in [-1.0, +1.0] from an unsigned
 *        integer using a low-frequency triangular function.
 *
 * Avoids stdlib rand() to keep behavior reproducible across chip resets.
 *
 * FIX (MINOR): guard against period == 0 (division by zero).
 */
static float triangle_noise(uint32_t t, uint32_t period)
{
    /* Guard: if period is 0, return 0.0 (no variation) */
    if (period == 0U) {
        return 0.0f;
    }

    uint32_t phase = t % period;
    float    norm  = (float)phase / (float)period; /* 0.0 … 1.0 */
    /* triangle wave: rises 0→2, falls 2→0, shifted to [-1, +1] */
    float tri = (norm < 0.5f) ? (4.0f * norm - 1.0f)
                               : (3.0f - 4.0f * norm);
    return tri;
}

/* ── Interface implementation ───────────────────────────────────────────── */

/**
 * FIX (MAJOR 3): validate self and self->ctx before dereferencing.
 * In sim_init ctx must be assigned (factory sets it before calling init),
 * so we validate both.
 */
static esp_err_t sim_init(EnvironmentSource *self)
{
    if (self == NULL || self->ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    SimulatedCtx *ctx = (SimulatedCtx *)self->ctx;
    ctx->sample_count = 0;
    ESP_LOGI(TAG, "SimulatedSource initialized (clinical cold chain ~4°C/45%%RH)");
    return ESP_OK;
}

/**
 * FIX (MAJOR 3): validate self and self->ctx before dereferencing.
 */
static esp_err_t sim_read(EnvironmentSource *self,
                          float *temp_c,
                          float *humidity_pct)
{
    if (self == NULL || self->ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (temp_c == NULL || humidity_pct == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    SimulatedCtx *ctx = (SimulatedCtx *)self->ctx;
    ctx->sample_count++;

    /* Temperature: 4.0 °C ± 0.8 °C (period 37 samples) */
    float temp_noise = triangle_noise(ctx->sample_count, 37U) * 0.8f;
    *temp_c = 4.0f + temp_noise;

    /* Humidity: 45.0 %RH ± 3.0 %RH (period 53 samples, different phase) */
    float hum_noise  = triangle_noise(ctx->sample_count + 13U, 53U) * 3.0f;
    *humidity_pct = 45.0f + hum_noise;

    return ESP_OK;
}

/**
 * FIX (MAJOR 3): return safe literal if self is NULL.
 */
static const char *sim_name(EnvironmentSource *self)
{
    if (self == NULL) {
        return "simulated(null)";
    }
    (void)self;
    return "simulated";
}

/* ── Public factory ─────────────────────────────────────────────────────── */

/**
 * @brief Returns an EnvironmentSource instance backed by synthetic
 *        clinical cold-chain data.
 *
 * Internal state is stored in a static variable (singleton).
 * For a single-sensor firmware this is sufficient.
 *
 * @return EnvironmentSource struct initialized with function pointers.
 */
EnvironmentSource environment_source_simulated(void)
{
    EnvironmentSource src = {
        .init         = sim_init,
        .read         = sim_read,
        .name         = sim_name,
        .ctx          = &s_ctx,
    };
    return src;
}
