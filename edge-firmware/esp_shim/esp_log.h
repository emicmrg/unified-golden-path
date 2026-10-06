/**
 * @file esp_log.h (shim)
 * @brief Minimal shim for host compilation (tests).
 */

#pragma once

#include <stdio.h>
#include <stdarg.h>

typedef int esp_log_level_t;

#define ESP_LOG_ERROR 1
#define ESP_LOG_WARN 2
#define ESP_LOG_INFO 3
#define ESP_LOG_DEBUG 4

static inline void esp_log_write(esp_log_level_t level, const char *tag,
                                   const char *format, ...) {
    (void)level;
    va_list args;
    va_start(args, format);
    fprintf(stdout, "[%s] ", tag);
    vfprintf(stdout, format, args);
    fprintf(stdout, "\n");
    va_end(args);
}

#define ESP_LOG_LEVEL(level, tag, format, ...) \
    do { \
        if (level <= ESP_LOG_INFO) { \
            esp_log_write(level, tag, format, ##__VA_ARGS__); \
        } \
    } while (0)

#define ESP_LOGI(tag, format, ...) ESP_LOG_LEVEL(ESP_LOG_INFO, tag, format, ##__VA_ARGS__)
#define ESP_LOGW(tag, format, ...) ESP_LOG_LEVEL(ESP_LOG_WARN, tag, format, ##__VA_ARGS__)
#define ESP_LOGE(tag, format, ...) ESP_LOG_LEVEL(ESP_LOG_ERROR, tag, format, ##__VA_ARGS__)
#define ESP_LOGD(tag, format, ...) ESP_LOG_LEVEL(ESP_LOG_DEBUG, tag, format, ##__VA_ARGS__)
