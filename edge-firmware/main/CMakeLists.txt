idf_component_register(
    SRCS
        "app_main.c"
        "env_source_simulated.c"
        "env_source_dht11.c"
        "wifi_sta.c"
        "mqtt_iot.c"
        "ota_jobs.c"
    INCLUDE_DIRS
        "."
    REQUIRES
        # NVS (required before WiFi init)
        nvs_flash
        # GPIO (driver/gpio.h — used by env_source_dht11 and wifi_sta)
        esp_driver_gpio
        # WiFi
        esp_netif
        esp_wifi
        # Events (used by wifi_sta + mqtt_iot)
        esp_event
        # MQTT (built-in esp-mqtt; provides mqtt_client.h)
        mqtt
        # OTA: download + partition management
        esp_https_ota
        app_update
        # cJSON (bundled with ESP-IDF as component 'json')
        json
    EMBED_TXTFILES
        "certs/AmazonRootCA1.pem"
        "certs/device.crt.pem"
        "certs/device.key.pem"
)
