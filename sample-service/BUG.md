# BUG.md — Injectable bugs for the self-healing demo

This document describes the injectable bugs in `sample-service`.
The **codebase is green** (no active bugs).
The bugs documented here are injected manually for the demo, and the
`self-healing-crew` must diagnose them from the CI log.

---

## Bug A — Boundary logic error in `validateTemperature`

### Description

The `>=` operator is changed to `>` in the lower-boundary comparison of
temperature. This causes the exact value **2.0 °C** to be rejected as out of
range, even though the clinical standard includes it as a safe value.

**Impact on tests:** At least 2 tests fail with clear messages that the
`log-analyst` of the crew can diagnose:

```
AssertionError: expected false to be true  // "returns true for 2.0 °C"
AssertionError: expected 'WARN' to be 'OK' // "classifies OK for exact lower boundary"
```

The vitest message includes the test name and the expected vs received value,
making it trivial to identify that the lower bound `2.0 °C` is the failure point.

---

### Diff to INJECT the bug

Apply to `src/coldChain.ts`:

```diff
--- a/sample-service/src/coldChain.ts
+++ b/sample-service/src/coldChain.ts
@@ -75,8 +75,8 @@ export function validateTemperature(celsius: number): boolean {
   if (!Number.isFinite(celsius)) {
     throw new TypeError(
       `validateTemperature: se esperaba un número finito, recibido: ${celsius}`
     );
   }
-  // Rango seguro: [TEMP_MIN_C, TEMP_MAX_C] — extremos INCLUIDOS
-  return celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C;
+  // BUG: operador > en lugar de >= excluye el límite inferior 2.0 °C
+  return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;
 }
```

**Exact line to modify** in `src/coldChain.ts`:

| Line | ORIGINAL code (green)                            | Code WITH BUG (red)                             |
|------|--------------------------------------------------|-------------------------------------------------|
| 81   | `return celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C;` | `return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;` |

---

### Diff to REVERT the bug

```diff
--- a/sample-service/src/coldChain.ts
+++ b/sample-service/src/coldChain.ts
@@ -75,8 +75,8 @@ export function validateTemperature(celsius: number): boolean {
   if (!Number.isFinite(celsius)) {
     throw new TypeError(
       `validateTemperature: se esperaba un número finito, recibido: ${celsius}`
     );
   }
-  // BUG: operador > en lugar de >= excluye el límite inferior 2.0 °C
-  return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;
+  // Rango seguro: [TEMP_MIN_C, TEMP_MAX_C] — extremos INCLUIDOS
+  return celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C;
 }
```

---

### How to reproduce the demo in seconds

```bash
# 1. Inject the bug (edit one line in src/coldChain.ts)
#    Change: return celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C;
#    To:     return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;

# 2. Run tests → they MUST FAIL (red)
pnpm --dir sample-service run test

# 3. Observe in the log messages such as:
#    ✗ returns true for the exact minimum temperature (2.0 °C)
#      AssertionError: expected false to be true
#    ✗ classifies OK for exact lower boundary (2.0 °C, 30 %RH)
#      AssertionError: expected 'WARN' to be 'OK'

# 4. Revert the bug (restore >=)
#    Change: return celsius > TEMP_MIN_C && celsius <= TEMP_MAX_C;
#    To:     return celsius >= TEMP_MIN_C && celsius <= TEMP_MAX_C;

# 5. Run tests → they MUST PASS (green)
pnpm --dir sample-service run test
```

---

## Bug B — Incompatible dependency version (optional, less visual)

### Description

Change `vitest` in `package.json` to a version that does not exist in the registry:

**Line to modify** in `sample-service/package.json`:

| Field | ORIGINAL value (green) | Value WITH BUG (red) |
|-------|------------------------|----------------------|
| `"vitest"` | `"2.1.8"` | `"99.0.0"` |

**Effect:** `pnpm install --frozen-lockfile` fails with `ERR_PNPM_OUTDATED_LOCKFILE`
because the committed lockfile does not match the modified `package.json`.
If `pnpm install` is run without `--frozen-lockfile`, resolution fails with
`ERR_PNPM_NO_MATCHING_VERSION` when trying to resolve `vitest@99.0.0`.

**Revert:** Restore `"vitest": "2.1.8"` and run `pnpm install` again.

> **Note for the demo:** Bug A is preferred because it produces semantically clear
> test messages (what value was expected vs what was received), making the
> `log-analyst` diagnosis more interesting and demonstrative.

---

## VERIFIED failure message (Bug A active)

Actual output of `vitest run` v2.1.8 with the bug injected:

```
 RUN  v2.1.8 /…/sample-service

 ❯ src/__tests__/coldChain.test.ts (50 tests | 2 failed) 9ms
   × validateTemperature > devuelve true para la temperatura mínima exacta (2.0 °C) 4ms
     → expected false to be true // Object.is equality
   × classifyReading → OK > clasifica OK para límite inferior exacto (2.0 °C, 30 %RH) 1ms
     → expected 'WARN' to be 'OK' // Object.is equality

 FAIL  src/__tests__/coldChain.test.ts > validateTemperature > devuelve true para la temperatura mínima exacta (2.0 °C)
AssertionError: expected false to be true // Object.is equality

- Expected: true
+ Received: false

 FAIL  src/__tests__/coldChain.test.ts > classifyReading → OK > clasifica OK para límite inferior exacto (2.0 °C, 30 %RH)
AssertionError: expected 'WARN' to be 'OK' // Object.is equality

Expected: "OK"
Received: "WARN"

 Test Files  1 failed (1)
      Tests  2 failed | 48 passed (50)
```

This log is sufficient for the crew's `log-analyst` to diagnose:
> "The `validateTemperature` function does not include the lower bound 2.0 °C.
> The `>=` operator was replaced with `>`, excluding the range endpoint.
> Fix: restore `>=` in the return condition."
