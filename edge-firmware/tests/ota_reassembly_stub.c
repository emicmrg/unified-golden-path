/**
 * @file ota_reassembly_stub.c
 * @brief Host-side stub that re-implements the ota_reassembly_feed / 
 *        ota_reassembly_get_buf / ota_reassembly_get_total / 
 *        ota_reassembly_reset symbols using only standard C.
 *
 * This file exists so the smoke test (test_ota_reassembly.c) can be compiled
 * with plain gcc — without any ESP-IDF headers, FreeRTOS, or esp-mqtt.
 *
 * The logic here mirrors ota_jobs.c exactly:
 *   - Same OTA_MAX_JOB_PAYLOAD_LEN constant (4096 B).
 *   - Same module-state variables.
 *   - Same malloc / memcpy / bounds-check flow.
 *
 * If ota_jobs.c is ever refactored, this stub MUST be kept in sync so the
 * test remains a valid smoke test of the production logic.
 */

#include "ota_reassembly_stub.h"

#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

/* ── Constants (must match ota_jobs.c) ───────────────────────────────────── */

#define OTA_MAX_JOB_PAYLOAD_LEN  4096

/* ── Module state (mirrors s_reassembly_* in ota_jobs.c) ─────────────────── */

static char  *s_reassembly_buf         = NULL;
static int    s_reassembly_total       = 0;
static int    s_reassembly_written     = 0;
static bool   s_reassembly_topic_match = false;

/* ── Internal reset ──────────────────────────────────────────────────────── */

void ota_reassembly_reset(void)
{
    if (s_reassembly_buf != NULL) {
        free(s_reassembly_buf);
        s_reassembly_buf = NULL;
    }
    s_reassembly_total        = 0;
    s_reassembly_written      = 0;
    s_reassembly_topic_match  = false;
}

/* ── ota_reassembly_feed ─────────────────────────────────────────────────── */

bool ota_reassembly_feed(int offset, const char *data, int len, int total,
                         bool *out_complete)
{
    if (out_complete != NULL) {
        *out_complete = false;
    }

    /* Normalise: esp-mqtt sets total_data_len == 0 for non-fragmented payloads */
    if (total == 0) {
        total = len;
    }

    if (data == NULL || len <= 0) {
        ota_reassembly_reset();
        return false;
    }

    if (offset == 0) {
        /* First chunk — allocate a fresh buffer */
        ota_reassembly_reset();
        s_reassembly_topic_match = true; /* caller guarantees topic matched */

        if (total > OTA_MAX_JOB_PAYLOAD_LEN) {
            s_reassembly_topic_match = false;
            return false;
        }

        s_reassembly_buf = (char *)malloc((size_t)total);
        if (s_reassembly_buf == NULL) {
            s_reassembly_topic_match = false;
            return false;
        }
        s_reassembly_total   = total;
        s_reassembly_written = 0;
    }

    /* Continuation chunk with no active buffer (prior error path) */
    if (s_reassembly_buf == NULL) {
        return false;
    }

    /* Bounds check */
    if (offset < 0 || offset + len > s_reassembly_total) {
        ota_reassembly_reset();
        return false;
    }

    memcpy(s_reassembly_buf + offset, data, (size_t)len);
    s_reassembly_written += len;

    if (out_complete != NULL) {
        *out_complete = (s_reassembly_written == s_reassembly_total);
    }
    return true;
}

/* ── Getters ─────────────────────────────────────────────────────────────── */

const char *ota_reassembly_get_buf(void)
{
    return s_reassembly_buf;
}

int ota_reassembly_get_total(void)
{
    return s_reassembly_total;
}
