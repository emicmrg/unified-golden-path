/**
 * @file env_source_dht11.h
 * @brief Declaration of the Dht11Source factory (ARD-360 / DHT11).
 */

#pragma once

#include "driver/gpio.h"
#include "env_source.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Creates an EnvironmentSource instance for the DHT11 sensor
 *        (ARD-360).  Currently a STUB — the real read is implemented
 *        in Block 3 once the sensor marking is confirmed.
 *
 * @param data_gpio GPIO pin connected to the DHT11 DATA pin.
 *                  Use CONFIG_UGP_DHT11_GPIO (Kconfig, default GPIO4).
 * @return EnvironmentSource struct with DHT11 function pointers.
 */
EnvironmentSource environment_source_dht11(gpio_num_t data_gpio);

#ifdef __cplusplus
}
#endif
