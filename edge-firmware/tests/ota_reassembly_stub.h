/**
 * @file ota_reassembly_stub.h
 * @brief Host-side stub declarations for the OTA reassembly pure helpers.
 *
 * Used by tests/test_ota_reassembly.c to link against a standard-C
 * implementation of ota_reassembly_feed without any ESP-IDF dependency.
 *
 * In the target (ESP32) build, these symbols are provided by ota_jobs.c.
 * In the host test build, they are provided by tests/ota_reassembly_stub.c.
 */

#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Accumulate one MQTT data chunk into the reassembly buffer.
 *
 * @param offset       Byte offset of this chunk within the full payload
 *                     (current_data_offset from esp-mqtt).
 * @param data         Pointer to the chunk bytes. Must not be NULL.
 * @param len          Number of bytes in this chunk (> 0).
 * @param total        Full payload length (total_data_len from esp-mqtt).
 *                     Pass 0 to indicate a non-fragmented single-chunk
 *                     delivery; the function normalises it to len.
 * @param out_complete If non-NULL, set to true when all bytes have been
 *                     accumulated (written == total).
 *
 * @return true  — chunk accepted, buffer is valid.
 *         false — chunk rejected (too large, out-of-bounds, NULL data);
 *                 the internal state has been reset.
 */
bool ota_reassembly_feed(int offset, const char *data, int len, int total,
                         bool *out_complete);

/**
 * @brief Return a read-only pointer to the completed reassembly buffer.
 *
 * Valid only after ota_reassembly_feed returns true with *out_complete==true.
 * The buffer is owned by the module; do NOT free it. Call
 * ota_reassembly_reset() when done.
 */
const char *ota_reassembly_get_buf(void);

/**
 * @brief Return the total expected payload length recorded in the module state.
 */
int ota_reassembly_get_total(void);

/**
 * @brief Free the reassembly buffer and reset all state.
 *
 * Must be called after processing a complete payload, or to abort a
 * partial session.
 */
void ota_reassembly_reset(void);

#ifdef __cplusplus
}
#endif
