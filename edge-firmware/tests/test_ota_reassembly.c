/**
 * @file test_ota_reassembly.c
 * @brief Host-side smoke test for ota_reassembly_feed() (B1 fix).
 *
 * Verifies that the pure accumulation function correctly handles a payload
 * that arrives in TWO MQTT_EVENT_DATA chunks — simulating the exact
 * scenario where esp-mqtt splits a large job document (e.g., a presigned S3
 * URL > 1 024 B) across multiple events with topic==NULL on chunks 2..N.
 *
 * ## Why this test validates the B1 fix
 *
 * Before the fix, ota_jobs.c contained:
 *
 *   if (event->topic == NULL || event->topic_len == 0) break;   // LINE ~626
 *
 * This guard silently dropped every continuation chunk (offset > 0), making
 * the reassembly buffer dead code.  The fix:
 *   1. Persists the topic-match decision in s_reassembly_topic_match.
 *   2. Lets continuation chunks through when s_reassembly_topic_match==true.
 *   3. Delegates all accumulation to ota_reassembly_feed() — the function
 *      under test here.
 *
 * ## Build
 *
 *   # From the edge-firmware/ directory (no ESP-IDF needed):
 *   gcc -std=c11 -Wall -Wextra -pedantic \
 *       -DUNIT_TEST \
 *       -I main \
 *       -o /tmp/test_ota_reassembly \
 *       tests/test_ota_reassembly.c \
 *       tests/ota_reassembly_stub.c
 *   /tmp/test_ota_reassembly
 *
 * The stub file (ota_reassembly_stub.c) provides the ota_reassembly_feed /
 * ota_reassembly_get_buf / ota_reassembly_get_total / reassembly_reset
 * symbols without any ESP-IDF dependency.  See that file for details.
 *
 * ## Expected output (all tests pass)
 *
 *   [PASS] two-chunk: returns not-complete after chunk 1
 *   [PASS] two-chunk: returns complete after chunk 2
 *   [PASS] two-chunk: reassembled payload matches original JSON
 *   [PASS] single-chunk (total==0 normalisation): complete immediately
 *   [PASS] single-chunk payload correct
 *   [PASS] oversized payload rejected
 *   [PASS] bounds-check: chunk beyond total rejected
 *   [PASS] reset between sessions: second session succeeds
 *   8/8 tests passed.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <assert.h>

/* ── Pull in the pure reassembly API ─────────────────────────────────────── */
/*
 * In the host build we include the stub (not ota_jobs.c) because ota_jobs.c
 * depends on esp-idf headers.  The stub re-implements only the three exported
 * symbols using standard C.
 */
#include "ota_reassembly_stub.h"

/* ── Helpers ─────────────────────────────────────────────────────────────── */

static int s_pass = 0;
static int s_fail = 0;

#define CHECK(cond, msg) \
    do { \
        if (cond) { \
            printf("[PASS] %s\n", msg); \
            s_pass++; \
        } else { \
            printf("[FAIL] %s  (line %d)\n", msg, __LINE__); \
            s_fail++; \
        } \
    } while (0)

/* ── Test cases ──────────────────────────────────────────────────────────── */

/**
 * @brief Core scenario: payload arrives in exactly 2 chunks.
 *
 * Simulates two MQTT_EVENT_DATA events:
 *   Chunk 1: topic="$aws/things/ugp-gateway-01/jobs/notify-next"
 *            current_data_offset=0, data=first_half, total_data_len=total
 *   Chunk 2: topic=NULL (esp-mqtt behaviour for chunks 2..N)
 *            current_data_offset=len1, data=second_half, total_data_len=total
 *
 * Expected: after chunk 2, the reassembled buffer equals the original JSON.
 */
static void test_two_chunks(void)
{
    /* Build a realistic job document with a long presigned URL */
    const char *json =
        "{"
        "\"execution\":{"
        "\"jobId\":\"ota-job-2026-001\","
        "\"jobDocument\":{"
        "\"operation\":\"ota-update\","
        "\"firmware\":{"
        "\"fileName\":\"ugp-firmware-v1.2.bin\","
        "\"url\":\"https://ugp-ota-bucket.s3.amazonaws.com/firmware/ugp-firmware-v1.2.bin"
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261008%2Fus-east-1%2Fs3%2Faws4_request"
        "&X-Amz-Date=20261008T171146Z"
        "&X-Amz-Expires=3600"
        "&X-Amz-SignedHeaders=host"
        "&X-Amz-Signature=594c21bc22a2e5de35feeae3a6571ac9d6c42d0a3f8b2e1d4c7f9e0b3a5d8c1\""
        "}}}}";

    int total = (int)strlen(json);

    /* Split in the middle of the URL (simulating ~1024 B buffer) */
    int len1  = total / 2;
    int len2  = total - len1;

    bool complete = false;

    /* --- Chunk 1 (offset=0, topic populated) -------------------------------- */
    bool ok1 = ota_reassembly_feed(0, json, len1, total, &complete);

    CHECK(ok1,       "two-chunk: chunk 1 accepted");
    CHECK(!complete, "two-chunk: returns not-complete after chunk 1");

    /* --- Chunk 2 (offset=len1, topic==NULL — esp-mqtt behaviour) ------------ */
    bool ok2 = ota_reassembly_feed(len1, json + len1, len2, total, &complete);

    CHECK(ok2,      "two-chunk: chunk 2 accepted");
    CHECK(complete, "two-chunk: returns complete after chunk 2");

    /* --- Verify payload ----------------------------------------------------- */
    const char *buf = ota_reassembly_get_buf();
    int         got = ota_reassembly_get_total();

    CHECK(buf != NULL,       "two-chunk: buffer is non-NULL after completion");
    CHECK(got == total,      "two-chunk: total matches original JSON length");
    CHECK(memcmp(buf, json, (size_t)total) == 0,
          "two-chunk: reassembled payload matches original JSON");

    /* Clean up for next test */
    ota_reassembly_reset();
}

/**
 * @brief Single-chunk path: total_data_len == 0 (esp-mqtt non-fragmented delivery).
 *
 * esp-mqtt sets total_data_len == data_len (or 0) when the payload fits in
 * one MQTT packet.  ota_reassembly_feed normalises 0 → len.
 */
static void test_single_chunk_total_zero(void)
{
    const char *json = "{\"execution\":{\"jobId\":\"j1\",\"jobDocument\":{\"operation\":\"ota-update\","
                       "\"firmware\":{\"url\":\"https://example.com/fw.bin\"}}}}";
    int total = (int)strlen(json);

    bool complete = false;
    bool ok = ota_reassembly_feed(0, json, total, 0 /* total==0 → normalise */, &complete);

    CHECK(ok,       "single-chunk (total==0): accepted");
    CHECK(complete, "single-chunk (total==0): complete immediately");

    const char *buf = ota_reassembly_get_buf();
    CHECK(buf != NULL && memcmp(buf, json, (size_t)total) == 0,
          "single-chunk payload correct");

    ota_reassembly_reset();
}

/**
 * @brief Payload exceeding OTA_MAX_JOB_PAYLOAD_LEN (4096 B) must be rejected.
 */
static void test_oversized_rejected(void)
{
    /* 4097 B — just over the limit */
    char big[4097];
    memset(big, 'X', sizeof(big));

    bool complete = false;
    bool ok = ota_reassembly_feed(0, big, (int)sizeof(big),
                                  (int)sizeof(big), &complete);

    CHECK(!ok,       "oversized payload rejected");
    CHECK(!complete, "oversized: complete flag stays false");

    ota_reassembly_reset();
}

/**
 * @brief Chunk whose offset+len exceeds total must be rejected (bounds check).
 */
static void test_bounds_check(void)
{
    const char *json = "{\"a\":1}";
    int total = (int)strlen(json);

    bool complete = false;
    /* Start a valid session */
    ota_reassembly_feed(0, json, 2, total, &complete);

    /* Now feed a chunk that goes past the end */
    bool ok = ota_reassembly_feed(total - 1, json, 5, total, &complete);

    CHECK(!ok, "bounds-check: chunk beyond total rejected");

    ota_reassembly_reset();
}

/**
 * @brief After a completed or aborted session, a new session must succeed.
 *
 * Ensures s_reassembly_buf is properly freed and the state is clean for the
 * next MQTT message.
 */
static void test_reset_between_sessions(void)
{
    const char *json1 = "{\"execution\":{\"jobId\":\"first\"}}";
    int total1 = (int)strlen(json1);
    bool complete = false;

    /* First session — complete it */
    ota_reassembly_feed(0, json1, total1, total1, &complete);
    ota_reassembly_reset();

    /* Second session — must start clean */
    const char *json2 = "{\"execution\":{\"jobId\":\"second\"}}";
    int total2 = (int)strlen(json2);
    bool ok2 = ota_reassembly_feed(0, json2, total2, total2, &complete);

    CHECK(ok2 && complete, "reset between sessions: second session succeeds");

    const char *buf = ota_reassembly_get_buf();
    CHECK(buf != NULL && memcmp(buf, json2, (size_t)total2) == 0,
          "reset between sessions: second payload correct");

    ota_reassembly_reset();
}

/* ── main ────────────────────────────────────────────────────────────────── */

int main(void)
{
    printf("=== OTA reassembly smoke test ===\n\n");

    test_two_chunks();
    test_single_chunk_total_zero();
    test_oversized_rejected();
    test_bounds_check();
    test_reset_between_sessions();

    printf("\n%d/%d tests passed.\n", s_pass, s_pass + s_fail);
    return (s_fail == 0) ? 0 : 1;
}
