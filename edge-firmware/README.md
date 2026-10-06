# edge-firmware — Unified Golden Path

ESP-IDF firmware (C/C++) for the edge node of the _The Unified Golden Path_ project.
Runs on **ESP32-D0WD-V3 rev v3.1** (target `esp32`) and measures ambient temperature
and humidity, designed for a clinical cold chain (~2–8 °C / ~45 %RH).

---

## Structure

```
edge-firmware/
├── CMakeLists.txt          ESP-IDF project (root level)
├── partitions.csv          A/B partition table for OTA (4 MB flash)
├── sdkconfig.defaults      Default SDK configuration
└── main/
    ├── CMakeLists.txt      Main ESP-IDF component
    ├── Kconfig.projbuild   Configuration menu (idf.py menuconfig)
    ├── app_main.c          Entry point; FreeRTOS sampling loop
    ├── env_source.h        EnvironmentSource interface (vtable in C)
    ├── env_source_simulated.h / .c   Synthetic source (no hardware required)
    └── env_source_dht11.h  / .c     DHT11 ARD-360 source (STUB, Block 3)
```

---

## EnvironmentSource Abstraction

The `EnvironmentSource` interface (defined in `env_source.h`) decouples the business
logic from the hardware driver using a vtable in C (struct with function pointers):

| Method | Description |
|--------|-------------|
| `init(self)` | Initializes GPIO/resources. Call once before `read`. |
| `read(self, &temp_c, &humidity_pct)` | Reads temperature (°C) and humidity (%RH). |
| `name(self)` | Descriptive name of the source (`"simulated"` / `"dht11"`). |

**Available implementations:**

- **SimulatedSource** — synthetic cold-chain data (~4 °C ± 0.8 °C,
  ~45 %RH ± 3 %RH). Functional without hardware. Selected by default.
- **Dht11Source** — STUB for the ARD-360 sensor (assumed DHT11; see note below).
  Returns `ESP_ERR_NOT_SUPPORTED` until Block 3.

The source is selected at compile time via `idf.py menuconfig` →
`UGP Edge Firmware` → `Ambient data source`.

---

## How to Build

### Prerequisites

| Tool        | Version |
|-------------|---------|
| ESP-IDF     | 5.3.x   |
| Python      | 3.11+   |
| CMake       | 3.16+   |

Activate the ESP-IDF environment before building:

```bash
# Linux/macOS — typical path:
. $HOME/esp/esp-idf/export.sh

# Or if installed with Homebrew / official installer:
. ~/.espressif/python_env/idf5.3_py3.11_env/bin/activate
```

### Steps

```bash
cd edge-firmware

# 1. Set ESP32 target (generates sdkconfig from sdkconfig.defaults)
idf.py set-target esp32

# 2. (Optional) Adjust configuration interactively
idf.py menuconfig

# 3. Build
idf.py build
```

### Flash and Monitor (confirmed hardware)

> **Hardware:** ESP32-D0WD-V3 rev v3.1 · Port: `/dev/cu.usbserial-0001`

```bash
idf.py -p /dev/cu.usbserial-0001 flash monitor
```

Expected output (simulated source):

```
I (xxx) app_main: === Unified Golden Path — Edge Firmware starting ===
I (xxx) app_main: Selected source: Simulated (clinical cold chain)
I (xxx) env_sim:  SimulatedSource initialized (clinical cold chain ~4°C/45%RH)
I (xxx) app_main: [simulated] Temp: 4.32 °C  |  Humidity: 46.1 %RH
I (xxx) app_main: [simulated] Temp: 3.87 °C  |  Humidity: 44.8 %RH
...
```

Exit the monitor: `Ctrl+]`

---

## A/B Partitions (OTA)

The `partitions.csv` file defines two application slots for risk-free OTA updates
("brick-safe"):

| Partition | Type | Offset   | Size    | Description |
|-----------|------|----------|---------|-------------|
| nvs       | data | 0x9000   | 24 KB   | Configuration, TLS certificates |
| otadata   | data | 0xF000   | 8 KB    | A/B metadata (which slot to boot) |
| phy_init  | data | 0x11000  | 4 KB    | RF calibration |
| ota_0     | app  | 0x20000  | 1.625 MiB | Slot A — active firmware |
| ota_1     | app  | 0x1C0000 | 1.625 MiB | Slot B — OTA destination |

OTA orchestration (AWS IoT Jobs) will be implemented in **Block 2**.

---

## Block Status

| Block | Component | Status |
|-------|-----------|--------|
| 1 | ESP-IDF scaffold, EnvironmentSource abstraction, SimulatedSource | ✅ Complete |
| 1 | Dht11Source STUB | ✅ Stub created |
| 2 | MQTT → AWS IoT Core, IoT Jobs (OTA) | ⏳ Pending |
| 3 | Real DHT11 protocol (env_source_dht11.c) | ⏳ Pending |

---

## Note on the ARD-360 Sensor

The sensor module is labelled **ARD-360**. It is **assumed** to be a DHT11
(compatible with the 1-wire DHT 40-bit protocol, 1 °C / 1 %RH resolution).
**Confirm the physical IC marking** before implementing the driver in Block 3:
it could be a DHT22/AM2302 (0.1 °C / 0.1 %RH resolution, similar but different
timing). If it is a DHT22, adjust the decoding in `env_source_dht11.c`.

---

## MQTT / OTA — Next Step (Block 2)

Placeholders in `app_main.c` mark where to connect:

- `mqtt_iot_init()` / `mqtt_iot_connect()` — MQTT client over TLS toward AWS IoT Core.
- `ota_jobs_start()` — subscription to AWS IoT Jobs to receive firmware updates.
