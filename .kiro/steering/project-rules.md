# Reglas del proyecto — AWS IoT in the Edge v2

Proyecto de la charla de Platform Engineering: "The Unified Golden Path" (edge golden path + broche de IA).
Responde en español. Trabaja orientado a producción, honesto y conciso.

## Cómo trabajamos (ciclo de desarrollo)
Para tareas no triviales sigue el ciclo (skill /dev-cycle): investigar (researcher) → desarrollar
(node-dev / python-dev / aws-infra) → test (tester) → revisar (reviewer) ronda 1 → fix → revisar
ronda 2 → seguridad (security) y docs (docs) si aplica. La doble revisión es obligatoria.
Para orquestar tareas grandes usa el agente `orchestrator`.

## Reglas anti-cuelgue
- Nunca búsquedas recursivas (grep/glob/find) sobre /, ~, /Users u otros árboles enormes. Acota al proyecto.
- Nunca procesos de larga vida (modo watch, dev servers). Usa run-once: vitest run, jest --ci, pytest -q.
- Prefiere comandos con salida acotada; no vuelques archivos/logs enormes completos.

## Seguridad y permisos
- Comandos de solo lectura (ver skill /aws-safe-ops) se ejecutan sin pedir permiso.
- Acciones destructivas o de despliegue en AWS requieren confirmación explícita, explicando qué hace,
  el blast radius y si es reversible.
- Nunca hardcodees secretos ni los imprimas. Usa variables de entorno, SSM o Secrets Manager.
- Cuenta de trabajo: sandbox de Slalom (Innovation Labs GDL). Región us-east-1. SIN datos reales ni clientes.

## Calidad
- Lee el código existente antes de escribir; respeta estilo y convenciones. Tipado fuerte, manejo de errores,
  validación de input. Verifica (build/lint/tests) antes de reportar. Cambios acotados. Versiones fijas.
