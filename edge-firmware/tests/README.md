# edge-firmware/tests — Host-side smoke tests

Tests que corren en la máquina de desarrollo (macOS/Linux) sin hardware ESP32
ni ESP-IDF instalado.

## test_ota_reassembly — Smoke test del reensamblado MQTT (B1 fix)

Verifica la función pura `ota_reassembly_feed()` que acumula chunks MQTT
fragmentados en un buffer de reensamblado.

### Por qué existe este test

esp-mqtt entrega payloads grandes en múltiples `MQTT_EVENT_DATA`:
- **Chunk 1** (`current_data_offset == 0`): `event->topic` poblado.
- **Chunks 2..N** (`current_data_offset > 0`): `event->topic == NULL`.

El bug original (B1) tenía un guard `if (event->topic == NULL) break;`
que descartaba silenciosamente todos los chunks de continuación, haciendo
que el buffer de reensamblado fuera código muerto para cualquier job document
con URL S3 presignada (> 1 024 B).

El fix persiste la decisión de topic-match en `s_reassembly_topic_match` y
delega la acumulación a `ota_reassembly_feed()` — la función que este test
ejercita directamente.

### Build y ejecución (no requiere ESP-IDF)

```bash
# Desde edge-firmware/tests/:
gcc -std=c11 -Wall -Wextra -pedantic \
    -DUNIT_TEST \
    -o /tmp/test_ota_reassembly \
    test_ota_reassembly.c \
    ota_reassembly_stub.c

/tmp/test_ota_reassembly
```

### Salida esperada

```
=== OTA reassembly smoke test ===

[PASS] two-chunk: chunk 1 accepted
[PASS] two-chunk: returns not-complete after chunk 1
[PASS] two-chunk: chunk 2 accepted
[PASS] two-chunk: returns complete after chunk 2
[PASS] two-chunk: buffer is non-NULL after completion
[PASS] two-chunk: total matches original JSON length
[PASS] two-chunk: reassembled payload matches original JSON
[PASS] single-chunk (total==0): accepted
[PASS] single-chunk (total==0): complete immediately
[PASS] single-chunk payload correct
[PASS] oversized payload rejected
[PASS] oversized: complete flag stays false
[PASS] bounds-check: chunk beyond total rejected
[PASS] reset between sessions: second session succeeds
[PASS] reset between sessions: second payload correct

15/15 tests passed.
```

### Archivos

| Archivo | Descripción |
|---------|-------------|
| `test_ota_reassembly.c` | Test runner con 5 casos de prueba |
| `ota_reassembly_stub.c` | Re-implementación pura de `ota_reassembly_feed` sin ESP-IDF |
| `ota_reassembly_stub.h` | Header del stub |

### Nota sobre el stub vs. ota_jobs.c

El stub es una copia fiel de la lógica de acumulación de `ota_jobs.c`.
Si `ota_jobs.c` cambia la lógica de `ota_reassembly_feed` (constantes,
bounds checks, normalización de `total==0`), el stub **debe sincronizarse**
para que el test siga siendo válido.

La constante `OTA_MAX_JOB_PAYLOAD_LEN = 4096` debe coincidir en ambos archivos.
