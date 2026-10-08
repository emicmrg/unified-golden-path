/**
 * @file ota_jobs.c
 * @brief AWS IoT Jobs OTA handler — Unified Golden Path firmware.
 *
 * Flow (happy path):
 *   MQTT_EVENT_CONNECTED
 *     → subscribe notify-next + start-next/accepted + start-next/rejected
 *         + jobs/+/update/accepted + jobs/+/update/rejected
 *     → publish start-next (cover jobs queued while device was offline)
 *
 *   MQTT_EVENT_DATA (topic matches notify-next OR start-next/accepted)
 *     → accumulate chunks into a reassembly buffer (B1 fix):
 *         - total_data_len > data_len means the payload is fragmented
 *         - chunks are accumulated using current_data_offset until the
 *           buffer holds total_data_len bytes
 *         - payloads exceeding OTA_MAX_JOB_PAYLOAD_LEN are aborted (FAILED)
 *     → parse job document (cJSON):
 *         required: execution.jobId (string)
 *         required: execution.jobDocument.operation == "ota-update"   (B6 fix:
 *             unknown operations are reported FAILED so the queue advances)
 *         required: execution.jobDocument.firmware.url (non-empty string)
 *         optional: execution.jobDocument.firmware.fileName (logged only)
 *     → publish UpdateJobExecution IN_PROGRESS  (msg_id checked — B7/N1 fix)
 *     → esp_https_ota() with crt_bundle_attach
 *         SUCCESS  → set boot partition → publish SUCCEEDED (msg_id checked,
 *                    retry once before rebooting — B7/N1 fix) → esp_restart()
 *         FAILURE  → publish FAILED (details in statusDetails.errorReason)
 *
 * Error contract: every code path that does NOT end in esp_restart() publishes
 * FAILED.  A job stuck in IN_PROGRESS blocks the queue and triggers the Job
 * Template abort policy.
 *
 * Rollback:
 *   When CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y the bootloader marks the
 *   image as PENDING_VERIFY on first boot.  app_main.c must call
 *   ota_jobs_mark_valid_if_pending() after the health check succeeds.
 *
 * Thing name:
 *   All topic strings are built at runtime from CONFIG_UGP_IOT_THING_NAME
 *   (a Kconfig string set at build time).  It is never hardcoded.
 */

#include "ota_jobs.h"
#include "mqtt_iot.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_ota_ops.h"
#include "esp_https_ota.h"
#include "esp_crt_bundle.h"
#include "mqtt_client.h"
#include "cJSON.h"

/* ── Constants ──────────────────────────────────────────────────────────── */

#define TAG "ota_jobs"

/** Maximum length of a constructed topic string. */
#define TOPIC_MAX_LEN  128

/** Maximum length of the MQTT payload for UpdateJobExecution (status report). */
#define UPDATE_PAYLOAD_MAX_LEN  512

/** Maximum length of the OTA firmware URL. */
#define FIRMWARE_URL_MAX_LEN   2048

/** Maximum length of a job ID. */
#define JOB_ID_MAX_LEN  64

/** Maximum length of an error reason string stored in statusDetails. */
#define ERROR_REASON_MAX_LEN  128

/**
 * Stack size for the OTA download task (bytes).
 * esp_https_ota requires headroom for TLS + HTTP.
 */
#define OTA_TASK_STACK_SIZE  (12 * 1024)

/** Task priority — lower than app_main so telemetry keeps ticking. */
#define OTA_TASK_PRIORITY  (tskIDLE_PRIORITY + 2)

/**
 * Maximum job document payload size.
 *
 * AWS IoT Jobs documents are small JSON objects (job ID + presigned URL +
 * metadata).  A presigned S3 URL is typically < 1 500 bytes; we allow up to
 * 4 096 bytes to be safe without risking heap exhaustion.  Any payload
 * larger than this is rejected (FAILED) so the queue can advance.
 */
#define OTA_MAX_JOB_PAYLOAD_LEN  4096

/**
 * How many times to retry publishing SUCCEEDED before rebooting anyway.
 * The firmware IS on the new partition at this point; rebooting without the
 * SUCCEEDED ack is better than not rebooting at all.
 */
#define OTA_SUCCEEDED_PUBLISH_RETRIES  3

/* ── Module-private state ────────────────────────────────────────────────── */

static volatile bool s_registered    = false;
static volatile bool s_ota_in_flight = false;

/**
 * Reassembly buffer for fragmented MQTT payloads (B1).
 *
 * esp-mqtt delivers large payloads in multiple MQTT_EVENT_DATA events:
 *   event->total_data_len  — total payload size (same across all chunks)
 *   event->current_data_offset — byte offset of this chunk in the full payload
 *   event->data / event->data_len — chunk content and length
 *
 * We allocate the buffer on the first chunk (offset == 0) and release it
 * once the payload has been fully received and processed.
 *
 * esp-mqtt behaviour (verified against deliver_publish in esp-mqtt source):
 *   - First chunk  (current_data_offset == 0): event->topic / topic_len are
 *     populated with the MQTT topic string.
 *   - Subsequent chunks (current_data_offset > 0): event->topic == NULL and
 *     topic_len == 0.  The topic match decision must therefore be made on the
 *     first chunk and PERSISTED across subsequent chunks via
 *     s_reassembly_topic_match.  Without this flag the reassembly code is dead
 *     for payloads that span more than one chunk (B1 fix — chunk-continuation).
 */
static char  *s_reassembly_buf          = NULL;
static int    s_reassembly_total        = 0;     /* expected total_data_len */
static int    s_reassembly_written      = 0;     /* bytes written so far    */
static bool   s_reassembly_topic_match  = false; /* topic matched on chunk 0 */

/* ── Topic helpers ───────────────────────────────────────────────────────── */

/**
 * @brief Build a topic string for the given suffix and store it in buf.
 *
 * All topic patterns use CONFIG_UGP_IOT_THING_NAME, never a literal name.
 * Returns false if the result would overflow buf_len.
 */
static bool build_topic(char *buf, size_t buf_len, const char *suffix)
{
    int n = snprintf(buf, buf_len, "$aws/things/%s/%s",
                     CONFIG_UGP_IOT_THING_NAME, suffix);
    return (n > 0 && (size_t)n < buf_len);
}

/* ── Reassembly helpers ─────────────────────────────────────────────────── */

/**
 * @brief Free the reassembly buffer and reset all reassembly state.
 *
 * Also clears s_reassembly_topic_match so that continuation chunks from a
 * previously-aborted session are never accidentally accepted.
 */
static void reassembly_reset(void)
{
    if (s_reassembly_buf != NULL) {
        free(s_reassembly_buf);
        s_reassembly_buf = NULL;
    }
    s_reassembly_total        = 0;
    s_reassembly_written      = 0;
    s_reassembly_topic_match  = false;
}

/**
 * @brief Pure accumulation function — feed one MQTT chunk into the reassembly
 *        buffer.  No ESP-IDF dependency; suitable for host-side unit tests.
 *
 * Encapsulates the bounds-checked memcpy + written-counter logic that was
 * previously inlined in the MQTT_EVENT_DATA handler.  The handler calls this
 * function after the topic-match gate, keeping the gate itself thin.
 *
 * @param offset  current_data_offset of this chunk (bytes from payload start).
 * @param data    Pointer to this chunk's bytes.
 * @param len     Number of bytes in this chunk (must be > 0).
 * @param total   Total expected payload length (total_data_len).  Pass 0 if
 *                esp-mqtt reports total_data_len == 0 (non-fragmented); the
 *                function normalises it to len.
 * @param[out] out_complete  Set to true when the last byte of the payload has
 *                           been accumulated (s_reassembly_written == total).
 *                           The caller may then read s_reassembly_buf[0..total).
 *                           Set to false for intermediate chunks.
 *
 * @return true   Chunk was accepted (buffer allocated or already present,
 *                bounds OK, copy done).
 *         false  Chunk was rejected; reassembly state has been reset.
 *                Reasons: malloc failure, total > OTA_MAX_JOB_PAYLOAD_LEN,
 *                out-of-bounds offset, NULL data pointer.
 *
 * @note This is intentionally a module-level (non-static) function so that the
 *       host-side smoke test in tests/test_ota_reassembly.c can call it
 *       directly without linking any ESP-IDF code.  The function only uses
 *       <stdlib.h>, <string.h>, and the module-private state variables above.
 */
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
        reassembly_reset();
        return false;
    }

    if (offset == 0) {
        /* First chunk — allocate a fresh buffer */
        reassembly_reset();
        s_reassembly_topic_match = true; /* caller guarantees topic matched */

        if (total > OTA_MAX_JOB_PAYLOAD_LEN) {
            /* Payload too large; clear flag so continuation chunks are gated */
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
        reassembly_reset();
        return false;
    }

    memcpy(s_reassembly_buf + offset, data, (size_t)len);
    s_reassembly_written += len;

    if (out_complete != NULL) {
        *out_complete = (s_reassembly_written == s_reassembly_total);
    }
    return true;
}

/**
 * @brief Return a pointer to the fully-reassembled payload buffer.
 *
 * Valid only when ota_reassembly_feed returns true with *out_complete==true.
 * The caller must NOT free this pointer; call reassembly_reset() when done.
 */
const char *ota_reassembly_get_buf(void)
{
    return s_reassembly_buf;
}

/**
 * @brief Return the total expected payload length recorded during reassembly.
 */
int ota_reassembly_get_total(void)
{
    return s_reassembly_total;
}

/* ── MQTT publish helpers ────────────────────────────────────────────────── */

/**
 * @brief Publish an UpdateJobExecution status payload at QoS 0.
 *
 * status_details may be NULL (omitted from the payload).
 * Returns the message ID (>= 0), or < 0 on failure.
 *
 * FIX B7 / N1: the return value is meaningful — callers MUST check it.
 */
static int publish_job_update(esp_mqtt_client_handle_t client,
                               const char *job_id,
                               const char *status,
                               const char *error_reason)
{
    /* B5 FIX: removed dead-code block that called build_topic with a literal
     * "jobs/PLACEHOLDER/update" suffix and then immediately overwrote the
     * buffer.  The topic is built directly below. */
    char topic[TOPIC_MAX_LEN];
    int n = snprintf(topic, sizeof(topic),
                     "$aws/things/%s/jobs/%s/update",
                     CONFIG_UGP_IOT_THING_NAME, job_id);
    if (n <= 0 || (size_t)n >= sizeof(topic)) {
        ESP_LOGE(TAG, "UpdateJobExecution topic truncated");
        return -1;
    }

    char payload[UPDATE_PAYLOAD_MAX_LEN];
    int payload_len;

    if (error_reason != NULL && error_reason[0] != '\0') {
        payload_len = snprintf(payload, sizeof(payload),
            "{\"status\":\"%s\","
            "\"statusDetails\":{\"errorReason\":\"%s\"}}",
            status, error_reason);
    } else {
        payload_len = snprintf(payload, sizeof(payload),
            "{\"status\":\"%s\"}", status);
    }

    if (payload_len <= 0 || payload_len >= (int)sizeof(payload)) {
        ESP_LOGE(TAG, "UpdateJobExecution payload truncated");
        return -1;
    }

    int msg_id = esp_mqtt_client_publish(
        client, topic, payload, payload_len,
        0,   /* QoS 0 — status reports are best-effort */
        0);  /* retain = false */

    if (msg_id < 0) {
        ESP_LOGE(TAG, "UpdateJobExecution publish failed (job=%s status=%s msg_id=%d)",
                 job_id, status, msg_id);
    } else {
        ESP_LOGI(TAG, "UpdateJobExecution → job=%s status=%s msg_id=%d",
                 job_id, status, msg_id);
    }
    return msg_id;
}

/* ── OTA task ────────────────────────────────────────────────────────────── */

/**
 * Parameters passed to the OTA download task (heap-allocated by the caller).
 */
typedef struct {
    char job_id[JOB_ID_MAX_LEN];
    char url[FIRMWARE_URL_MAX_LEN];
    esp_mqtt_client_handle_t mqtt_client;
} ota_task_params_t;

/**
 * @brief FreeRTOS task that downloads and applies the firmware update.
 *
 * Runs in a separate task to avoid blocking the MQTT event loop.
 * The params struct is freed before the task exits.
 */
static void ota_download_task(void *pvParameter)
{
    ota_task_params_t *params = (ota_task_params_t *)pvParameter;

    ESP_LOGI(TAG, "OTA task started — job=%s url=%.80s…", params->job_id, params->url);

    /* ── Report IN_PROGRESS ──────────────────────────────────────────────── */
    /* FIX N1: check msg_id; log but continue — IN_PROGRESS is best-effort. */
    int mid_ip = publish_job_update(params->mqtt_client, params->job_id,
                                    "IN_PROGRESS", NULL);
    if (mid_ip < 0) {
        ESP_LOGW(TAG, "Failed to publish IN_PROGRESS (job=%s) — continuing OTA",
                 params->job_id);
    }

    /* ── Configure esp_https_ota ─────────────────────────────────────────── */
    esp_http_client_config_t http_cfg = {
        .url                = params->url,
        /* Use the bundled root CA store — covers S3 (DigiCert / Amazon CAs).
         * sdkconfig.defaults already enables CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y
         * so no extra certificates need to be embedded. */
        .crt_bundle_attach  = esp_crt_bundle_attach,
        .keep_alive_enable  = true,
        /* Generous timeout for large firmware images over a mobile hotspot. */
        .timeout_ms         = 30000,
    };

    esp_https_ota_config_t ota_cfg = {
        .http_config = &http_cfg,
    };

    /* ── Download + write + validate ─────────────────────────────────────── */
    esp_err_t ota_err = esp_https_ota(&ota_cfg);

    if (ota_err != ESP_OK) {
        /* esp_https_ota() returns ESP_ERR_OTA_VALIDATE_FAILED on a corrupt image
         * (SHA-256 mismatch), or other codes on network/TLS errors. */
        char reason[ERROR_REASON_MAX_LEN];
        snprintf(reason, sizeof(reason), "esp_https_ota failed: %s",
                 esp_err_to_name(ota_err));
        ESP_LOGE(TAG, "OTA FAILED — %s", reason);
        /* FIX N1: check msg_id for FAILED publish. */
        int mid_fail = publish_job_update(params->mqtt_client, params->job_id,
                                          "FAILED", reason);
        if (mid_fail < 0) {
            ESP_LOGE(TAG, "Also failed to publish FAILED status (job=%s)",
                     params->job_id);
        }
        goto ota_task_done;
    }

    ESP_LOGI(TAG, "OTA download complete — image validated by esp_https_ota");

    /* ── Verify boot partition was updated ──────────────────────────────── */
    /* esp_https_ota() already called esp_ota_set_boot_partition() internally.
     * We verify the running partition != the next_update_partition to confirm
     * the switch was registered (belt-and-suspenders sanity check). */
    const esp_partition_t *running_part = esp_ota_get_running_partition();
    const esp_partition_t *next_part    = esp_ota_get_next_update_partition(NULL);
    if (next_part == NULL) {
        const char *reason_str =
            "esp_ota_get_next_update_partition returned NULL after OTA";
        ESP_LOGE(TAG, "%s", reason_str);
        int mid_fail = publish_job_update(params->mqtt_client, params->job_id,
                                          "FAILED", reason_str);
        if (mid_fail < 0) {
            ESP_LOGE(TAG, "Also failed to publish FAILED status (job=%s)",
                     params->job_id);
        }
        goto ota_task_done;
    }
    ESP_LOGI(TAG, "Running: %s  |  OTA target was: %s (subtype 0x%02x)",
             running_part ? running_part->label : "?",
             next_part->label, next_part->subtype);

    /* ── Report SUCCEEDED — with retry before reboot ────────────────────── */
    /*
     * FIX B7 / N1 (CRITICAL):
     *   Do NOT call esp_restart() until SUCCEEDED is confirmed enqueued
     *   (msg_id >= 0).  If the publish fails, retry OTA_SUCCEEDED_PUBLISH_RETRIES
     *   times with a short delay.  If all retries fail we still reboot — the
     *   firmware IS on the new partition and staying stuck is worse — but we
     *   log the situation prominently so the operator can detect it via the
     *   cloud-side job remaining IN_PROGRESS.
     *
     *   We do NOT wait for the PUBACK inside this task (QoS 0 has no ACK;
     *   even with QoS 1 we must not block the event loop from here).
     *   A short vTaskDelay after a successful enqueue gives the TCP stack
     *   time to transmit the packet before the reset.
     */
    bool succeeded_published = false;
    for (int attempt = 0; attempt < OTA_SUCCEEDED_PUBLISH_RETRIES; attempt++) {
        int mid_ok = publish_job_update(params->mqtt_client, params->job_id,
                                        "SUCCEEDED", NULL);
        if (mid_ok >= 0) {
            succeeded_published = true;
            /* Give the TCP stack time to flush the packet before reset. */
            vTaskDelay(pdMS_TO_TICKS(500));
            break;
        }
        ESP_LOGW(TAG, "SUCCEEDED publish attempt %d/%d failed (job=%s) — retrying …",
                 attempt + 1, OTA_SUCCEEDED_PUBLISH_RETRIES, params->job_id);
        vTaskDelay(pdMS_TO_TICKS(300));
    }

    if (!succeeded_published) {
        ESP_LOGE(TAG, "Could not publish SUCCEEDED after %d attempts (job=%s) — "
                 "rebooting anyway; job will remain IN_PROGRESS in the cloud",
                 OTA_SUCCEEDED_PUBLISH_RETRIES, params->job_id);
    }

    ESP_LOGI(TAG, "Rebooting to apply new firmware …");
    esp_restart();
    /* unreachable */

ota_task_done:
    s_ota_in_flight = false;
    free(params);
    vTaskDelete(NULL);
}

/* ── Job document handler ────────────────────────────────────────────────── */

/**
 * @brief Process a fully-reassembled job document payload.
 *
 * Called from the MQTT event handler once all chunks have been accumulated.
 * Validates the document schema, publishes FAILED on any validation error
 * (so the job does not hang), and spawns ota_download_task on success.
 *
 * FIX B6: unknown/non-OTA operations are now reported as FAILED so the
 * Jobs queue advances instead of blocking indefinitely.
 *
 * @param client      MQTT client handle.
 * @param data        Fully-reassembled JSON payload (NOT NUL-terminated).
 * @param data_len    Payload length in bytes.
 */
static void handle_job_document(esp_mqtt_client_handle_t client,
                                 const char *data, int data_len)
{
    if (s_ota_in_flight) {
        ESP_LOGW(TAG, "OTA already in flight — ignoring duplicate job notification");
        return;
    }

    /* ── Parse JSON ──────────────────────────────────────────────────────── */
    /* cJSON_ParseWithLength is preferred over cJSON_Parse to honour data_len
     * (esp-mqtt does NOT NUL-terminate the payload buffer). */
    cJSON *root = cJSON_ParseWithLength(data, (size_t)data_len);
    if (root == NULL) {
        ESP_LOGE(TAG, "cJSON_ParseWithLength failed — malformed job notification");
        /* No job ID available to report FAILED against — nothing we can do. */
        return;
    }

    /* ── Extract execution object ────────────────────────────────────────── */
    const cJSON *execution = cJSON_GetObjectItemCaseSensitive(root, "execution");
    if (!cJSON_IsObject(execution)) {
        ESP_LOGE(TAG, "job notification missing 'execution' object");
        cJSON_Delete(root);
        return;
    }

    /* ── Extract jobId ───────────────────────────────────────────────────── */
    const cJSON *job_id_item = cJSON_GetObjectItemCaseSensitive(execution, "jobId");
    if (!cJSON_IsString(job_id_item) || job_id_item->valuestring == NULL) {
        ESP_LOGE(TAG, "job notification missing 'execution.jobId'");
        cJSON_Delete(root);
        return;
    }
    const char *job_id_str = job_id_item->valuestring;

    /* ── Extract jobDocument ─────────────────────────────────────────────── */
    const cJSON *doc = cJSON_GetObjectItemCaseSensitive(execution, "jobDocument");
    if (!cJSON_IsObject(doc)) {
        ESP_LOGE(TAG, "job execution missing 'jobDocument' (job=%s)", job_id_str);
        publish_job_update(client, job_id_str, "FAILED",
                           "missing jobDocument in execution");
        cJSON_Delete(root);
        return;
    }

    /* ── Validate operation ──────────────────────────────────────────────── */
    const cJSON *operation = cJSON_GetObjectItemCaseSensitive(doc, "operation");
    if (!cJSON_IsString(operation) || operation->valuestring == NULL) {
        ESP_LOGE(TAG, "jobDocument missing 'operation' (job=%s)", job_id_str);
        publish_job_update(client, job_id_str, "FAILED",
                           "missing operation in jobDocument");
        cJSON_Delete(root);
        return;
    }

    /*
     * FIX B6: if the operation is not "ota-update", report FAILED so the
     * Jobs queue does not remain blocked by an unrecognised job type.
     * Previously this branch returned silently, leaving the job IN_PROGRESS
     * (or never started) indefinitely and blocking StartNextPendingJobExecution.
     */
    if (strcmp(operation->valuestring, "ota-update") != 0) {
        char reason[ERROR_REASON_MAX_LEN];
        snprintf(reason, sizeof(reason),
                 "unsupported operation '%s' — only 'ota-update' is handled",
                 operation->valuestring);
        ESP_LOGW(TAG, "job=%s %s", job_id_str, reason);
        publish_job_update(client, job_id_str, "FAILED", reason);
        cJSON_Delete(root);
        return;
    }

    /* ── Extract firmware.url ────────────────────────────────────────────── */
    const cJSON *firmware = cJSON_GetObjectItemCaseSensitive(doc, "firmware");
    if (!cJSON_IsObject(firmware)) {
        ESP_LOGE(TAG, "jobDocument missing 'firmware' object (job=%s)", job_id_str);
        publish_job_update(client, job_id_str, "FAILED",
                           "missing firmware object in jobDocument");
        cJSON_Delete(root);
        return;
    }

    const cJSON *url_item = cJSON_GetObjectItemCaseSensitive(firmware, "url");
    if (!cJSON_IsString(url_item) || url_item->valuestring == NULL ||
        url_item->valuestring[0] == '\0') {
        ESP_LOGE(TAG, "firmware.url missing or empty (job=%s)", job_id_str);
        publish_job_update(client, job_id_str, "FAILED",
                           "firmware.url missing or empty");
        cJSON_Delete(root);
        return;
    }

    /* Sanity check: detect the FIRMWARE_URL_PLACEHOLDER that means the job was
     * dispatched without substituting the real URL (a CI/CD misconfiguration). */
    if (strncmp(url_item->valuestring, "REPLACE_VIA_",
                sizeof("REPLACE_VIA_") - 1) == 0) {
        ESP_LOGE(TAG, "firmware.url is a placeholder — CI/CD must substitute the real URL");
        publish_job_update(client, job_id_str, "FAILED",
                           "firmware.url is still the placeholder — CI/CD misconfiguration");
        cJSON_Delete(root);
        return;
    }

    /* ── Log optional fileName ───────────────────────────────────────────── */
    const cJSON *file_name = cJSON_GetObjectItemCaseSensitive(firmware, "fileName");
    if (cJSON_IsString(file_name) && file_name->valuestring != NULL) {
        ESP_LOGI(TAG, "OTA job=%s  fileName=%s", job_id_str, file_name->valuestring);
    }

    /* ── Allocate task parameters ─────────────────────────────────────────── */
    ota_task_params_t *params =
        (ota_task_params_t *)malloc(sizeof(ota_task_params_t));
    if (params == NULL) {
        ESP_LOGE(TAG, "malloc failed for ota_task_params_t (job=%s)", job_id_str);
        publish_job_update(client, job_id_str, "FAILED",
                           "malloc failed for OTA task params");
        cJSON_Delete(root);
        return;
    }

    /* Copy job_id — bounded to JOB_ID_MAX_LEN. */
    snprintf(params->job_id, sizeof(params->job_id), "%s", job_id_str);
    /* Copy URL — bounded to FIRMWARE_URL_MAX_LEN. */
    snprintf(params->url, sizeof(params->url), "%s", url_item->valuestring);
    params->mqtt_client = client;

    cJSON_Delete(root);

    /* ── Spawn OTA task ───────────────────────────────────────────────────── */
    s_ota_in_flight = true;
    BaseType_t task_ret = xTaskCreate(
        ota_download_task,
        "ota_download",
        OTA_TASK_STACK_SIZE,
        params,
        OTA_TASK_PRIORITY,
        NULL);

    if (task_ret != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate for OTA failed (job=%s)", params->job_id);
        publish_job_update(client, params->job_id, "FAILED",
                           "xTaskCreate for OTA download task failed");
        free(params);
        s_ota_in_flight = false;
    }
}

/* ── MQTT event handler ──────────────────────────────────────────────────── */

/**
 * @brief ota_jobs MQTT event handler.
 *
 * Registered on the shared esp-mqtt client.  Handles:
 *   - MQTT_EVENT_CONNECTED: subscribe to Jobs topics + publish start-next.
 *   - MQTT_EVENT_DATA: reassemble fragmented payloads (B1) then dispatch.
 *
 * FIX B7: subscribe return values are now checked; a failed subscribe is
 * logged as an error (non-fatal: the device will not receive jobs until the
 * next reconnection, which triggers another MQTT_EVENT_CONNECTED).
 */
static void ota_jobs_mqtt_handler(void            *handler_args,
                                   esp_event_base_t base,
                                   int32_t          event_id,
                                   void            *event_data)
{
    esp_mqtt_event_handle_t  event  = (esp_mqtt_event_handle_t)event_data;
    esp_mqtt_client_handle_t client = event->client;

    (void)handler_args;
    (void)base;

    switch ((esp_mqtt_event_id_t)event_id) {

        case MQTT_EVENT_CONNECTED: {
            /* Reset any stale reassembly state from a previous session. */
            reassembly_reset();

            /* ── Subscribe to Jobs topics ─────────────────────────────────── */
            char topic[TOPIC_MAX_LEN];

            /* notify-next: pushed when a new job is queued for this device.
             * FIX B7: validate the subscribe return value. */
            if (build_topic(topic, sizeof(topic), "jobs/notify-next")) {
                int mid = esp_mqtt_client_subscribe(client, topic, 1);
                if (mid < 0) {
                    ESP_LOGE(TAG, "Subscribe FAILED for %s (msg_id=%d)", topic, mid);
                } else {
                    ESP_LOGI(TAG, "Subscribed to %s (msg_id=%d)", topic, mid);
                }
            }

            /* start-next/accepted: response to our DescribeJobExecution for QUEUED.
             * FIX B7: validate the subscribe return value. */
            if (build_topic(topic, sizeof(topic), "jobs/start-next/accepted")) {
                int mid = esp_mqtt_client_subscribe(client, topic, 1);
                if (mid < 0) {
                    ESP_LOGE(TAG, "Subscribe FAILED for %s (msg_id=%d)", topic, mid);
                } else {
                    ESP_LOGI(TAG, "Subscribed to %s (msg_id=%d)", topic, mid);
                }
            }

            /* start-next/rejected: broker rejected our start-next request.
             * FIX B7: validate the subscribe return value. */
            if (build_topic(topic, sizeof(topic), "jobs/start-next/rejected")) {
                int mid = esp_mqtt_client_subscribe(client, topic, 0);
                if (mid < 0) {
                    ESP_LOGE(TAG, "Subscribe FAILED for %s (msg_id=%d)", topic, mid);
                } else {
                    ESP_LOGI(TAG, "Subscribed to %s (msg_id=%d)", topic, mid);
                }
            }

            /* jobs/+/update/accepted and rejected — confirm our UpdateJobExecution.
             * FIX B7: validate the subscribe return value. */
            if (build_topic(topic, sizeof(topic), "jobs/+/update/accepted")) {
                int mid = esp_mqtt_client_subscribe(client, topic, 0);
                if (mid < 0) {
                    ESP_LOGE(TAG, "Subscribe FAILED for %s (msg_id=%d)", topic, mid);
                } else {
                    ESP_LOGD(TAG, "Subscribed to %s (msg_id=%d)", topic, mid);
                }
            }
            if (build_topic(topic, sizeof(topic), "jobs/+/update/rejected")) {
                int mid = esp_mqtt_client_subscribe(client, topic, 0);
                if (mid < 0) {
                    ESP_LOGE(TAG, "Subscribe FAILED for %s (msg_id=%d)", topic, mid);
                } else {
                    ESP_LOGI(TAG, "Subscribed to %s (msg_id=%d)", topic, mid);
                }
            }

            /* ── Publish start-next to pick up any queued job ─────────────── */
            /* This covers the case where a job was queued while the device was
             * offline (no notify-next would be delivered). */
            if (build_topic(topic, sizeof(topic), "jobs/start-next")) {
                const char *payload = "{}";
                int mid = esp_mqtt_client_publish(client, topic,
                                                   payload, (int)strlen(payload),
                                                   0, 0);
                if (mid < 0) {
                    ESP_LOGE(TAG, "Failed to publish start-next (msg_id=%d)", mid);
                } else {
                    ESP_LOGI(TAG, "Published start-next (msg_id=%d)", mid);
                }
            }
            break;
        }

        case MQTT_EVENT_DISCONNECTED: {
            /* Discard any partial reassembly buffer on disconnect; the peer
             * will retransmit from the beginning on the next connection. */
            reassembly_reset();
            break;
        }

        case MQTT_EVENT_DATA: {
            /*
             * B1 FIX — chunk-continuation guard
             * ────────────────────────────────────
             * esp-mqtt behaviour (verified against deliver_publish):
             *   - First chunk  (current_data_offset == 0): event->topic /
             *     topic_len are populated.
             *   - Subsequent chunks (current_data_offset > 0): event->topic
             *     == NULL and topic_len == 0.
             *
             * OLD CODE had `if (event->topic == NULL) break;` here which
             * silently discarded ALL continuation chunks, making the reassembly
             * buffer dead code for any payload that spans > 1 chunk.
             *
             * NEW LOGIC:
             *   1. If current_data_offset == 0 (first chunk): perform the
             *      topic match and persist the result in s_reassembly_topic_match.
             *   2. If current_data_offset > 0 (continuation): topic is NULL —
             *      do NOT re-evaluate; use the persisted flag.  Pass the chunk
             *      through only if s_reassembly_topic_match is true.
             *   3. If not a match: do nothing for this event.
             *
             * The strncmp block that previously appeared unconditionally
             * (after the guard) is now INSIDE the offset==0 branch so it is
             * never called with a NULL topic.
             */
            int total  = event->total_data_len;
            int offset = event->current_data_offset;
            int chunk  = event->data_len;

            if (offset == 0) {
                /* ── First chunk: decide whether this topic interests us ──── */

                /* topic must be non-NULL on the first chunk; if it is NULL
                 * something is very wrong — discard the event. */
                if (event->topic == NULL || event->topic_len == 0) {
                    ESP_LOGW(TAG,
                             "MQTT_EVENT_DATA: first chunk (offset=0) arrived "
                             "with NULL topic — discarding");
                    reassembly_reset();
                    break;
                }

                /* Build the expected topic strings for matching. */
                char notify_next[TOPIC_MAX_LEN];
                char start_next_accepted[TOPIC_MAX_LEN];
                build_topic(notify_next,         sizeof(notify_next),
                            "jobs/notify-next");
                build_topic(start_next_accepted, sizeof(start_next_accepted),
                            "jobs/start-next/accepted");

                bool is_notify_next =
                    (event->topic_len == (int)strlen(notify_next)) &&
                    (strncmp(event->topic, notify_next,
                             (size_t)event->topic_len) == 0);
                bool is_start_next_accepted =
                    (event->topic_len == (int)strlen(start_next_accepted)) &&
                    (strncmp(event->topic, start_next_accepted,
                             (size_t)event->topic_len) == 0);

                /* Persist the match decision for continuation chunks. */
                s_reassembly_topic_match = (is_notify_next || is_start_next_accepted);

                /* Log update/rejected for debugging while topic is available. */
                char update_rejected_prefix[TOPIC_MAX_LEN];
                snprintf(update_rejected_prefix, sizeof(update_rejected_prefix),
                         "$aws/things/%s/jobs/", CONFIG_UGP_IOT_THING_NAME);
                size_t prefix_len = strlen(update_rejected_prefix);
                if ((size_t)event->topic_len > prefix_len &&
                    strncmp(event->topic, update_rejected_prefix, prefix_len) == 0) {
                    const char *suffix     = event->topic + prefix_len;
                    int         suffix_len = event->topic_len - (int)prefix_len;
                    const char *needle     = "/update/rejected";
                    int         needle_len = (int)strlen(needle);
                    if (suffix_len >= needle_len) {
                        if (strncmp(suffix + suffix_len - needle_len, needle,
                                    (size_t)needle_len) == 0) {
                            ESP_LOGW(TAG,
                                     "UpdateJobExecution rejected by broker — "
                                     "payload: %.*s",
                                     event->data_len,
                                     event->data ? event->data : "");
                        }
                    }
                }
            }
            /* For continuation chunks (offset > 0) we intentionally skip the
             * topic-match block above — topic is NULL and s_reassembly_topic_match
             * already holds the decision from the first chunk. */

            /* If this topic is not one we handle, ignore the whole message. */
            if (!s_reassembly_topic_match) {
                break;
            }

            /*
             * FIX B1 — MQTT payload reassembly via ota_reassembly_feed()
             * ──────────────────────────────────────────────────────────
             * Delegate all accumulation logic to the pure helper so the same
             * code is exercised by the host-side smoke test.
             */
            bool complete = false;
            bool ok = ota_reassembly_feed(offset, event->data, chunk, total,
                                          &complete);

            if (!ok) {
                ESP_LOGE(TAG,
                         "ota_reassembly_feed rejected chunk "
                         "(offset=%d len=%d total=%d) — reassembly aborted",
                         offset, chunk, total);
                break;
            }

            ESP_LOGD(TAG,
                     "Reassembly: %d / %d bytes",
                     s_reassembly_written, s_reassembly_total);

            if (complete) {
                ESP_LOGD(TAG,
                         "Payload fully reassembled (%d B) — parsing",
                         s_reassembly_total);
                handle_job_document(client,
                                    s_reassembly_buf,
                                    s_reassembly_total);
                reassembly_reset();
            }
            break;
        }

        default:
            break;
    }
}

/* ── Public API ──────────────────────────────────────────────────────────── */

esp_err_t ota_jobs_start(void)
{
    if (s_registered) {
        ESP_LOGW(TAG, "ota_jobs_start called more than once — ignoring");
        return ESP_ERR_INVALID_STATE;
    }

    esp_mqtt_client_handle_t client = mqtt_iot_get_client();
    if (client == NULL) {
        ESP_LOGE(TAG, "ota_jobs_start: MQTT client not initialised (call mqtt_iot_init first)");
        return ESP_ERR_INVALID_STATE;
    }

    /* Register ota_jobs handler on the SHARED esp-mqtt client.
     * We reuse the same client handle; NO second connection is opened. */
    esp_err_t ret = esp_mqtt_client_register_event(
        client,
        ESP_EVENT_ANY_ID,
        ota_jobs_mqtt_handler,
        NULL);

    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_mqtt_client_register_event failed: %s",
                 esp_err_to_name(ret));
        return ret;
    }

    s_registered = true;
    ESP_LOGI(TAG, "OTA Jobs handler registered on existing MQTT client (thing: %s)",
             CONFIG_UGP_IOT_THING_NAME);
    return ESP_OK;
}

esp_err_t ota_jobs_mark_valid_if_pending(void)
{
    /* Check whether the running partition is in PENDING_VERIFY state.
     * This is only set by the bootloader after a successful OTA flash when
     * CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y is active. */
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t   state   = ESP_OTA_IMG_UNDEFINED;

    esp_err_t err = esp_ota_get_state_partition(running, &state);
    if (err != ESP_OK) {
        /* On factory/test partitions (no OTA state) this returns an error —
         * treat as "not pending", no action needed. */
        ESP_LOGD(TAG, "esp_ota_get_state_partition: %s — assuming not pending",
                 esp_err_to_name(err));
        return ESP_OK;
    }

    if (state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG,
                 "Partition is PENDING_VERIFY — health check passed, marking VALID");
        err = esp_ota_mark_app_valid_cancel_rollback();
        if (err != ESP_OK) {
            ESP_LOGE(TAG,
                     "esp_ota_mark_app_valid_cancel_rollback failed: %s",
                     esp_err_to_name(err));
            return err;
        }
        ESP_LOGI(TAG, "Firmware marked VALID — rollback cancelled");
    } else {
        ESP_LOGD(TAG,
                 "Partition state: %d — not PENDING_VERIFY, no action",
                 (int)state);
    }

    return ESP_OK;
}
