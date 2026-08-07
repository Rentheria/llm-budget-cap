import { describe, expect, it } from 'vitest';

import { BudgetCap, BudgetCapError } from '../src/index';
import type { RedisEvalClient } from '../src/index';

import { FailingRedis, FakeRedis, HangingRedis } from './support/fake-redis';

describe('BudgetCap.checkAndIncrement', () => {
  it('debería_permitir_las_operaciones_hasta_el_límite_y_bloquear_el_resto', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:global', limit: 3 });

    const first = await cap.checkAndIncrement();
    const second = await cap.checkAndIncrement();
    const third = await cap.checkAndIncrement();
    const fourth = await cap.checkAndIncrement();

    expect([first, second, third].every((d) => d.allowed)).toBe(true);
    expect(fourth.allowed).toBe(false);
  });

  it('debería_reportar_count_remaining_y_limit_en_cada_decisión', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:global', limit: 2 });

    const decision = await cap.checkAndIncrement();

    expect(decision).toStrictEqual({
      allowed: true,
      count: 1,
      limit: 2,
      remaining: 1,
      degraded: false,
    });
  });

  it('debería_no_dejar_remaining_negativo_cuando_ya_se_pasó_el_límite', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:global', limit: 1 });

    await cap.checkAndIncrement();
    const overLimit = await cap.checkAndIncrement();

    expect(overLimit.allowed).toBe(false);
    expect(overLimit.remaining).toBe(0);
    expect(overLimit.count).toBe(2);
  });

  it('debería_aislar_los_contadores_por_subKey', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:tenant', limit: 1 });

    const tenantA = await cap.checkAndIncrement('tenant-a');
    const tenantB = await cap.checkAndIncrement('tenant-b');

    expect(tenantA.allowed).toBe(true);
    expect(tenantB.allowed).toBe(true);
    expect(redis.valueOf('spend:tenant:tenant-a')).toBe(1);
    expect(redis.valueOf('spend:tenant:tenant-b')).toBe(1);
  });

  it('debería_usar_la_ventana_por_defecto_de_24h_cuando_no_se_configura', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:global', limit: 1 });

    await cap.checkAndIncrement();

    expect(redis.lastWindowMs).toBe(24 * 60 * 60 * 1000);
  });

  it('debería_pasar_la_ventana_configurada_al_script', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({
      redis,
      key: 'spend:global',
      limit: 1,
      windowMs: 60_000,
    });

    await cap.checkAndIncrement();

    expect(redis.lastWindowMs).toBe(60_000);
  });

  it('debería_reiniciar_el_contador_cuando_la_ventana_expira', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({
      redis,
      key: 'spend:global',
      limit: 1,
      windowMs: 1_000,
    });

    const before = await cap.checkAndIncrement();
    expect(before.allowed).toBe(true);
    const blocked = await cap.checkAndIncrement();
    expect(blocked.allowed).toBe(false);

    redis.now += 1_001; // the window elapses

    const afterReset = await cap.checkAndIncrement();
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.count).toBe(1);
  });

  it('debería_incrementar_por_el_amount_dado_en_vez_de_1_por_llamada', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:tokens', limit: 1000 });

    const first = await cap.checkAndIncrement(undefined, 350);
    const second = await cap.checkAndIncrement(undefined, 700);

    expect(first).toStrictEqual({
      allowed: true,
      count: 350,
      limit: 1000,
      remaining: 650,
      degraded: false,
    });
    expect(second.allowed).toBe(false);
    expect(second.count).toBe(1050);
    expect(second.remaining).toBe(0);
  });

  it('debería_mantener_amount_por_defecto_en_1_cuando_se_omite', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:global', limit: 5 });

    const decision = await cap.checkAndIncrement();

    expect(decision.count).toBe(1);
  });

  it('debería_rechazar_un_amount_menor_a_uno', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(cap.checkAndIncrement(undefined, 0)).rejects.toThrow(
      BudgetCapError,
    );
  });

  it('debería_rechazar_un_amount_no_entero', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(cap.checkAndIncrement(undefined, 2.5)).rejects.toThrow(
      BudgetCapError,
    );
  });

  it('debería_fallar_abierto_por_defecto_cuando_Redis_está_caído', async () => {
    const cap = new BudgetCap({
      redis: new FailingRedis(),
      key: 'x',
      limit: 1,
    });

    const decision = await cap.checkAndIncrement();

    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  it('debería_fallar_cerrado_cuando_failOpen_es_false_y_Redis_está_caído', async () => {
    const cap = new BudgetCap({
      redis: new FailingRedis(),
      key: 'x',
      limit: 1,
      failOpen: false,
    });

    // El error se envuelve en BudgetCapError (mensaje estático, sin la key), pero
    // el error original de ioredis queda accesible en `cause` para depurar.
    const error = await cap.checkAndIncrement().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BudgetCapError);
    const cause = (error as BudgetCapError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain('Redis is down');
  });

  it('debería_llamar_onDegraded_con_el_error_cuando_falla_abierto', async () => {
    const errors: unknown[] = [];
    const cap = new BudgetCap({
      redis: new FailingRedis(),
      key: 'x',
      limit: 1,
      onDegraded: (error) => errors.push(error),
    });

    const decision = await cap.checkAndIncrement();

    expect(decision.degraded).toBe(true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('Redis is down');
  });

  it('debería_no_romper_el_request_si_onDegraded_lanza', async () => {
    const cap = new BudgetCap({
      redis: new FailingRedis(),
      key: 'x',
      limit: 1,
      onDegraded: () => {
        throw new Error('hook roto');
      },
    });

    const decision = await cap.checkAndIncrement();

    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
  });

  it('debería_degradar_dentro_del_timeout_cuando_Redis_se_cuelga', async () => {
    const cap = new BudgetCap({
      redis: new HangingRedis(),
      key: 'x',
      limit: 1,
      timeoutMs: 50,
    });

    const started = Date.now();
    const decision = await cap.checkAndIncrement();
    const elapsed = Date.now() - started;

    expect(decision.degraded).toBe(true);
    expect(decision.allowed).toBe(true);
    expect(elapsed).toBeLessThan(1000); // decidió por timeout, no colgado
  });

  it('debería_fallar_cerrado_por_timeout_cuando_failOpen_es_false', async () => {
    const cap = new BudgetCap({
      redis: new HangingRedis(),
      key: 'x',
      limit: 1,
      timeoutMs: 50,
      failOpen: false,
    });

    await expect(cap.checkAndIncrement()).rejects.toThrow(BudgetCapError);
  });

  it('debería_rechazar_un_amount_por_encima_de_MAX_SAFE_INTEGER', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(
      cap.checkAndIncrement(undefined, Number.MAX_SAFE_INTEGER + 1),
    ).rejects.toThrow(BudgetCapError);
  });

  it('debería_tratar_un_count_negativo_de_Redis_como_error', async () => {
    // Simula el desbordamiento int64: Redis devuelve un entero negativo.
    const negativeRedis: RedisEvalClient = {
      eval: () => Promise.resolve(-9223372036854778000),
    };
    const cap = new BudgetCap({
      redis: negativeRedis,
      key: 'x',
      limit: 10,
      failOpen: false,
    });

    // No debe devolver allowed:true con degraded:false: debe fallar.
    await expect(cap.checkAndIncrement()).rejects.toThrow(BudgetCapError);
  });
});

describe('BudgetCap.reserve + settle', () => {
  it('debería_reservar_antes_de_la_llamada_y_topar_por_reserva', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:tokens', limit: 1000 });

    const r1 = await cap.reserve(undefined, 400);
    const r2 = await cap.reserve(undefined, 400);
    const r3 = await cap.reserve(undefined, 400); // 1200 > 1000 → bloqueada

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    expect(r1.reserved).toBe(400);
  });

  it('debería_devolver_el_estimado_no_usado_al_liquidar_de_menos', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:tokens', limit: 1000 });

    const reservation = await cap.reserve(undefined, 400); // reserva 400
    expect(redis.valueOf('spend:tokens')).toBe(400);

    const settled = await cap.settle(reservation, 150); // gastó solo 150
    expect(settled.count).toBe(150);
    expect(redis.valueOf('spend:tokens')).toBe(150);
    expect(settled.remaining).toBe(850);
  });

  it('debería_cobrar_la_diferencia_al_liquidar_de_más', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:tokens', limit: 1000 });

    const reservation = await cap.reserve(undefined, 400);
    const settled = await cap.settle(reservation, 700); // costó más de lo estimado

    expect(settled.count).toBe(700);
    expect(redis.valueOf('spend:tokens')).toBe(700);
  });

  it('debería_liquidar_por_subKey_en_el_contador_correcto', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:user', limit: 1000 });

    const reservation = await cap.reserve('alice', 500);
    await cap.settle(reservation, 100);

    expect(redis.valueOf('spend:user:alice')).toBe(100);
  });

  it('debería_no_dejar_el_contador_por_debajo_de_cero_al_reembolsar', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'spend:tokens', limit: 1000 });

    const reservation = await cap.reserve(undefined, 100);
    const settled = await cap.settle(reservation, 0); // reembolso total

    expect(settled.count).toBe(0);
    expect(redis.valueOf('spend:tokens')).toBe(0);
  });

  it('debería_ser_no_op_al_liquidar_una_reserva_degradada', async () => {
    const cap = new BudgetCap({ redis: new FailingRedis(), key: 'x', limit: 1 });

    const reservation = await cap.reserve(undefined, 5);
    expect(reservation.degraded).toBe(true);

    const settled = await cap.settle(reservation, 3);
    expect(settled.degraded).toBe(true);
  });

  it('debería_ser_no_op_al_liquidar_si_la_ventana_ya_expiró', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({
      redis,
      key: 'spend:tokens',
      limit: 1000,
      windowMs: 1_000,
    });

    const reservation = await cap.reserve(undefined, 400);
    redis.now += 1_001; // la ventana expira antes de liquidar

    const settled = await cap.settle(reservation, 150);
    expect(settled.count).toBe(0); // nada que liquidar; ventana nueva limpia
    expect(redis.valueOf('spend:tokens')).toBe(0);
  });

  it('debería_rechazar_un_realCost_negativo', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'x', limit: 10 });
    const reservation = await cap.reserve(undefined, 5);

    await expect(cap.settle(reservation, -1)).rejects.toThrow(BudgetCapError);
  });

  it('debería_rechazar_un_estimate_menor_a_uno', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(cap.reserve(undefined, 0)).rejects.toThrow(BudgetCapError);
  });
});

describe('BudgetCap validación de subKey', () => {
  it('debería_rechazar_un_subKey_vacío_en_vez_de_caer_al_global', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(cap.checkAndIncrement('')).rejects.toThrow(BudgetCapError);
  });

  it('debería_rechazar_un_subKey_con_dos_puntos', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(cap.checkAndIncrement('tenant:acme')).rejects.toThrow(
      BudgetCapError,
    );
  });

  it('debería_rechazar_un_subKey_con_espacios_o_saltos_de_línea', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(cap.checkAndIncrement('u1 ')).rejects.toThrow(BudgetCapError);
    await expect(cap.checkAndIncrement('u1\n')).rejects.toThrow(BudgetCapError);
  });

  it('debería_rechazar_un_subKey_demasiado_largo', async () => {
    const cap = new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 1 });

    await expect(cap.checkAndIncrement('a'.repeat(129))).rejects.toThrow(
      BudgetCapError,
    );
  });

  it('debería_aceptar_un_subKey_normalizado', async () => {
    const redis = new FakeRedis();
    const cap = new BudgetCap({ redis, key: 'x', limit: 5 });

    const decision = await cap.checkAndIncrement('user_42.eu-west');

    expect(decision.allowed).toBe(true);
    expect(redis.valueOf('x:user_42.eu-west')).toBe(1);
  });
});

describe('BudgetCap constructor', () => {
  it('debería_rechazar_un_cliente_redis_sin_eval', () => {
    expect(
      () =>
        // @ts-expect-error probando validación en runtime con un cliente inválido
        new BudgetCap({ redis: {}, key: 'x', limit: 1 }),
    ).toThrow(BudgetCapError);
  });

  it('debería_rechazar_una_key_vacía', () => {
    expect(
      () => new BudgetCap({ redis: new FakeRedis(), key: '   ', limit: 1 }),
    ).toThrow(BudgetCapError);
  });

  it('debería_rechazar_un_límite_menor_a_uno', () => {
    expect(
      () => new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 0 }),
    ).toThrow(BudgetCapError);
  });

  it('debería_rechazar_un_límite_no_entero', () => {
    expect(
      () => new BudgetCap({ redis: new FakeRedis(), key: 'x', limit: 2.5 }),
    ).toThrow(BudgetCapError);
  });

  it('debería_rechazar_una_ventana_menor_a_uno', () => {
    expect(
      () =>
        new BudgetCap({
          redis: new FakeRedis(),
          key: 'x',
          limit: 1,
          windowMs: 0,
        }),
    ).toThrow(BudgetCapError);
  });
});
