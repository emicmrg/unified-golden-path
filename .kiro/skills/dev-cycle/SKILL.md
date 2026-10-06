---
name: dev-cycle
description: Flujo de trabajo estándar para tareas de desarrollo: investigar con fuentes oficiales, desarrollar, crear y correr tests, revisar en busca de bugs, y bug-fixing en un ciclo de revisión de dos pasadas. Úsalo al implementar una feature, arreglar un bug, o cuando se mencione "ciclo de desarrollo" o "dev-cycle".
---

# Ciclo de desarrollo (research → dev → test → review×2)

Usa el agente `orchestrator` para coordinarlo, o ejecútalo delegando a los subagentes.

## Fase 1 — Research (`researcher`)
- Investiga a fondo ANTES de escribir código. Fuentes oficiales/primarias.
- Usa `web_fetch` (dominios AWS/GitHub en trusted) y `use_aws` en modo lectura.
- Entregable: hallazgos citados, recomendación, riesgos. No pases a dev sin research para problemas nuevos.

## Fase 2 — Develop (dev según stack)
- Node/TS/React → `node-dev`; Python → `python-dev`; IaC/AWS → `aws-infra`.
- Lee el código existente y respeta convenciones. Cambios acotados. Seguridad por defecto. Versiones fijas.

## Fase 3 — Test (`tester`)
- Detecta/usa el framework; si no hay, instala el estándar. Tests deterministas (happy path + edge + errores) en modo run-once.

## Fase 4 — Review ronda 1 (`reviewer`)
- Busca bugs, regresiones, manejo de errores faltante, violaciones de convención.
- Veredicto: APROBADO o NECESITA CAMBIOS. Si NECESITA CAMBIOS → vuelve a Fase 2, luego repite.

## Fase 5 — Review ronda 2 (`reviewer`)
- Segunda pasada tras el fix. Solo se cierra cuando la ronda 2 queda APROBADA.

## Fase 6 — Seguridad (`security`, condicional)
- Si toca auth, datos, secretos, endpoints o infraestructura.

## Fase 7 — Docs (`docs`, condicional)
- Si cambió una API pública o el diseño, o si se pide.

## Reglas transversales
- Verifica siempre: build/lint/tests deben pasar antes de reportar una fase completa.
- Si una fase falla dos veces con el mismo error, diagnostica causa raíz y cambia de enfoque.
- Comandos destructivos o de despliegue en AWS requieren confirmación explícita del usuario.
