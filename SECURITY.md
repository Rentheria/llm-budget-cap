# Security Policy

## Reporting a Vulnerability

If you find a security issue in `llm-budget-cap`, please report it privately instead of opening a public issue.

- Email: **rentheria.dev@gmail.com**
- Or use GitHub's [private vulnerability reporting](https://github.com/Rentheria/llm-budget-cap/security/advisories/new) for this repo.

Include what you found, how to reproduce it, and its potential impact. We'll acknowledge your report as soon as we can and keep you posted on the fix.

## Scope

This library is a thin, atomic Redis counter (static Lua scripts for `INCRBY` + `PEXPIRE`, and a signed `settle`) used to cap spend/usage on external APIs. It never accepts user-controlled strings into the Lua scripts themselves — the scripts are static, and all inputs are passed as Redis `KEYS`/`ARGV`; `subKey` is validated to a strict charset before it reaches Redis. Reports about the atomicity guarantee, the reserve/settle flow, the `timeoutMs`/`failOpen` degraded behavior, or the Redis client contract are all in scope.

---

# Política de Seguridad

## Reportar una vulnerabilidad

Si encuentras un problema de seguridad en `llm-budget-cap`, repórtalo en privado en vez de abrir un issue público.

- Correo: **rentheria.dev@gmail.com**
- O usa el [reporte privado de vulnerabilidades](https://github.com/Rentheria/llm-budget-cap/security/advisories/new) de GitHub para este repo.

Incluye qué encontraste, cómo reproducirlo, y su impacto potencial. Confirmaremos tu reporte lo antes posible y te mantendremos al tanto del fix.

## Alcance

Esta librería es un contador atómico chico sobre Redis (scripts de Lua estáticos para `INCRBY` + `PEXPIRE`, y un `settle` con delta con signo) usado para topar gasto/uso de APIs externas. Nunca mete strings controlados por el usuario dentro de los scripts de Lua — los scripts son estáticos, y todos los inputs van como `KEYS`/`ARGV` de Redis; el `subKey` se valida contra un charset estricto antes de llegar a Redis. Reportes sobre la garantía de atomicidad, el flujo reserve/settle, el comportamiento degradado de `timeoutMs`/`failOpen`, o el contrato del cliente Redis están en alcance.
