/**
 * @file esp_err.h (shim)
 * @brief ESP-IDF shim for host compilation (tests without ESP-IDF).
 *
 * Reflects the real values from esp_err.h in ESP-IDF 5.x:
 *   - esp_err_t is `int` (signed), NOT uint32_t.
 *   - ESP_OK = 0, ESP_FAIL = -1.
 *   - Positive error codes in the 0x100+ range.
 *
 * When compiled with idf.py this file is NOT used; ESP-IDF injects the
 * original from components/esp_common/include/esp_err.h.
 *
 * FIX Block 1d (MAJOR 5): corrected typedef uint32_t → int, values
 * aligned with ESP-IDF, added ESP_ERR_INVALID_STATE/NOT_SUPPORTED and
 * esp_err_to_name().
 */

#pragma once

#include <stdint.h>

/* ── Base type ─────────────────────────────────────────────────────────── */

typedef int esp_err_t;  /* Same as ESP-IDF: signed, not uint32_t */

/* ── Error codes ───────────────────────────────────────────────────────── */

#define ESP_OK               0       /**< Success */
#define ESP_FAIL             (-1)    /**< Generic error */

/* Range 0x100 — argument/state errors (same as ESP-IDF) */
#define ESP_ERR_NO_MEM       0x101   /**< Out of memory */
#define ESP_ERR_INVALID_ARG  0x102   /**< Invalid argument (NULL, out of range) */
#define ESP_ERR_INVALID_STATE 0x103  /**< Invalid state (e.g.: not initialized) */
#define ESP_ERR_INVALID_SIZE 0x104   /**< Invalid size */
#define ESP_ERR_NOT_FOUND    0x105   /**< Resource not found */
#define ESP_ERR_NOT_SUPPORTED 0x106  /**< Operation not supported (stub) */
#define ESP_ERR_TIMEOUT      0x107   /**< Timeout expired */

/* ── Utilities ─────────────────────────────────────────────────────────── */

/**
 * @brief Returns a descriptive string for an error code.
 *
 * Minimal implementation for host tests. In real ESP-IDF this function
 * looks up an auto-generated table.
 */
static inline const char *esp_err_to_name(esp_err_t code)
{
    switch (code) {
        case ESP_OK:                return "ESP_OK";
        case ESP_FAIL:              return "ESP_FAIL";
        case ESP_ERR_NO_MEM:        return "ESP_ERR_NO_MEM";
        case ESP_ERR_INVALID_ARG:   return "ESP_ERR_INVALID_ARG";
        case ESP_ERR_INVALID_STATE: return "ESP_ERR_INVALID_STATE";
        case ESP_ERR_INVALID_SIZE:  return "ESP_ERR_INVALID_SIZE";
        case ESP_ERR_NOT_FOUND:     return "ESP_ERR_NOT_FOUND";
        case ESP_ERR_NOT_SUPPORTED: return "ESP_ERR_NOT_SUPPORTED";
        case ESP_ERR_TIMEOUT:       return "ESP_ERR_TIMEOUT";
        default:                    return "ESP_ERR_UNKNOWN";
    }
}
