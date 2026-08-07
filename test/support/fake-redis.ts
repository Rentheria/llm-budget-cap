import {
  ATOMIC_BUDGET_CAP_LUA,
  SETTLE_BUDGET_CAP_LUA,
  type RedisEvalClient,
} from '../../src/index';

interface CounterEntry {
  value: number;
  /** Absolute expiry in the fake clock's ms, or null when no TTL is armed. */
  expireAt: number | null;
}

/**
 * In-memory boundary stub that reproduces the exact semantics of both Lua
 * scripts (the atomic INCR+PTTL+conditional-PEXPIRE, and the settle) against a
 * controllable clock. It lets the unit tests exercise BudgetCap's real decision
 * logic without a live Redis; atomicity itself is proven against a real Redis in
 * `atomicity.integration.spec.ts`.
 */
export class FakeRedis implements RedisEvalClient {
  private readonly store = new Map<string, CounterEntry>();

  /** Controllable clock (ms). Advance it to simulate the window elapsing. */
  public now = 0;

  /** Number of eval() calls received — lets tests assert the boundary usage. */
  public evalCalls = 0;

  /** Last (key, windowMs) the increment script was called with. */
  public lastKey: string | undefined;
  public lastWindowMs: number | undefined;

  eval(
    script: string,
    _numKeys: number,
    ...args: (string | number)[]
  ): Promise<number | [number, number]> {
    this.evalCalls += 1;
    const key = String(args[0]);

    if (script === SETTLE_BUDGET_CAP_LUA) {
      return Promise.resolve(this.settle(key, Number(args[1])));
    }
    if (script === ATOMIC_BUDGET_CAP_LUA) {
      return Promise.resolve(
        this.increment(key, Number(args[1]), Number(args[2] ?? 1)),
      );
    }
    return Promise.reject(new Error('FakeRedis: unknown script'));
  }

  private increment(key: string, windowMs: number, amount: number): number {
    this.lastKey = key;
    this.lastWindowMs = windowMs;

    const entry = this.live(key) ?? { value: 0, expireAt: null };
    entry.value += amount; // INCRBY
    this.store.set(key, entry);

    const ttl = entry.expireAt === null ? -1 : entry.expireAt - this.now; // PTTL
    if (entry.value === amount || ttl < 0) {
      entry.expireAt = this.now + windowMs; // PEXPIRE
    }
    return entry.value;
  }

  private settle(key: string, delta: number): [number, number] {
    const entry = this.live(key);
    if (entry === undefined) {
      return [0, 0]; // key gone: nothing to settle
    }
    entry.value += delta; // INCRBY (signed) — TTL untouched
    if (entry.value < 0) {
      entry.value = 0; // clamp, keep existing TTL
    }
    this.store.set(key, entry);
    return [1, entry.value];
  }

  /** Current post-expiry value of a key (0 if absent/expired). */
  valueOf(key: string): number {
    return this.live(key)?.value ?? 0;
  }

  private live(key: string): CounterEntry | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expireAt !== null && entry.expireAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }
}

/** A client whose eval() always rejects — for fail-open / fail-closed tests. */
export class FailingRedis implements RedisEvalClient {
  eval(): Promise<never> {
    return Promise.reject(new Error('ECONNREFUSED: Redis is down'));
  }
}

/** A client whose eval() never settles — for timeout tests (simulates a hang). */
export class HangingRedis implements RedisEvalClient {
  eval(): Promise<never> {
    return new Promise<never>(() => {
      // never resolves nor rejects — mimics ioredis offline-queue on a dead Redis
    });
  }
}
