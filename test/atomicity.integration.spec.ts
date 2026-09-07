import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { BudgetCap } from '../src/index';

/**
 * Real-Redis proof of the atomicity guarantee. Fires hundreds of concurrent
 * `checkAndIncrement` calls across several connections at a low cap and asserts
 * the cap is never exceeded — the property a naive GET+SET cannot hold.
 *
 * Needs a reachable Redis (REDIS_URL, default redis://127.0.0.1:6399). CI wires
 * up a redis service; locally run one (e.g. `docker run --rm -p 6399:6379
 * redis:7-alpine`). If Redis is unreachable the suite fails loudly rather than
 * silently skipping — this test is meant to run against a real server.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6399';

describe('BudgetCap — atomicidad contra Redis real', () => {
  let main: Redis;
  const spawned: Redis[] = [];

  const connect = (): Redis => {
    const client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    spawned.push(client);
    return client;
  };

  beforeAll(async () => {
    main = connect();
    await main.connect();
    await main.ping();
  });

  afterEach(async () => {
    await main.flushall();
  });

  afterAll(async () => {
    await Promise.all(spawned.map((client) => client.quit()));
  });

  it('debería_nunca_exceder_el_límite_con_cientos_de_requests_concurrentes', async () => {
    const limit = 50;
    const connections = 4;
    const callsPerConnection = 100; // 400 concurrent attempts
    const key = 'llm-budget-cap:test:concurrent';

    const caps = Array.from(
      { length: connections },
      () => new BudgetCap({ redis: connect(), key, limit, windowMs: 60_000 }),
    );

    const attempts = Array.from({ length: callsPerConnection }).flatMap(() =>
      caps.map((cap) => cap.checkAndIncrement()),
    );
    const decisions = await Promise.all(attempts);

    const allowed = decisions.filter((decision) => decision.allowed);
    const totalAttempts = connections * callsPerConnection;

    // Exactly `limit` calls may pass, never one more — the core guarantee.
    expect(allowed).toHaveLength(limit);
    // Every attempt was counted; the final counter equals the total attempts.
    expect(await main.get(key)).toBe(String(totalAttempts));
    // The allowed calls are precisely the first `limit` counts (1..limit).
    const allowedCounts = allowed
      .map((decision) => decision.count)
      .sort((a, b) => a - b);
    expect(allowedCounts).toStrictEqual(
      Array.from({ length: limit }, (_, i) => i + 1),
    );
  });

  it('debería_armar_el_TTL_en_la_primera_llamada_dentro_de_la_ventana', async () => {
    const key = 'llm-budget-cap:test:ttl';
    const windowMs = 60_000;
    const cap = new BudgetCap({ redis: connect(), key, limit: 10, windowMs });

    await cap.checkAndIncrement();

    const ttl = await main.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(windowMs);
  });

  it('debería_no_extender_el_TTL_en_llamadas_posteriores', async () => {
    const key = 'llm-budget-cap:test:fixed-window';
    const windowMs = 60_000;
    const cap = new BudgetCap({ redis: connect(), key, limit: 10, windowMs });

    await cap.checkAndIncrement();
    const firstTtl = await main.pttl(key);
    await cap.checkAndIncrement();
    const secondTtl = await main.pttl(key);

    // Fixed window from the first hit: later calls never re-arm the TTL.
    expect(secondTtl).toBeLessThanOrEqual(firstTtl);
  });

  it('debería_aislar_por_subKey_contra_Redis_real', async () => {
    const cap = new BudgetCap({
      redis: connect(),
      key: 'llm-budget-cap:test:tenant',
      limit: 1,
      windowMs: 60_000,
    });

    const a = await cap.checkAndIncrement('acme');
    const b = await cap.checkAndIncrement('globex');
    const aAgain = await cap.checkAndIncrement('acme');

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(aAgain.allowed).toBe(false); // acme's own window is spent
  });

  it('debería_topar_por_reserva_bajo_concurrencia_sin_pasarse_del_presupuesto', async () => {
    // Reproducción del PoC de sobregasto, ahora con el patrón reserve/settle:
    // el gasto real NUNCA debe pasar el límite (antes: 20 000 con limit=1000).
    const limit = 1000;
    const tokensPerCall = 400;
    const concurrency = 50;
    const key = 'llm-budget-cap:test:reserve-cap';

    const caps = Array.from(
      { length: 4 },
      () => new BudgetCap({ redis: connect(), key, limit, windowMs: 60_000 }),
    );

    let tokensReallySpent = 0;

    const handler = async (i: number): Promise<void> => {
      const cap = caps[i % caps.length];
      if (cap === undefined) return;
      // 1) Reservar ANTES de la llamada de pago.
      const reservation = await cap.reserve(undefined, tokensPerCall);
      if (!reservation.allowed) return; // topado: no se hace la llamada de pago
      // 2) Llamada de pago (aquí sí se gasta el dinero).
      tokensReallySpent += tokensPerCall;
      // 3) Liquidar con el costo real (aquí = estimado).
      await cap.settle(reservation, tokensPerCall);
    };

    await Promise.all(
      Array.from({ length: concurrency }, (_, i) => handler(i)),
    );

    // El gasto real cae DENTRO del presupuesto (nunca 20×).
    expect(tokensReallySpent).toBeLessThanOrEqual(limit);
  });

  it('debería_reembolsar_el_estimado_no_usado_al_liquidar_contra_Redis_real', async () => {
    const key = 'llm-budget-cap:test:settle';
    const cap = new BudgetCap({
      redis: connect(),
      key,
      limit: 1000,
      windowMs: 60_000,
    });

    const reservation = await cap.reserve(undefined, 400);
    expect(await main.get(key)).toBe('400');

    await cap.settle(reservation, 120); // gastó menos de lo reservado
    expect(await main.get(key)).toBe('120');

    // El TTL de la ventana no se extiende al liquidar.
    const ttl = await main.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
