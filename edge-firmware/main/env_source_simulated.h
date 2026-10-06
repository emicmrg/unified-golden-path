/**
 * @file env_source_simulated.h
 * @brief Declaration of the SimulatedSource factory.
 */

#pragma once

#include "env_source.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Creates an EnvironmentSource instance with synthetic clinical
 *        cold-chain data (~4 °C / ~45 %RH with pseudo-random variation).
 *
 * @return Fully initialized EnvironmentSource struct (no hardware required).
 */
EnvironmentSource environment_source_simulated(void);

#ifdef __cplusplus
}
#endif
