/**
 * @file mqtt_iot.c
 * @brief AWS IoT Core MQTT client over mutual TLS.
 *
 * Uses the esp-mqtt component (built-in to ESP-IDF 5.x) with esp-tls for
 * the TLS transport.  All three PEM artifacts are embedded into the
 * firmware binary via CMakeLists.txt EMBED_TXTFILES.
 *
 * Telemetry JSON shape (matches TelemetryMessage in types.ts):
 *   { "deviceId": "...", "temperatureCelsius": x.xx,
 *     "humidityPercent": y.yy, "timestamp": "ISO-8601" }
 *
 * The MQTT clientId is CONFIG_UGP_IOT_THING_NAME ("ugp-gateway-01").
 * The IoT policy enforces clientId == ThingName, so this value must
 * not be changed without re-provisioning the policy.
 */

#include "mqtt_iot.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_log.h"
#include "esp_err.h"
#include "mqtt_client.h"  /* ESP-IDF built-in esp-mqtt */

/* ── Embedded certificate symbols ──────────────────────────────────────────
 *
 * ESP-IDF generates these symbols from EMBED_TXTFILES.
 * Naming rule: path separators (/) and dots (.) become underscores (_).
 *
 *   certs/device.crt.pem  →  _binary_device_crt_pem_start / _end
 *   certs/device.key.pem  →  _binary_device_key_pem_start / _end
 *   certs/AmazonRootCA1.pem → _binary_AmazonRootCA1_pem_start / _end
 */
extern const uint8_t device_crt_pem_start[]    asm("_binary_device_crt_pem_start");
extern const uint8_t device_crt_pem_end[]      asm("_binary_device_crt_pem_end");
extern const uint8_t device_key_pem_start[]    asm("_binary_device_key_pem_start");
extern const uint8_t device_key_pem_end[]      asm("_binary_device_key_pem_end");
extern const uint8_t AmazonRootCA1_pem_start[] asm("_binary_AmazonRootCA1_pem_start");
extern const uint8_t AmazonRootCA1_pem_end[]   asm("_binary_AmazonRootCA1_pem_end");

/* ── Constants ──────────────────────────────────────────────────────────── */

#define TAG "mqtt_iot"

/** Maximum length of the broker URI (mqtts://hostname:8883\0). */
#define BROKER_URI_MAX_LEN  128

/** Maximum length of the serialised JSON telemetry payload. */
#define TELEMETRY_JSON_MAX_LEN  256

/** Timestamp buffer size for ISO-8601 string (29 chars + NUL). */
#define TIMESTAMP_BUF_LEN  32

/* ── Module-private state ───────────────────────────────────────────────── */

static esp_mqtt_client_handle_t s_mqtt_client = NULL;
static volatile bool            s_mqtt_connected = false;

/* ── Helpers ────────────────────────────────────────────────────────────── */

/**
 * @brief Writes an ISO-8601 UTC timestamp into @p buf.
 *
 * Falls back to "1970-01-01T00:00:00.000Z" if the system clock is not set.
 * The ESP32 RTC is not battery-backed; you would normally sync via SNTP.
 * For a demo the timestamp still matches the wire format expected by the
 * dashboard (TelemetryMessage.timestamp: string // ISO 8601).
 */
static void get_iso8601_timestamp(char *buf, size_t buf_len)
{
    time_t now = time(NULL);
    struct tm timeinfo;
    gmtime_r(&now, &timeinfo);
    /* ISO-8601 with milliseconds zeroed (no sub-second RTC on ESP32). */
    strftime(buf, buf_len, "%Y-%m-%dT%H:%M:%S.000Z", &timeinfo);
}

/* ── MQTT event handler ─────────────────────────────────────────────────── */

static void mqtt_event_handler(void            *handler_args,
                                esp_event_base_t base,
                                int32_t          event_id,
                                void            *event_data)
{
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    (void)handler_args;
    (void)base;

    switch ((esp_mqtt_event_id_t)event_id) {

        case MQTT_EVENT_CONNECTED:
            ESP_LOGI(TAG, "MQTT connected to %s (clientId: %s)",
                     CONFIG_UGP_IOT_ENDPOINT, CONFIG_UGP_IOT_THING_NAME);
            s_mqtt_connected = true;
            break;

        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "MQTT disconnected — will reconnect automatically");
            s_mqtt_connected = false;
            break;

        case MQTT_EVENT_PUBLISHED:
            ESP_LOGD(TAG, "MQTT publish confirmed (msg_id=%d)", event->msg_id);
            break;

        case MQTT_EVENT_ERROR:
            s_mqtt_connected = false;
            if (event->error_handle) {
                if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
                    ESP_LOGE(TAG, "MQTT transport error — TLS esp-tls err=0x%x  "
                             "mbedtls last err=0x%x",
                             event->error_handle->esp_tls_last_esp_err,
                             event->error_handle->esp_tls_stack_err);
                } else {
                    ESP_LOGE(TAG, "MQTT error type=%d",
                             event->error_handle->error_type);
                }
            }
            break;

        default:
            ESP_LOGD(TAG, "MQTT event id=%d (unhandled)", (int)event_id);
            break;
    }
}

/* ── Public API ─────────────────────────────────────────────────────────── */

esp_err_t mqtt_iot_init(void)
{
    /* Build the broker URI: mqtts://<endpoint>:<port> */
    char broker_uri[BROKER_URI_MAX_LEN];
    snprintf(broker_uri, sizeof(broker_uri),
             "mqtts://%s:%d",
             CONFIG_UGP_IOT_ENDPOINT,
             CONFIG_UGP_MQTT_PORT);

    /* Compute PEM lengths (embedded files include the NUL terminator added
     * by EMBED_TXTFILES, so we pass (end - start) which includes it). */
    size_t ca_cert_len   = (size_t)(AmazonRootCA1_pem_end - AmazonRootCA1_pem_start);
    size_t client_cert_len = (size_t)(device_crt_pem_end - device_crt_pem_start);
    size_t client_key_len  = (size_t)(device_key_pem_end - device_key_pem_start);

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address = {
                .uri = broker_uri,
            },
            .verification = {
                /* Amazon Root CA 1 — trust anchor for the AWS IoT ATS endpoint */
                .certificate     = (const char *)AmazonRootCA1_pem_start,
                .certificate_len = ca_cert_len,
            },
        },
        .credentials = {
            /* clientId MUST equal the Thing name to satisfy the IoT policy:
             *   iot:Connect  when ClientId == ${iot:Connection.ThingName}  */
            .client_id = CONFIG_UGP_IOT_THING_NAME,
            .authentication = {
                /* Device certificate (x.509) */
                .certificate     = (const char *)device_crt_pem_start,
                .certificate_len = client_cert_len,
                /* Device private key */
                .key             = (const char *)device_key_pem_start,
                .key_len         = client_key_len,
            },
        },
        .session = {
            /* Clean session: no persistent subscriptions on the broker. */
            .keepalive        = 60,
            .disable_keepalive = false,
        },
        .network = {
            /* Reconnect automatically after disconnection. */
            .reconnect_timeout_ms  = 5000,
            .timeout_ms            = 10000,
        },
    };

    ESP_LOGI(TAG, "Initialising MQTT client → %s (clientId: %s)",
             broker_uri, CONFIG_UGP_IOT_THING_NAME);

    s_mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    if (s_mqtt_client == NULL) {
        ESP_LOGE(TAG, "esp_mqtt_client_init returned NULL — check config");
        return ESP_FAIL;
    }

    /* Register the event handler for all MQTT events. */
    esp_err_t ret = esp_mqtt_client_register_event(
        s_mqtt_client,
        ESP_EVENT_ANY_ID,
        mqtt_event_handler,
        NULL);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_mqtt_client_register_event failed: %s",
                 esp_err_to_name(ret));
        return ret;
    }

    return ESP_OK;
}

esp_err_t mqtt_iot_start(void)
{
    if (s_mqtt_client == NULL) {
        ESP_LOGE(TAG, "mqtt_iot_start called before mqtt_iot_init");
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t ret = esp_mqtt_client_start(s_mqtt_client);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_mqtt_client_start failed: %s", esp_err_to_name(ret));
    } else {
        ESP_LOGI(TAG, "MQTT client started — connecting to broker …");
    }
    return ret;
}

void mqtt_iot_publish_telemetry(float temp_c, float humidity_pct)
{
    if (!s_mqtt_connected) {
        /* Not yet connected — log locally and skip publish.
         * The sampling loop continues, data is not lost (simulated). */
        ESP_LOGD(TAG, "MQTT not connected — skipping publish "
                 "(T=%.2f°C H=%.1f%%)", temp_c, humidity_pct);
        return;
    }

    /* Build ISO-8601 timestamp. */
    char timestamp[TIMESTAMP_BUF_LEN];
    get_iso8601_timestamp(timestamp, sizeof(timestamp));

    /*
     * JSON payload — matches TelemetryMessage in web-dashboard/src/types.ts:
     *   {
     *     "deviceId":           "ugp-gateway-01",
     *     "temperatureCelsius": 4.32,
     *     "humidityPercent":    46.10,
     *     "timestamp":          "2026-10-07T20:54:43.000Z"
     *   }
     *
     * Field names are case-sensitive and must match exactly.
     */
    char payload[TELEMETRY_JSON_MAX_LEN];
    int  payload_len = snprintf(payload, sizeof(payload),
        "{"
        "\"deviceId\":\"%s\","
        "\"temperatureCelsius\":%.2f,"
        "\"humidityPercent\":%.2f,"
        "\"timestamp\":\"%s\""
        "}",
        CONFIG_UGP_IOT_THING_NAME,
        (double)temp_c,
        (double)humidity_pct,
        timestamp);

    if (payload_len <= 0 || payload_len >= (int)sizeof(payload)) {
        ESP_LOGE(TAG, "JSON payload truncated or encoding error");
        return;
    }

    int msg_id = esp_mqtt_client_publish(
        s_mqtt_client,
        CONFIG_UGP_TELEMETRY_TOPIC,
        payload,
        payload_len,
        1,     /* QoS 1 — at-least-once delivery */
        0);    /* retain = false */

    if (msg_id < 0) {
        ESP_LOGE(TAG, "esp_mqtt_client_publish failed (msg_id=%d)", msg_id);
    } else {
        ESP_LOGI(TAG, "Published to %s  msg_id=%d  payload=%s",
                 CONFIG_UGP_TELEMETRY_TOPIC, msg_id, payload);
    }
}
