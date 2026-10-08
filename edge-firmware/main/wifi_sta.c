/**
 * @file wifi_sta.c
 * @brief WiFi Station (STA) driver — event-driven, retry with back-off.
 *
 * NOTE: The ESP32-D0WD-V3 supports 2.4 GHz 802.11 b/g/n ONLY.
 *       If the target AP broadcasts on 5 GHz exclusively the device
 *       will never associate.  Use a dual-band router or a 2.4 GHz
 *       phone hotspot.
 */

#include "wifi_sta.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_event.h"

/* ── Constants ─────────────────────────────────────────────────────────── */

#define TAG "wifi_sta"

/** Maximum number of (re)connection attempts before giving up. */
#define WIFI_MAX_RETRIES  10

/** Delay between retries in milliseconds (linear back-off). */
#define WIFI_RETRY_DELAY_MS 1000

/** EventGroup bits */
#define WIFI_CONNECTED_BIT  BIT0
#define WIFI_FAIL_BIT       BIT1

/* ── Module-private state ───────────────────────────────────────────────── */

static EventGroupHandle_t s_wifi_event_group = NULL;
static int                s_retry_count      = 0;

#ifdef CONFIG_UGP_WIFI_SCAN_DIAG
/**
 * When the scan diagnostic is enabled, WIFI_EVENT_STA_START must NOT call
 * esp_wifi_connect() immediately — we need to run the scan first (from the
 * task context of wifi_sta_init_and_connect, not from the event-loop task).
 * This flag is set to true by wifi_sta_init_and_connect() after the scan
 * completes; the handler then issues the real esp_wifi_connect().
 */
static volatile bool s_scan_done = false;
#endif

/* ── Event handlers ─────────────────────────────────────────────────────── */

/**
 * @brief Handler for WIFI_EVENT and IP_EVENT events.
 *
 * On disconnect: retries up to WIFI_MAX_RETRIES times with a short delay.
 * On WIFI_REASON_AUTH_FAIL the retry is skipped and WIFI_FAIL_BIT is set
 * immediately to avoid hammering the AP with bad credentials.
 * On got-IP: logs the assigned address and sets WIFI_CONNECTED_BIT.
 */
static void wifi_event_handler(void *arg,
                                esp_event_base_t event_base,
                                int32_t          event_id,
                                void            *event_data)
{
    if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                ESP_LOGI(TAG, "WiFi STA started — connecting to SSID: \"%s\"",
                         CONFIG_UGP_WIFI_SSID);
#ifdef CONFIG_UGP_WIFI_SCAN_DIAG
                /* Scan diagnostic is enabled: do NOT connect yet.
                 * wifi_sta_init_and_connect() will run the scan first, set
                 * s_scan_done = true, and then call esp_wifi_connect()
                 * explicitly from task context. */
                ESP_LOGI(TAG, "Scan diagnostic pending — deferring connect.");
#else
                {
                    esp_err_t conn_err = esp_wifi_connect();
                    if (conn_err != ESP_OK) {
                        ESP_LOGE(TAG,
                                 "esp_wifi_connect() failed synchronously: %s "
                                 "— setting WIFI_FAIL_BIT to unblock init.",
                                 esp_err_to_name(conn_err));
                        xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
                    }
                }
#endif
                break;

            case WIFI_EVENT_STA_DISCONNECTED: {
                wifi_event_sta_disconnected_t *disc =
                    (wifi_event_sta_disconnected_t *)event_data;

                /* Authentication failure: wrong password — stop retrying. */
                if (disc->reason == WIFI_REASON_AUTH_FAIL) {
                    ESP_LOGE(TAG,
                             "WiFi authentication failed (SSID: %s). "
                             "Check password.",
                             CONFIG_UGP_WIFI_SSID);
                    xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
                    break;
                }

                if (s_retry_count < WIFI_MAX_RETRIES) {
                    s_retry_count++;
                    ESP_LOGW(TAG,
                             "WiFi disconnected (reason %d). "
                             "Retry %d/%d in %d ms …",
                             disc->reason,
                             s_retry_count, WIFI_MAX_RETRIES,
                             WIFI_RETRY_DELAY_MS);
                    vTaskDelay(pdMS_TO_TICKS(WIFI_RETRY_DELAY_MS));
                    {
                        esp_err_t conn_err = esp_wifi_connect();
                        if (conn_err != ESP_OK) {
                            ESP_LOGE(TAG,
                                     "esp_wifi_connect() failed on retry %d: %s "
                                     "— setting WIFI_FAIL_BIT to unblock init.",
                                     s_retry_count,
                                     esp_err_to_name(conn_err));
                            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
                        }
                    }
                } else {
                    ESP_LOGE(TAG,
                             "WiFi connection failed after %d retries. "
                             "MQTT will not start.",
                             WIFI_MAX_RETRIES);
                    xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
                }
                break;
            }

            default:
                break;
        }

    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "WiFi connected — IP: " IPSTR,
                 IP2STR(&event->ip_info.ip));
        s_retry_count = 0;
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

/* ── Scan diagnostic ────────────────────────────────────────────────────── */

#ifdef CONFIG_UGP_WIFI_SCAN_DIAG

/** Maximum AP records to allocate for the scan. */
#define WIFI_SCAN_MAX_AP 20

/**
 * @brief Map esp_wifi authmode enum to a short diagnostic string.
 */
static const char *authmode_str(wifi_auth_mode_t mode)
{
    switch (mode) {
        case WIFI_AUTH_OPEN:             return "OPEN";
        case WIFI_AUTH_WEP:              return "WEP";
        case WIFI_AUTH_WPA_PSK:          return "WPA_PSK";
        case WIFI_AUTH_WPA2_PSK:         return "WPA2_PSK";
        case WIFI_AUTH_WPA_WPA2_PSK:     return "WPA_WPA2_PSK";
        case WIFI_AUTH_WPA2_ENTERPRISE:  return "WPA2_ENT";
        case WIFI_AUTH_WPA3_PSK:         return "WPA3_PSK";
        case WIFI_AUTH_WPA2_WPA3_PSK:    return "WPA2_WPA3_PSK";
        case WIFI_AUTH_WAPI_PSK:         return "WAPI_PSK";
        case WIFI_AUTH_OWE:              return "OWE";
        default:                         return "UNKNOWN";
    }
}

/**
 * @brief Blocking active scan of all channels; logs every visible AP.
 *
 * Called after esp_wifi_start() and before esp_wifi_connect().
 * Gated on CONFIG_UGP_WIFI_SCAN_DIAG.
 *
 * NOTE: The most common cause of TARGET SSID NOT FOUND when the AP is
 * clearly visible in the scan list is a credential mismatch — specifically,
 * CONFIG_UGP_WIFI_SSID containing extra quote characters (e.g. "'YourHotspotSSID'"
 * instead of "YourHotspotSSID") due to a parsing bug in set-wifi-from-env.sh.
 * Compare the SSID printed in the scan list against CONFIG_UGP_WIFI_SSID
 * shown in the "connecting to SSID:" log line: they must be identical.
 *
 * Channel 12/13 visibility: with the default ESP-IDF country policy
 * (WIFI_COUNTRY_POLICY_AUTO) the STA already performs a passive scan on
 * channels 12-14 even with country code "01".  Manual country code is only
 * authoritative under WIFI_COUNTRY_POLICY_MANUAL.  See wifi_sta_init_and_connect()
 * for the optional CONFIG_UGP_WIFI_COUNTRY_CODE setting.
 */
void wifi_sta_scan_and_log(void)
{
    ESP_LOGI(TAG, "-- WiFi scan diagnostic (CONFIG_UGP_WIFI_SCAN_DIAG=y) --");

    /* Blocking active scan: channel=0 means all channels, show_hidden=true. */
    wifi_scan_config_t scan_cfg = {
        .ssid        = NULL,   /* scan all SSIDs */
        .bssid       = NULL,
        .channel     = 0,      /* 0 = all channels allowed by country config */
        .show_hidden = true,
        .scan_type   = WIFI_SCAN_TYPE_ACTIVE,
        .scan_time   = {
            .active  = { .min = 100, .max = 300 },  /* ms per channel */
        },
    };

    esp_err_t err = esp_wifi_scan_start(&scan_cfg, true /* blocking */);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "WiFi scan failed: %s -- is esp_wifi_start() called first?",
                 esp_err_to_name(err));
        return;
    }

    /* Retrieve the number of APs found (capped to our buffer size). */
    uint16_t ap_count = WIFI_SCAN_MAX_AP;
    wifi_ap_record_t ap_records[WIFI_SCAN_MAX_AP];
    memset(ap_records, 0, sizeof(ap_records));

    err = esp_wifi_scan_get_ap_records(&ap_count, ap_records);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_scan_get_ap_records failed: %s",
                 esp_err_to_name(err));
        return;
    }

    /* esp_wifi_scan_get_ap_records() frees the internal list on success in
     * ESP-IDF 5.x — do NOT call esp_wifi_clear_ap_list() afterwards. */

    ESP_LOGI(TAG, "WiFi scan: found %u AP(s) (buffer cap=%d)",
             (unsigned)ap_count, WIFI_SCAN_MAX_AP);

    bool    target_found   = false;
    int8_t  target_rssi    = 0;
    uint8_t target_channel = 0;

    for (uint16_t i = 0; i < ap_count; i++) {
        const wifi_ap_record_t *ap = &ap_records[i];

        /* SSID is a uint8_t[33] null-terminated string; empty -> hidden AP. */
        const char *ssid_str = (ap->ssid[0] == '\0') ? "<hidden>"
                                                      : (const char *)ap->ssid;

        ESP_LOGI(TAG, "  ch=%2d rssi=%4d auth=%-12s ssid=\"%s\"",
                 ap->primary,
                 ap->rssi,
                 authmode_str(ap->authmode),
                 ssid_str);

        /* Case-sensitive exact match against the configured target SSID. */
        if (ap->ssid[0] != '\0' &&
            strcmp((const char *)ap->ssid, CONFIG_UGP_WIFI_SSID) == 0) {
            target_found   = true;
            target_rssi    = ap->rssi;
            target_channel = ap->primary;
        }
    }

    /* Summary line — paste this back when reporting a connect failure. */
    if (target_found) {
        ESP_LOGI(TAG,
                 "TARGET SSID \"%s\" FOUND on channel %u (rssi %d)",
                 CONFIG_UGP_WIFI_SSID, (unsigned)target_channel, (int)target_rssi);
    } else {
        ESP_LOGW(TAG,
                 "TARGET SSID \"%s\" NOT found in scan -- "
                 "check band(2.4GHz)/name/hidden/channel",
                 CONFIG_UGP_WIFI_SSID);
        if (ap_count > 0) {
            ESP_LOGW(TAG,
                     "  [!] %u AP(s) visible but target SSID not matched. "
                     "Likely causes: (1) SSID value has extra quote characters "
                     "(run set-wifi-from-env.sh and verify CONFIG_UGP_WIFI_SSID "
                     "in sdkconfig); (2) hidden SSID; (3) band mismatch (5 GHz).",
                     (unsigned)ap_count);
        } else {
            ESP_LOGW(TAG,
                     "  [!] Scan returned 0 APs -- verify hotspot is in 2.4 GHz "
                     "mode (ESP32 does NOT support 5 GHz) or check for antenna "
                     "issues.");
        }
    }

    ESP_LOGI(TAG, "-- WiFi scan complete -- proceeding with connect --");
}

#endif /* CONFIG_UGP_WIFI_SCAN_DIAG */

/* ── Public API ─────────────────────────────────────────────────────────── */

esp_err_t wifi_sta_init_and_connect(void)
{
    esp_err_t ret = ESP_OK;

    /* Create the synchronisation event group. */
    s_wifi_event_group = xEventGroupCreate();
    if (s_wifi_event_group == NULL) {
        ESP_LOGE(TAG, "Failed to create WiFi event group");
        return ESP_ERR_NO_MEM;
    }

    /* Initialise TCP/IP stack and default event loop.
     * esp_netif_init() and esp_event_loop_create_default() are idempotent
     * in ESP-IDF 5.x: calling them a second time returns ESP_ERR_INVALID_STATE
     * which is harmless — we ignore it intentionally. */
    ret = esp_netif_init();
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "esp_netif_init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    ret = esp_event_loop_create_default();
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "esp_event_loop_create_default failed: %s",
                 esp_err_to_name(ret));
        return ret;
    }

    /* Create the default WiFi STA netif. */
    esp_netif_create_default_wifi_sta();

    /* Initialise the WiFi driver with default config. */
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ret = esp_wifi_init(&cfg);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    /* ── Country code (optional regulatory / TX-power adjustment) ────────────
     * CONFIG_UGP_WIFI_COUNTRY_CODE is an OPTIONAL setting (Kconfig.projbuild,
     * default "01" = world-safe).  It does NOT fix AP-not-found failures —
     * the confirmed root cause of WIFI_REASON_NO_AP_FOUND in this project was
     * a credential-parsing bug (extra quote characters in sdkconfig).
     *
     * Use this setting when you need to adjust the regulatory TX-power domain
     * for the jurisdiction where the device is deployed.  With the default
     * WIFI_COUNTRY_POLICY_AUTO (ESP-IDF default) the driver already performs
     * passive scans on channels 12-14 regardless of the configured code.
     *
     * API: esp_wifi_set_country_code(const char *country, bool ieee80211d_enabled)
     *   — Recommended helper over the deprecated esp_wifi_set_country().
     *   — Must be called AFTER esp_wifi_init() and BEFORE esp_wifi_set_mode() /
     *     esp_wifi_start(), because TX-power limits are applied at driver start.
     *   — ieee80211d_enabled=true: the driver adopts the country IE advertised
     *     by the connected AP for the duration of the association (Espressif
     *     default, recommended).
     *   — "01" is a valid code (world-safe); calling the API with it is safe
     *     and accurately reflects the intended configuration in flash.
     */
#ifdef CONFIG_UGP_WIFI_COUNTRY_CODE
    if (CONFIG_UGP_WIFI_COUNTRY_CODE[0] != '\0') {
        const char *cc = CONFIG_UGP_WIFI_COUNTRY_CODE;
        ESP_LOGI(TAG, "Setting WiFi country code: \"%s\" (regulatory/TX-power domain)",
                 cc);
        ret = esp_wifi_set_country_code(cc, true /* ieee80211d_enabled */);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "esp_wifi_set_country_code(\"%s\") failed: %s",
                     cc, esp_err_to_name(ret));
            return ret;
        }

        /* Log the effective country struct (useful to verify schan/nchan from
         * the Espressif binary library, since the per-country map is not
         * publicly documented). */
        wifi_country_t effective_cc = {0};
        if (esp_wifi_get_country(&effective_cc) == ESP_OK) {
            ESP_LOGI(TAG,
                     "Effective country: cc=%.2s  schan=%u  nchan=%u  max_tx_power=%d",
                     effective_cc.cc,
                     (unsigned)effective_cc.schan,
                     (unsigned)effective_cc.nchan,
                     (int)effective_cc.max_tx_power);
        }
    }
#endif /* CONFIG_UGP_WIFI_COUNTRY_CODE */

    /* Register event handlers for both WIFI and IP events. */
    ret = esp_event_handler_instance_register(WIFI_EVENT,
                                               ESP_EVENT_ANY_ID,
                                               &wifi_event_handler,
                                               NULL,
                                               NULL);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to register WIFI_EVENT handler: %s",
                 esp_err_to_name(ret));
        return ret;
    }

    ret = esp_event_handler_instance_register(IP_EVENT,
                                               IP_EVENT_STA_GOT_IP,
                                               &wifi_event_handler,
                                               NULL,
                                               NULL);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to register IP_EVENT handler: %s",
                 esp_err_to_name(ret));
        return ret;
    }

    /* Configure STA credentials from Kconfig. */
    wifi_config_t wifi_config = {
        .sta = {
            /* SSID and password are filled below to avoid truncation
             * warnings on the initialiser. */
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
            .pmf_cfg = {
                .capable  = true,
                .required = false,
            },
        },
    };

    /* Use strncpy to be safe with the fixed-size fields. */
    strncpy((char *)wifi_config.sta.ssid,
            CONFIG_UGP_WIFI_SSID,
            sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password,
            CONFIG_UGP_WIFI_PASSWORD,
            sizeof(wifi_config.sta.password) - 1);

    /* Set mode to STA and apply config. */
    ret = esp_wifi_set_mode(WIFI_MODE_STA);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_mode failed: %s", esp_err_to_name(ret));
        return ret;
    }

    ret = esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_config failed: %s", esp_err_to_name(ret));
        return ret;
    }

    /* Start WiFi — WIFI_EVENT_STA_START fires → handler calls esp_wifi_connect(). */
    ret = esp_wifi_start();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_start failed: %s", esp_err_to_name(ret));
        return ret;
    }

#ifdef CONFIG_UGP_WIFI_SCAN_DIAG
    /* Run the scan BEFORE the first connect attempt.
     * The event handler deferred esp_wifi_connect() until s_scan_done is set.
     * esp_wifi_start() is synchronous: by the time it returns, STA_START has
     * already been processed by the event loop, so the WiFi driver is ready
     * to accept esp_wifi_scan_start(). */
    wifi_sta_scan_and_log();
    s_scan_done = true;
    /* Now issue the real connect — mirrors what the STA_START handler does
     * in the non-diagnostic path. */
    ESP_LOGI(TAG, "Scan done — issuing esp_wifi_connect() for SSID: \"%s\"",
             CONFIG_UGP_WIFI_SSID);
    {
        esp_err_t conn_err = esp_wifi_connect();
        if (conn_err != ESP_OK) {
            ESP_LOGE(TAG,
                     "esp_wifi_connect() failed after scan: %s "
                     "— setting WIFI_FAIL_BIT to unblock init.",
                     esp_err_to_name(conn_err));
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
        }
    }
#endif

    ESP_LOGI(TAG, "Waiting for WiFi connection (SSID: %s, max %d retries)…",
             CONFIG_UGP_WIFI_SSID, WIFI_MAX_RETRIES);

    /* Block until connected or failed. */
    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE, /* do not clear on exit */
        pdFALSE, /* wait for any bit */
        portMAX_DELAY);

    if (bits & WIFI_CONNECTED_BIT) {
        return ESP_OK;
    } else {
        ESP_LOGE(TAG, "WiFi connection failed — firmware continues without network");
        return ESP_FAIL;
    }
}
