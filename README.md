# llm-budget-cap

[![CI](https://github.com/Rentheria/llm-budget-cap/actions/workflows/ci.yml/badge.svg)](https://github.com/Rentheria/llm-budget-cap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/llm-budget-cap.svg)](https://www.npmjs.com/package/llm-budget-cap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

_[Español](README.es.md)_

**Atomic Redis spend cap for LLM APIs (OpenAI, Gemini, Anthropic, …).**

> **See also:** [chatarmor](https://github.com/Rentheria/chatarmor) — conversational AI safety toolkit.
> An `INCR` + `PEXPIRE` counter that runs **entirely inside a single Lua script**, so a bug or abuse can't quietly bleed money out of your AI API bill.

- ⚛️ **Truly atomic.** Increment + TTL-arm in one Lua execution: two near-simultaneous requests near the limit **cannot both slip through**. A `GET` + `SET` can (explained below).
- 🧮 **Reserve → settle for a real spend cap.** Reserve an estimate **before** the paid call (this is what caps), then settle the real cost afterwards (refund the unused estimate, or charge the overage). The decision happens **before** the money is spent.
- ⏱️ **Real degraded mode.** A hard per-call `timeoutMs`: if Redis hangs, the call is decided (fail-open or fail-closed) within the budget instead of hanging the request.
- 🎯 **Small and focused.** One class. Zero third-party deps (just the `ioredis` client you already have).
- 🕒 **Configurable fixed window.** 24h by default; any window in milliseconds.
- 🔑 **One global counter or one per key** (per tenant, per user).

> ⚠️ **Upgrading from 0.1.0?** The old "count after the call" pattern the README used to show **did not cap anything** under concurrency. See [Migrating from 0.1.0](#migrating-from-010). Use `reserve`/`settle`.

---

## Why it exists (the honest story)

We built this because we needed to cap an AI chatbot's spend **without a bug letting it bleed money**. You wire an assistant on top of Gemini/OpenAI, everything's fine in testing, and one day a loop, a scraper, or a distributed client with a thousand IPs spikes your bill to thousands of dollars while you sleep.

The fix we ended up shipping in production was always the same: a Redis counter that accrues spend within a window (24h) and cuts off once the limit is passed. Two subtle parts give the guarantee:

1. The `INCR` and the `PEXPIRE` must run **atomically**, or two requests arriving at the same instant right at the limit both slip through.
2. The **decision must happen before the paid call**, or the money is already spent by the time you find out. That's what `reserve`/`settle` is for.

It's not a general-purpose rate limiter (for that, there's `@nestjs/throttler`, `rate-limiter-flexible`, etc.). It's a **spend cap**: a hard, cheap safety net against surprise bills.

---

## Install

```bash
npm install llm-budget-cap ioredis
```

`ioredis` is a **peer dependency** (bring your own Redis client). Works with Express, Fastify, NestJS, or anything else — no framework dependency.

### Recommended Redis client config

```ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL, {
  enableOfflineQueue: false, // a dead Redis errors immediately instead of queueing forever
  maxRetriesPerRequest: 2, // don't hang the request path retrying a down server
});
```

`llm-budget-cap` also applies its own `timeoutMs` (default **5000 ms**) around every Redis call, so degraded mode works even if you forget these — but setting them makes failures fast and clean.

---

## Usage

### 1. Cap the number of calls (amount known before the call)

When you just want to cap **how many** calls happen (or the cost is a fixed amount you know up front), a single atomic `checkAndIncrement` before the paid call is enough:

```ts
import { BudgetCap } from 'llm-budget-cap';

// At most 500 LLM calls every 24h (default window).
const cap = new BudgetCap({ redis, key: 'gemini:daily', limit: 500 });

const decision = await cap.checkAndIncrement();
if (!decision.allowed) {
  return res.status(429).json({ error: 'Daily AI budget exhausted.' });
}

const answer = await callGemini(userMessage); // your paid call, now protected
```

### 2. A real spend cap in tokens/cents (amount known only after the call)

Token/cost is only known **after** the call — so you must **reserve an estimate first** (that's the decision that caps), make the call, then **settle** with the real cost. Settling refunds the unused estimate or charges the overage:

```ts
const cap = new BudgetCap({ redis, key: 'gemini:tokens', limit: 1_000_000 });

// 1. Reserve an estimate BEFORE the paid call. This is what caps.
const reservation = await cap.reserve(userId, estimatedTokens);
if (!reservation.allowed) {
  return res.status(429).json({ error: 'Token budget exhausted.' });
}

// 2. Make the paid call.
const response = await callGemini(userMessage);

// 3. Settle with the real cost — refunds the difference (or charges the overage).
await cap.settle(reservation, response.usage.totalTokens);
```

Reserve at or above the typical real cost, so the cap errs on the safe side in the window between reserve and settle. If the call throws before you settle, the reservation simply stays counted until the window expires — the cap stays conservative, never permissive.

### A cap per user / tenant

```ts
const cap = new BudgetCap({
  redis,
  key: 'gemini:user', // combined as `gemini:user:<subKey>`
  limit: 50,
  windowMs: 60 * 60 * 1000, // 1 hour
});

const decision = await cap.checkAndIncrement(userId);
if (!decision.allowed) {
  // this particular user already spent their hourly quota
}
```

A `subKey` must be a **normalized, server-side identifier**: `[A-Za-z0-9_.-]`, 1–128 characters, no `:`. Never pass a raw request header (e.g. `X-Forwarded-For`) — normalize it first, or an attacker picks their own budget bucket.

---

## Why Lua-atomic instead of `GET` + `SET`

The naive approach has a **race condition**:

```ts
// ❌ UNSAFE: there is a window between the GET and the SET
const count = Number(await redis.get(key)) || 0;
if (count >= limit) return blocked();
await redis.set(key, count + 1); // ⬅️ another request may have read the SAME count
```

With the limit at 500 and the counter at 499, if **two requests arrive almost at the same time**:

1. Request A does `GET` → reads `499`. Decides: `499 < 500`, proceeds.
2. Request B does `GET` → reads `499` (A hasn't written yet). Decides: `499 < 500`, proceeds.
3. A writes `500`. B writes `500`.

**Both got through.** Redis's `INCR` is atomic, but the real problem is **coordinating the `INCR` with setting the TTL** (`PEXPIRE`). The fix is to put **everything inside a single Lua script**, which Redis runs start to finish without interleaving other commands:

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

Every `checkAndIncrement`/`reserve` gets a unique, increasing `current`, and the TTL is always armed on the window's first call. (It uses `PTTL`/`PEXPIRE` instead of `PEXPIRE ... NX`, so it also works on Redis < 7.) The exact scripts are exported as `ATOMIC_BUDGET_CAP_LUA` and `SETTLE_BUDGET_CAP_LUA` in case you want to audit or reuse them.

---

## API

### `new BudgetCap(options)`

| Option       | Type                       | Default            | Description                                                                                  |
| ------------ | -------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `redis`      | `RedisEvalClient`          | —                  | ioredis-compatible client (`eval(script, numKeys, ...args)`).                                |
| `key`        | `string`                   | —                  | Base counter key. With a `subKey` it's combined as `key:subKey`.                             |
| `limit`      | `number`                   | —                  | Max spend/usage allowed per window (integer 1…`Number.MAX_SAFE_INTEGER`).                    |
| `windowMs`   | `number`                   | `86_400_000` (24h) | Fixed window length in ms, counted from the first hit.                                       |
| `failOpen`   | `boolean`                  | `true`             | If Redis fails/times out, let the operation through (degraded) or throw?                     |
| `timeoutMs`  | `number`                   | `5000`             | Hard timeout per Redis call. If Redis doesn't answer in time, `failOpen` decides. `0` = off. |
| `onDegraded` | `(error: unknown) => void` | —                  | Called with the error whenever a call degrades (fail-open). Alert/meter here.                |

### `checkAndIncrement(subKey?, amount?)` → `Promise<BudgetCapDecision>`

Atomically increments the counter and returns the decision. Use it when `amount` is known **before** the paid call (a plain call count — default `amount: 1` — or a fixed per-call cost).

### `reserve(subKey?, estimate?)` → `Promise<BudgetCapReservation>`

Reserves `estimate` (default `1`) **before** the paid call and returns a decision (check `.allowed`) that doubles as a handle for `settle`. This is the decision that caps.

### `settle(reservation, realCost)` → `Promise<BudgetCapDecision>`

Applies `realCost - reserved` to the same counter atomically (refund or overage), without extending the window. Safe to call on a degraded reservation or after the window elapsed (both are no-ops). `realCost` is an integer ≥ 0.

```ts
interface BudgetCapDecision {
  allowed: boolean; // true if you can proceed (count <= limit)
  count: number; // counter value AFTER this operation (0 if degraded)
  limit: number; // the configured limit
  remaining: number; // spend left: max(0, limit - count)
  degraded: boolean; // true if Redis failed/timed out and this is a fail-open fallback
}

interface BudgetCapReservation extends BudgetCapDecision {
  subKey: string | undefined; // for settle
  reserved: number; // for settle
}
```

### Fail-open vs fail-closed

By default (`failOpen: true`), if Redis is unreachable or slower than `timeoutMs`, calls return `{ allowed: true, degraded: true }` instead of throwing: we'd rather have a paid feature go briefly unmetered during a Redis outage than take the whole feature down. **Alert on `degraded === true`** (pass `onDegraded`) — a silent degraded cap is a cap that isn't there. With `failOpen: false` a `BudgetCapError` is thrown (the underlying error is its `cause`), and you decide.

### node-redis instead of ioredis

The library only needs an `eval(script, numKeys, ...args)` method. node-redis (v4)'s `eval` has a different signature; wrap it:

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

## Deployment requirements

The counter lives **only in Redis**, so the cap is **best-effort** against anything that drops the key:

- **Use `maxmemory-policy noeviction`** (or a dedicated Redis instance) for the cap's key. Under `allkeys-lru`/`allkeys-lfu` the budget key is as evictable as any cache entry — the cap silently resets mid-window.
- The cap does **not** survive `FLUSHALL`, eviction, or an async-replica failover that loses unreplicated increments. Treat it as a safety net, not an accounting ledger. If you need exact spend accounting, record it in your database; this is the cheap ceiling in front of it.
- Give the key an **app/env prefix** (`key: 'myapp:prod:gemini:daily'`) so it can't collide with another counter on a shared Redis.

### Production checklist

Before deploying:

1. **Alert on degraded mode.** Pass `onDegraded` to log/metric/alert whenever a Redis failure triggers fail-open. A silent degraded cap is a cap that isn't there.
2. **Review fail-open strategy.** The default (`failOpen: true`) lets requests through when Redis fails — you'd rather have a paid feature go unmetered briefly than take it down entirely. If your use case demands a hard boundary, set `failOpen: false` and handle the thrown `BudgetCapError`.
3. **Check ioredis timeouts.** Set `enableOfflineQueue: false` and `maxRetriesPerRequest: 2` so a dead Redis errors immediately instead of queueing or retrying indefinitely.
4. **Verify `REDIS_URL`.** Local development typically uses port **6399** (`redis://127.0.0.1:6399`), while CI/production usually use **6379**. Set the environment variable explicitly to avoid confusion.

---

## Migrating from 0.1.0

**0.1.0 taught a pattern that did not cap anything.** The old README showed calling the LLM first and `checkAndIncrement(undefined, tokens)` after:

```ts
// ❌ 0.1.0 — the decision arrives AFTER the money is spent.
const response = await callGemini(userMessage);
const decision = await cap.checkAndIncrement(
  undefined,
  response.usage.totalTokens,
);
if (!decision.allowed) {
  /* too late — the call already happened */
}
```

Under concurrency this let spend blow far past the limit (measured: `limit=1000`, 50 concurrent 400-token calls → **20,000 tokens spent, 20×** the budget). Replace it with `reserve` + `settle` (see [above](#2-a-real-spend-cap-in-tokenscents-amount-known-only-after-the-call)) — the same scenario now stays **within budget**.

### Breaking changes in 0.2.0

- **`subKey` is now validated.** It must match `[A-Za-z0-9_.-]`, be 1–128 chars, and contain no `:`. An empty string is rejected (before, `''` silently fell through to the global counter). Non-conforming subKeys that used to work now throw `BudgetCapError`. Normalize identifiers server-side.
- **`amount`/`limit`/`windowMs` are bounded** to `Number.MAX_SAFE_INTEGER`; values above it now throw instead of silently corrupting the counter.
- **`failOpen: false` now throws a `BudgetCapError`** (with the original error as `cause`) instead of the raw ioredis error. If you were matching on the ioredis error message, read `error.cause`.
- **New default `timeoutMs: 5000`.** Every Redis call is now bounded by a 5 s timeout. If your Redis is legitimately slower than that, raise `timeoutMs` (or set `0` to disable).

Nothing about the atomic counter or `checkAndIncrement`'s call-count behavior changed — only the additions above and the validation.

---

## Development

```bash
npm install
npm run lint        # ESLint (typescript-eslint strict, type-checked)
npm run typecheck   # tsc --noEmit
npm test            # Vitest, single worker; atomicity tests use real Redis
npm run build       # tsup → ESM + CJS + types
```

The atomicity tests need a real Redis. By default, tests connect to `redis://127.0.0.1:6399` (local Docker on port **6399**), while CI uses port **6379**. Override with `REDIS_URL`:

```bash
# Local testing (recommended port to avoid CI collision)
docker run --rm -p 6399:6379 redis:7-alpine

# Or override to CI's default:
REDIS_URL=redis://127.0.0.1:6379 npm test
```

### Reproduce the PoC

The `docs/poc/` directory contains proof-of-concept scripts demonstrating the improvements in 0.2.0. Build the package first, then run:

```bash
npm run build
npm run poc:overspend  # Shows the 0.1.0 pattern allowing 20× overspend
npm run poc:timeout    # Shows timeout protection preventing hangs
```

---

## Project Links

- **npm:** [llm-budget-cap](https://www.npmjs.com/package/llm-budget-cap)
- **Repository:** [github.com/Rentheria/llm-budget-cap](https://github.com/Rentheria/llm-budget-cap)
- **Homepage:** View the [README](https://github.com/Rentheria/llm-budget-cap#readme) or set a custom homepage URL in the repository settings if needed.

---

## License

MIT © Alejandro Rentheria
