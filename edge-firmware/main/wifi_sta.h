/**
 * @file wifi_sta.h
 * @brief WiFi Station (STA) initialisation for the Unified Golden Path firmware.
 *
 * Connects the ESP32 to a 2.4 GHz access point using the credentials from
 * Kconfig (CONFIG_UGP_WIFI_SSID / CONFIG_UGP_WIFI_PASSWORD) and blocks
 * until an IP address is obtained or the maximum number of retries is
 * exhausted.
 *
 * NOTE: The ESP32-D0WD-V3 supports 2.4 GHz 802.11 b/g/n ONLY.
 *       5 GHz bands and Wi-Fi 6 (802.11ax) are not supported.
 *
 * Dependencies (must appear in CMakeLists.txt REQUIRES):
 *   nvs_flash, esp_wifi, esp_event, esp_netif
 */

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Performs a blocking active WiFi scan and logs every visible AP.
 *
 * Must be called AFTER esp_wifi_start() (i.e. the STA driver must already
 * be running in STA mode).  Scans all channels with show_hidden=true so that
 * hidden SSIDs appear as an empty string ("<hidden>" in the log).
 *
 * For each AP the following is logged on a single line:
 *   ch=%2d rssi=%4d auth=%-12s ssid="<ssid>"
 *
 * After listing all APs, logs whether CONFIG_UGP_WIFI_SSID was found:
 *   TARGET SSID "YourHotspotSSID" FOUND on channel 6 (rssi -58)
 *     — or —
 *   TARGET SSID "YourHotspotSSID" NOT found in scan — check band(2.4GHz)/name/hidden/channel
 *
 * Gated on CONFIG_UGP_WIFI_SCAN_DIAG; when disabled this is a no-op.
 *
 * @note Root cause of NOT FOUND when scan sees the AP: the most common cause
 *       is CONFIG_UGP_WIFI_SSID containing extra quote characters (e.g.
 *       "'YourHotspotSSID'" instead of "YourHotspotSSID") from a .env parsing bug.
 *       Run set-wifi-from-env.sh and verify the value in sdkconfig.
 *
 * @note Country code and channel range: with the default ESP-IDF policy
 *       (WIFI_COUNTRY_POLICY_AUTO) the driver already scans channels 12-14
 *       passively even with country code "01".  CONFIG_UGP_WIFI_COUNTRY_CODE
 *       is an optional regulatory/TX-power adjustment, not a channel-unlock fix.
 */
void wifi_sta_scan_and_log(void);

/**
 * @brief Initialises TCP/IP + WiFi stack and connects to the configured AP.
 *
 * This function:
 *   1. Initialises esp_netif and the default event loop (idempotent; safe
 *      to call if the caller has already done so, because it checks).
 *   2. Creates a default STA netif.
 *   3. Registers event handlers for WIFI_EVENT and IP_EVENT.
 *   4. Starts the WiFi driver and issues a connect request.
 *   5. Blocks on an EventGroup bit until either an IP is assigned
 *      (WIFI_CONNECTED_BIT) or the retry limit is hit (WIFI_FAIL_BIT).
 *
 * Retries use a simple linear back-off (1 s per attempt).
 * Maximum retries: defined by the internal constant WIFI_MAX_RETRIES (10),
 * in wifi_sta.c — not a Kconfig symbol.
 *
 * @return ESP_OK if an IP address was obtained.
 *         ESP_FAIL if the retry limit was exhausted.
 *         Other esp_err_t codes on initialisation errors.
 */
esp_err_t wifi_sta_init_and_connect(void);

#ifdef __cplusplus
}
#endif
