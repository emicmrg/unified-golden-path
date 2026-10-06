/**
 * @file test_env_source_host.c
 * @brief Host-based unit test for env_source_simulated.c
 *
 * Compiles with gcc on macOS/Linux without ESP-IDF.
 * Validates that synthetic values fall within realistic clinical cold-chain ranges:
 *  - Temperature: ~4°C ± 2°C (WHO range: 2–8°C, with margin)
 *  - Humidity: ~45%RH ± 5%RH
 *
 * Usage:
 *   gcc -o test_env_source_host test_env_source_host.c main/env_source_simulated.c \
 *       -Imain -Iesp_shim -I. -Wextra -Wall
 *   ./test_env_source_host
 */

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>

/* ── Pull firmware code ─────────────────────────────────────────────────── */

#include "env_source.h"

/* Declaration of the factory defined in env_source_simulated.c */
extern EnvironmentSource environment_source_simulated(void);

/* ── Tests ───────────────────────────────────────────────────────────── */

static int test_count = 0;
static int test_passed = 0;
static int test_failed = 0;

#define ASSERT(cond, msg)                                                        \
    do {                                                                         \
        test_count++;                                                            \
        if (!(cond)) {                                                           \
            printf("  ✗ FAIL: %s\n", msg);                                       \
            test_failed++;                                                       \
        } else {                                                                 \
            printf("  ✓ PASS: %s\n", msg);                                       \
            test_passed++;                                                       \
        }                                                                        \
    } while (0)

#define ASSERT_RANGE(value, min, max, msg)                                      \
    ASSERT((value >= min && value <= max), msg)

int main(void) {
    printf("\n═══ env_source_simulated — Host Unit Tests ═══\n\n");

    EnvironmentSource src = environment_source_simulated();

    /* Initialize the source */
    esp_err_t ret = src.init(&src);
    ASSERT(ret == ESP_OK, "init() returns ESP_OK");
    ASSERT(src.name(&src) != NULL, "name() returns a valid pointer");
    ASSERT(src.ctx != NULL, "ctx is not NULL");

    printf("\n■ Checking 200 temperature and humidity readings:\n\n");

    float min_temp = 100.0f, max_temp = -100.0f;
    float min_hum = 100.0f, max_hum = -100.0f;
    float avg_temp = 0.0f, avg_hum = 0.0f;

    for (int i = 0; i < 200; i++) {
        float temp_c, humidity_pct;

        ret = src.read(&src, &temp_c, &humidity_pct);
        ASSERT(ret == ESP_OK, "read() returns ESP_OK");

        /* Update min/max/average */
        if (temp_c < min_temp) min_temp = temp_c;
        if (temp_c > max_temp) max_temp = temp_c;
        if (humidity_pct < min_hum) min_hum = humidity_pct;
        if (humidity_pct > max_hum) max_hum = humidity_pct;

        avg_temp += temp_c;
        avg_hum += humidity_pct;

        /* Per-reading tests */
        char buf[128];
        snprintf(buf, sizeof(buf), "Reading %d: T=%.1f°C is in [0, 10]°C", i + 1, temp_c);
        ASSERT_RANGE(temp_c, 0.0f, 10.0f, buf);

        snprintf(buf, sizeof(buf), "Reading %d: RH=%.1f%% is in [30, 60]%%", i + 1,
                 humidity_pct);
        ASSERT_RANGE(humidity_pct, 30.0f, 60.0f, buf);
    }

    avg_temp /= 200.0f;
    avg_hum /= 200.0f;

    printf("\n■ Statistics for 200 samples:\n");
    printf("  Temperature:      min=%.1f, max=%.1f, average=%.1f °C\n", min_temp, max_temp,
           avg_temp);
    printf("  Relative humidity: min=%.1f, max=%.1f, average=%.1f %%\n", min_hum, max_hum,
           avg_hum);

    /* Statistical validations */
    printf("\n■ Statistical validations:\n\n");
    ASSERT_RANGE(avg_temp, 2.0f, 6.0f, "Average T ≈ 4°C");
    ASSERT_RANGE(avg_hum, 40.0f, 50.0f, "Average RH ≈ 45%%");
    ASSERT(max_temp - min_temp < 3.0f, "T range < 3°C (realistic variation)");
    ASSERT(max_hum - min_hum < 8.0f, "RH range < 8%% (realistic variation)");

    /* Edge case: NULL pointer validation */
    printf("\n■ Input validation tests:\n\n");
    ret = src.read(&src, NULL, NULL);
    ASSERT(ret == ESP_ERR_INVALID_ARG, "read(NULL, NULL) returns ESP_ERR_INVALID_ARG");

    float dummy;
    ret = src.read(&src, NULL, &dummy);
    ASSERT(ret == ESP_ERR_INVALID_ARG, "read(NULL, &dummy) returns ESP_ERR_INVALID_ARG");

    ret = src.read(&src, &dummy, NULL);
    ASSERT(ret == ESP_ERR_INVALID_ARG, "read(&dummy, NULL) returns ESP_ERR_INVALID_ARG");

    /* Summary */
    printf("\n═══════════════════════════════════════════════════\n");
    printf("Summary: %d/%d tests passed (%d failures)\n", test_passed, test_count, test_failed);
    printf("═══════════════════════════════════════════════════\n\n");

    return test_failed == 0 ? 0 : 1;
}
