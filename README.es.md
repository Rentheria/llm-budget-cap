# llm-budget-cap

[![CI](https://github.com/Rentheria/llm-budget-cap/actions/workflows/ci.yml/badge.svg)](https://github.com/Rentheria/llm-budget-cap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/llm-budget-cap.svg)](https://www.npmjs.com/package/llm-budget-cap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

_[English](README.md)_

**Tope de gasto atómico en Redis para APIs de LLM (OpenAI, Gemini, Anthropic, …).**

> **Ver también:** [chatarmor](https://github.com/Rentheria/chatarmor) — kit de seguridad para IA conversacional.
> Un contador `INCR` + `PEXPIRE` que corre **entero dentro de un solo script de Lua**, para que un bug o un abuso no te desangren silenciosamente la factura de tu API de IA.

- ⚛️ **Realmente atómico.** Incremento + armado de TTL en una sola ejecución de Lua: dos requests casi simultáneos cerca del límite **no pueden pasar los dos**. Un `GET` + `SET` sí (explicado abajo).
- 🧮 **Reserve → settle para un tope de gasto real.** Reserva un estimado **antes** de la llamada de pago (eso es lo que topa), y liquida con el costo real después (devuelve el estimado no usado, o cobra el excedente). La decisión ocurre **antes** de que se gaste el dinero.
- ⏱️ **Modo degradado de verdad.** Un `timeoutMs` duro por llamada: si Redis se cuelga, la llamada se decide (fail-open o fail-closed) dentro del presupuesto de tiempo en vez de colgar el request.
- 🎯 **Chico y enfocado.** Una clase. Cero dependencias de terceros (solo el cliente `ioredis` que ya tienes).
- 🕒 **Ventana fija configurable.** 24h por defecto; cualquier ventana en milisegundos.
- 🔑 **Un contador global o uno por key** (por tenant, por usuario).

> ⚠️ **¿Vienes de 0.1.0?** El patrón viejo de "contar después de la llamada" que mostraba el README **no topaba nada** bajo concurrencia. Ver [Migrar desde 0.1.0](#migrar-desde-010). Usa `reserve`/`settle`.

---

## Por qué existe (la historia honesta)

Lo construimos porque necesitábamos topar el gasto de un chatbot de IA **sin que un bug lo dejara desangrar dinero**. Montas un asistente sobre Gemini/OpenAI, todo va bien en pruebas, y un día un loop, un scraper o un cliente distribuido con mil IPs te dispara la factura a miles de dólares mientras duermes.

El fix que terminamos mandando a producción siempre fue el mismo: un contador en Redis que acumula gasto dentro de una ventana (24h) y corta cuando se pasa el límite. Dos partes sutiles dan la garantía:

1. El `INCR` y el `PEXPIRE` tienen que correr **atómicamente**, o dos requests que llegan en el mismo instante justo en el límite pasan los dos.
2. La **decisión tiene que ocurrir antes de la llamada de pago**, o el dinero ya se gastó cuando te enteras. Para eso está `reserve`/`settle`.

No es un rate limiter de propósito general (para eso están `@nestjs/throttler`, `rate-limiter-flexible`, etc.). Es un **tope de gasto**: una red de seguridad dura y barata contra facturas sorpresa.

---

## Instalación

```bash
npm install llm-budget-cap ioredis
```

`ioredis` es una **peer dependency** (trae tu propio cliente Redis). Funciona con Express, Fastify, NestJS o lo que sea — sin dependencia de framework.

### Config recomendada del cliente Redis

```ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL, {
  enableOfflineQueue: false, // Redis caído ⇒ error inmediato, no cola infinita
  maxRetriesPerRequest: 2, // no colgar el request path reintentando un server caído
});
```

`llm-budget-cap` además aplica su propio `timeoutMs` (default **5000 ms**) alrededor de cada llamada a Redis, así que el modo degradado funciona aunque olvides estas opciones — pero ponerlas hace que las fallas sean rápidas y limpias.

---

## Uso

### 1. Topar el número de llamadas (amount conocido antes de la llamada)

Cuando solo quieres topar **cuántas** llamadas ocurren (o el costo es un monto fijo que conoces de antemano), basta un solo `checkAndIncrement` atómico antes de la llamada de pago:

```ts
import { BudgetCap } from 'llm-budget-cap';

// Máximo 500 llamadas al LLM cada 24h (ventana por defecto).
const cap = new BudgetCap({ redis, key: 'gemini:daily', limit: 500 });

const decision = await cap.checkAndIncrement();
if (!decision.allowed) {
  return res.status(429).json({ error: 'Presupuesto diario de IA agotado.' });
}

const answer = await callGemini(userMessage); // tu llamada de pago, ya protegida
```

### 2. Un tope de gasto real en tokens/centavos (amount conocido solo después de la llamada)

El costo en tokens solo se conoce **después** de la llamada — así que tienes que **reservar un estimado primero** (esa es la decisión que topa), hacer la llamada y **liquidar** con el costo real. Liquidar devuelve el estimado no usado o cobra el excedente:

```ts
const cap = new BudgetCap({ redis, key: 'gemini:tokens', limit: 1_000_000 });

// 1. Reserva un estimado ANTES de la llamada de pago. Esto es lo que topa.
const reservation = await cap.reserve(userId, estimatedTokens);
if (!reservation.allowed) {
  return res.status(429).json({ error: 'Presupuesto de tokens agotado.' });
}

// 2. Haz la llamada de pago.
const response = await callGemini(userMessage);

// 3. Liquida con el costo real — devuelve la diferencia (o cobra el excedente).
await cap.settle(reservation, response.usage.totalTokens);
```

Reserva en o por encima del costo real típico, para que el tope se equivoque del lado seguro en la ventana entre reserva y liquidación. Si la llamada lanza antes de que liquides, la reserva simplemente queda contada hasta que la ventana expire — el tope se mantiene conservador, nunca permisivo.

### Un tope por usuario / tenant

```ts
const cap = new BudgetCap({
  redis,
  key: 'gemini:user', // combinado como `gemini:user:<subKey>`
  limit: 50,
  windowMs: 60 * 60 * 1000, // 1 hora
});

const decision = await cap.checkAndIncrement(userId);
if (!decision.allowed) {
  // este usuario en particular ya gastó su cuota por hora
}
```

Un `subKey` debe ser un **identificador normalizado del lado del servidor**: `[A-Za-z0-9_.-]`, 1–128 caracteres, sin `:`. Nunca pases un header crudo del request (p. ej. `X-Forwarded-For`) — normalízalo antes, o un atacante elige su propio bucket de presupuesto.

---

## Por qué Lua-atómico y no `GET` + `SET`

El enfoque ingenuo tiene una **race condition**:

```ts
// ❌ INSEGURO: hay una ventana entre el GET y el SET
const count = Number(await redis.get(key)) || 0;
if (count >= limit) return blocked();
await redis.set(key, count + 1); // ⬅️ otro request pudo haber leído el MISMO count
```

Con el límite en 500 y el contador en 499, si **dos requests llegan casi al mismo tiempo**:

1. Request A hace `GET` → lee `499`. Decide: `499 < 500`, procede.
2. Request B hace `GET` → lee `499` (A no ha escrito aún). Decide: `499 < 500`, procede.
3. A escribe `500`. B escribe `500`.

**Los dos pasaron.** El `INCR` de Redis es atómico, pero el problema real es **coordinar el `INCR` con el seteo del TTL** (`PEXPIRE`). El fix es meter **todo dentro de un solo script de Lua**, que Redis corre de principio a fin sin intercalar otros comandos:

```lua
local amount = tonumber(ARGV[2])
if amount == nil or amount < 1 then
  return redis.error_reply("BUDGETCAP: amount must be an integer >= 1")
end
local current = redis.call("INCRBY", KEYS[1], amount)
local ttl = redis.call("PTTL", KEYS[1])
if current == amount or ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
```

Cada `checkAndIncrement`/`reserve` obtiene un `current` único y creciente, y el TTL siempre se arma en la primera llamada de la ventana. (Usa `PTTL`/`PEXPIRE` en vez de `PEXPIRE ... NX`, así también funciona en Redis < 7.) Los scripts exactos se exportan como `ATOMIC_BUDGET_CAP_LUA` y `SETTLE_BUDGET_CAP_LUA` por si quieres auditarlos o reusarlos.

---

## API

### `new BudgetCap(options)`

| Opción       | Tipo                       | Default            | Descripción                                                                                    |
| ------------ | -------------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| `redis`      | `RedisEvalClient`          | —                  | Cliente compatible con ioredis (`eval(script, numKeys, ...args)`).                             |
| `key`        | `string`                   | —                  | Key base del contador. Con un `subKey` se combina como `key:subKey`.                           |
| `limit`      | `number`                   | —                  | Gasto/uso máximo permitido por ventana (entero 1…`Number.MAX_SAFE_INTEGER`).                   |
| `windowMs`   | `number`                   | `86_400_000` (24h) | Largo de la ventana fija en ms, contado desde el primer hit.                                   |
| `failOpen`   | `boolean`                  | `true`             | Si Redis falla/expira, ¿dejar pasar la operación (degradado) o lanzar?                         |
| `timeoutMs`  | `number`                   | `5000`             | Timeout duro por llamada a Redis. Si Redis no responde a tiempo, decide `failOpen`. `0` = off. |
| `onDegraded` | `(error: unknown) => void` | —                  | Se llama con el error cada vez que una llamada degrada (fail-open). Alerta/mide aquí.          |

### `checkAndIncrement(subKey?, amount?)` → `Promise<BudgetCapDecision>`

Incrementa atómicamente el contador y devuelve la decisión. Úsalo cuando `amount` se conoce **antes** de la llamada de pago (un conteo de llamadas — default `amount: 1` — o un costo fijo por llamada).

### `reserve(subKey?, estimate?)` → `Promise<BudgetCapReservation>`

Reserva `estimate` (default `1`) **antes** de la llamada de pago y devuelve una decisión (revisa `.allowed`) que además sirve de handle para `settle`. Esta es la decisión que topa.

### `settle(reservation, realCost)` → `Promise<BudgetCapDecision>`

Aplica `realCost - reserved` al mismo contador atómicamente (reembolso o excedente), sin extender la ventana. Seguro de llamar sobre una reserva degradada o después de que la ventana expiró (ambos son no-op). `realCost` es un entero ≥ 0.

```ts
interface BudgetCapDecision {
  allowed: boolean; // true si puedes proceder (count <= limit)
  count: number; // valor del contador DESPUÉS de esta operación (0 si degradado)
  limit: number; // el límite configurado
  remaining: number; // gasto restante: max(0, limit - count)
  degraded: boolean; // true si Redis falló/expiró y esto es un fallback fail-open
}

interface BudgetCapReservation extends BudgetCapDecision {
  subKey: string | undefined; // para settle
  reserved: number; // para settle
}
```

### Fail-open vs fail-closed

Por defecto (`failOpen: true`), si Redis es inalcanzable o más lento que `timeoutMs`, las llamadas devuelven `{ allowed: true, degraded: true }` en vez de lanzar: preferimos que una feature de pago quede brevemente sin medir durante una caída de Redis a tumbar la feature entera. **Alerta cuando `degraded === true`** (pasa `onDegraded`) — un tope degradado en silencio es un tope que no está. Con `failOpen: false` se lanza un `BudgetCapError` (el error original queda en su `cause`), y tú decides.

### node-redis en vez de ioredis

La librería solo necesita un método `eval(script, numKeys, ...args)`. El `eval` de node-redis (v4) tiene otra firma; envuélvelo:

```ts
const adapter = {
  eval: (script, numKeys, ...args) =>
    client.eval(script, {
      keys: args.slice(0, numKeys),
      arguments: args.slice(numKeys).map(String),
    }),
};
const cap = new BudgetCap({ redis: adapter, key: 'gemini:daily', limit: 500 });
```

---

## Requisitos de despliegue

El contador vive **solo en Redis**, así que el tope es **best-effort** contra cualquier cosa que borre la key:

- **Usa `maxmemory-policy noeviction`** (o una instancia de Redis dedicada) para la key del tope. Con `allkeys-lru`/`allkeys-lfu` la key del presupuesto es tan evictable como cualquier entrada de cache — el tope se reinicia en silencio a media ventana.
- El tope **no** sobrevive a `FLUSHALL`, eviction, ni a un failover de réplica asíncrona que pierda incrementos no replicados. Trátalo como red de seguridad, no como libro contable. Si necesitas contabilidad exacta del gasto, regístrala en tu base de datos; esto es el techo barato enfrente.
- Dale a la key un **prefijo de app/env** (`key: 'myapp:prod:gemini:daily'`) para que no colisione con otro contador en un Redis compartido.

### Checklist de producción

Antes de desplegar:

1. **Alerta sobre modo degradado.** Pasa `onDegraded` para loguear/medir/alertar cuando una falla de Redis dispara fail-open. Un tope degradado en silencio es un tope que no está.
2. **Revisa la estrategia fail-open.** Por defecto (`failOpen: true`) deja pasar requests cuando Redis falla — preferirías que una feature de pago quede sin medir brevemente a tumbarla por completo. Si tu caso demanda una frontera dura, pon `failOpen: false` y maneja el `BudgetCapError` lanzado.
3. **Chequea los timeouts de ioredis.** Pon `enableOfflineQueue: false` y `maxRetriesPerRequest: 2` para que Redis caído dé error inmediato en vez de encolar o reintentar indefinidamente.
4. **Verifica `REDIS_URL`.** Desarrollo local típicamente usa el puerto **6399** (`redis://127.0.0.1:6399`), mientras CI/producción usan **6379**. Ponlo explícito en la variable de entorno para evitar confusión.

---

## Migrar desde 0.1.0

**0.1.0 enseñaba un patrón que no topaba nada.** El README viejo mostraba llamar al LLM primero y `checkAndIncrement(undefined, tokens)` después:

```ts
// ❌ 0.1.0 — la decisión llega DESPUÉS de que el dinero se gastó.
const response = await callGemini(userMessage);
const decision = await cap.checkAndIncrement(
  undefined,
  response.usage.totalTokens,
);
if (!decision.allowed) {
  /* demasiado tarde — la llamada ya ocurrió */
}
```

Bajo concurrencia esto dejaba el gasto pasarse muy por encima del límite (medido: `limit=1000`, 50 llamadas concurrentes de 400 tokens → **20,000 tokens gastados, 20×** el presupuesto). Reemplázalo por `reserve` + `settle` (ver [arriba](#2-un-tope-de-gasto-real-en-tokenscentavos-amount-conocido-solo-después-de-la-llamada)) — el mismo escenario ahora queda **dentro del presupuesto**.

### Breaking changes en 0.2.0

- **`subKey` ahora se valida.** Debe cumplir `[A-Za-z0-9_.-]`, tener 1–128 caracteres y no contener `:`. Un string vacío se rechaza (antes, `''` caía en silencio al contador global). Los subKeys que no cumplen y antes funcionaban ahora lanzan `BudgetCapError`. Normaliza los identificadores del lado del servidor.
- **`amount`/`limit`/`windowMs` están acotados** a `Number.MAX_SAFE_INTEGER`; valores por encima ahora lanzan en vez de corromper el contador en silencio.
- **`failOpen: false` ahora lanza un `BudgetCapError`** (con el error original en `cause`) en vez del error crudo de ioredis. Si hacías match sobre el mensaje de ioredis, lee `error.cause`.
- **Nuevo default `timeoutMs: 5000`.** Cada llamada a Redis ahora está acotada por un timeout de 5 s. Si tu Redis es legítimamente más lento, sube `timeoutMs` (o pon `0` para desactivarlo).

Nada del contador atómico ni del comportamiento de conteo de `checkAndIncrement` cambió — solo las adiciones de arriba y la validación.

---

## Desarrollo

```bash
npm install
npm run lint        # ESLint (typescript-eslint strict, type-checked)
npm run typecheck   # tsc --noEmit
npm test            # Vitest, un solo worker; los tests de atomicidad usan Redis real
npm run build       # tsup → ESM + CJS + tipos
```

Los tests de atomicidad necesitan un Redis real. Por defecto, los tests se conectan a `redis://127.0.0.1:6399` (Docker local en el puerto **6399**), mientras CI usa el puerto **6379**. Sobrescribe con `REDIS_URL`:

```bash
# Testing local (puerto recomendado para evitar colisión con CI)
docker run --rm -p 6399:6379 redis:7-alpine

# O sobrescribe al default de CI:
REDIS_URL=redis://127.0.0.1:6379 npm test
```

### Reproducir el PoC

El directorio `docs/poc/` contiene scripts de prueba de concepto que demuestran las mejoras en 0.2.0. Construye el paquete primero, luego ejecuta:

```bash
npm run build
npm run poc:overspend  # Muestra el patrón de 0.1.0 permitiendo 20× sobregasto
npm run poc:timeout    # Muestra la protección de timeout evitando cuelgues
```

---

## Enlaces del proyecto

- **npm:** [llm-budget-cap](https://www.npmjs.com/package/llm-budget-cap)
- **Repositorio:** [github.com/Rentheria/llm-budget-cap](https://github.com/Rentheria/llm-budget-cap)
- **Homepage:** Ve el [README](https://github.com/Rentheria/llm-budget-cap#readme) o pon una URL de homepage personalizada en la configuración del repositorio si es necesario.

---

## Licencia

MIT © Alejandro Rentheria
