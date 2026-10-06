---
name: aws-safe-ops
description: Guía de operación segura sobre AWS: qué comandos son de solo lectura y se pueden ejecutar libremente, y cuáles son destructivos o de despliegue y requieren confirmación explícita. Úsalo al trabajar con AWS (use_aws), CDK, Terraform o CloudFormation.
---

# Operación segura en AWS

## Siempre permitido (solo lectura) — ejecuta sin pedir permiso
- Identidad: `use_aws` sts get-caller-identity.
- Describe/List/Get: `use_aws` describe-*, list-*, get-* (ec2, iam, logs, lambda, dynamodb, s3, cloudformation, iot).
- IaC en modo plan: cdk synth, cdk diff, cdk list, terraform plan, terraform validate, cloudformation describe-stacks.

## Requiere CONFIRMACIÓN EXPLÍCITA (destructivo o despliegue)
Antes de ejecutar, DETENTE y explica: qué hace, el blast radius, y si es reversible.
- Despliegue: cdk deploy, terraform apply, cloudformation deploy/create-stack/update-stack.
- Destrucción: cdk destroy, terraform destroy, cloudformation delete-stack.
- Mutaciones directas: cualquier create-*, update-*, put-*, delete-*, terminate-*, modify-*, o cambios de IAM en vivo.

## Procedimiento para un cambio de infraestructura
1. cdk diff / terraform plan para mostrar el cambio exacto.
2. Resumir impacto (recursos, costo estimado, reversibilidad).
3. Pedir confirmación al usuario.
4. Solo entonces ejecutar el deploy/apply.
5. Verificar con comandos de solo lectura.

## Buenas prácticas
- Least privilege en IAM; evita *:* y wildcards de recurso sin justificación.
- No hardcodear cuentas/regiones/secretos; usa SSM Parameter Store / Secrets Manager.
- Etiquetar recursos; comunicar el impacto de costos.
