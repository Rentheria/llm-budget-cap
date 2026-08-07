import { BudgetCapError } from './errors';
import { ATOMIC_BUDGET_CAP_LUA, SETTLE_BUDGET_CAP_LUA } from './lua';
import type {
  BudgetCapDecision,
  BudgetCapOptions,
  BudgetCapReservation,
  RedisEvalClient,
} from './types';

/** 24 hours in milliseconds — the default fixed window. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default hard timeout for each Redis operation (see {@link BudgetCapOptions.timeoutMs}). */
const DEFAULT_TIMEOUT_MS = 5000;

/** Max length of a `subKey`. Keeps Redis keys bounded and predictable. */
const MAX_SUBKEY_LENGTH = 128;

/**
 * Allowed characters in a `subKey`. Deliberately excludes `:` so a caller-fed
 * subKey cannot collide with the base key's namespace, and excludes whitespace
 * so `'u1'` and `'u1 '` cannot become two independent budgets.
 */
const SUBKEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Atomic spend/usage ceiling backed by a single Redis key.
 *
 * Two ways to use it:
 *
 * - {@link reserve} + {@link settle} — the safe path for a real spend cap.
 *   Reserve an estimate BEFORE the paid call (this is what actually caps), make
 *   the call, then settle the real cost. Because the decision happens before the
 *   money is spent, concurrent traffic can never blow past the limit.
 * - {@link checkAndIncrement} — a single atomic increment + decision, for when
 *   the amount is already known before the paid call (e.g. a plain call count).
 *
 * Each operation runs one Lua script that mutates the counter and arms its TTL
 * atomically (see {@link ATOMIC_BUDGET_CAP_LUA}). Two near-simultaneous requests
 * close to the cap can never both slip through — the guarantee a naive
 * `GET` + `SET` cannot make.
 *
 * The increment happens BEFORE the decision: a blocked call still counts toward
 * the window, but blocked calls do NOT extend the TTL (the window is FIXED from
 * the first hit, not sliding). This is intentional — it makes the cap a hard
 * ceiling on spend within the window.
 */
export class BudgetCap {
  private readonly redis: RedisEvalClient;
  private readonly key: string;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly failOpen: boolean;
  private readonly timeoutMs: number;
  private readonly onDegraded: ((error: unknown) => void) | undefined;

  constructor(options: BudgetCapOptions) {
    // Validate the client at the boundary via `unknown`: the static type says it
    // is always valid, but a plain-JS caller can pass anything.
    const candidate: unknown = options.redis;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('eval' in candidate) ||
      typeof candidate.eval !== 'function'
    ) {
      throw new BudgetCapError(
        'options.redis must be an ioredis-compatible client with an eval() method.',
      );
    }
    if (typeof options.key !== 'string' || options.key.trim() === '') {
      throw new BudgetCapError('options.key must be a non-empty string.');
    }
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > Number.MAX_SAFE_INTEGER
    ) {
      throw new BudgetCapError(
        'options.limit must be an integer between 1 and Number.MAX_SAFE_INTEGER.',
      );
    }
    if (
      options.windowMs !== undefined &&
      (!Number.isInteger(options.windowMs) ||
        options.windowMs < 1 ||
        options.windowMs > Number.MAX_SAFE_INTEGER)
    ) {
      throw new BudgetCapError(
        'options.windowMs must be an integer between 1 and Number.MAX_SAFE_INTEGER when provided.',
      );
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0)
    ) {
      throw new BudgetCapError(
        'options.timeoutMs must be an integer >= 0 when provided (0 disables the timeout).',
      );
    }
    if (
      options.onDegraded !== undefined &&
      typeof options.onDegraded !== 'function'
    ) {
      throw new BudgetCapError(
        'options.onDegraded must be a function when provided.',
      );
    }

    this.redis = options.redis;
    this.key = options.key;
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.failOpen = options.failOpen ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onDegraded = options.onDegraded;
  }

  /**
   * Atomically increment the counter and report whether the caller may proceed.
   *
   * Use this when the amount is known BEFORE the paid call — a plain call count
   * (default `amount: 1`), or a fixed per-call cost. For a real token/cost cap
   * where the amount is only known AFTER the call, use {@link reserve} +
   * {@link settle} instead: incrementing after the paid call does not cap
   * anything under concurrency.
   *
   * @param subKey Optional suffix appended as `${key}:${subKey}` — use it for a
   *   per-tenant / per-user cap that shares one {@link BudgetCap} instance. Must
   *   be a normalized, server-side identifier: `[A-Za-z0-9_.-]`, 1–128 chars, no
   *   `:`. Omit it (or pass `undefined`) for a single global counter. Never pass
   *   a raw request header.
   * @param amount How much to add for this call. Defaults to `1`. Must be an
   *   integer between 1 and Number.MAX_SAFE_INTEGER.
   */
  async checkAndIncrement(
    subKey?: string,
    amount = 1,
  ): Promise<BudgetCapDecision> {
    validateAmount(amount, 'amount');
    return this.increment(this.buildKey(subKey), amount);
  }

  /**
   * Reserve an estimated amount BEFORE the paid call. This is the decision that
   * actually caps: if `allowed` is `false`, do NOT make the call. After the call,
   * pass the returned reservation to {@link settle} with the real cost to correct
   * the counter (refund the unused estimate, or charge the overage).
   *
   * @param subKey See {@link checkAndIncrement}.
   * @param estimate Amount to reserve up front. Defaults to `1`. Must be an
   *   integer between 1 and Number.MAX_SAFE_INTEGER. Use an estimate at or above
   *   the typical real cost so the cap errs on the safe side between reserve and
   *   settle.
   */
  async reserve(
    subKey?: string,
    estimate = 1,
  ): Promise<BudgetCapReservation> {
    validateAmount(estimate, 'estimate');
    const decision = await this.increment(this.buildKey(subKey), estimate);
    return { ...decision, subKey, reserved: estimate };
  }

  /**
   * Settle a {@link reserve} against the real cost of the call. Applies the
   * signed difference (`realCost - reserved`) to the same counter atomically,
   * without extending the window. Refunds are clamped so the counter never goes
   * below zero.
   *
   * Safe to call even when the reservation was degraded (Redis was down at
   * reserve time) or when the window already elapsed between reserve and settle:
   * both are no-ops. Best-effort across a window boundary — if the window rolled
   * over between reserve and settle the settle applies to the new window; keep
   * windows long relative to call latency (they are, by design).
   *
   * @param reservation The value returned by {@link reserve}.
   * @param realCost The actual cost of the call. Must be an integer between 0
   *   and Number.MAX_SAFE_INTEGER (`0` is allowed — a call that cost nothing).
   */
  async settle(
    reservation: BudgetCapReservation,
    realCost: number,
  ): Promise<BudgetCapDecision> {
    if (
      !Number.isInteger(realCost) ||
      realCost < 0 ||
      realCost > Number.MAX_SAFE_INTEGER
    ) {
      throw new BudgetCapError(
        'realCost must be an integer between 0 and Number.MAX_SAFE_INTEGER.',
      );
    }
    // The reservation never touched Redis (fail-open at reserve time): nothing to
    // settle. Reporting degraded keeps the outage visible to the caller.
    if (reservation.degraded) {
      return this.degradedDecision();
    }

    const delta = realCost - reservation.reserved;
    const key = this.buildKey(reservation.subKey);
    try {
      const reply = await this.run(() =>
        this.redis.eval(SETTLE_BUDGET_CAP_LUA, 1, key, delta),
      );
      const { settled, count } = parseSettleReply(reply);
      // Key gone (window elapsed / evicted between reserve and settle): the old
      // window no longer exists, so there is nothing meaningful to report.
      const effectiveCount = settled ? count : 0;
      return this.decisionFrom(effectiveCount);
    } catch (error) {
      return this.handleFailure(error);
    }
  }

  /** Run the atomic increment script and turn its reply into a decision. */
  private async increment(
    key: string,
    amount: number,
  ): Promise<BudgetCapDecision> {
    try {
      const reply = await this.run(() =>
        this.redis.eval(ATOMIC_BUDGET_CAP_LUA, 1, key, this.windowMs, amount),
      );
      return this.decisionFrom(toCount(reply));
    } catch (error) {
      return this.handleFailure(error);
    }
  }

  /** Build the effective Redis key, validating any provided `subKey`. */
  private buildKey(subKey: string | undefined): string {
    if (subKey === undefined) {
      return this.key;
    }
    if (typeof subKey !== 'string') {
      throw new BudgetCapError('subKey must be a string when provided.');
    }
    if (subKey.length === 0) {
      throw new BudgetCapError(
        "subKey must not be empty. Omit it (or pass undefined) for the global counter — an empty string silently falling through to the global budget is a footgun, so it's rejected.",
      );
    }
    if (subKey.length > MAX_SUBKEY_LENGTH) {
      throw new BudgetCapError(
        `subKey must be at most ${String(MAX_SUBKEY_LENGTH)} characters.`,
      );
    }
    if (!SUBKEY_PATTERN.test(subKey)) {
      throw new BudgetCapError(
        'subKey must match [A-Za-z0-9_.-] (no ":", no whitespace). Normalize it server-side; never pass a raw request header.',
      );
    }
    return `${this.key}:${subKey}`;
  }

  /**
   * Run a Redis operation with a hard timeout. If Redis does not answer within
   * `timeoutMs`, reject so {@link failOpen} decides instead of hanging — the
   * fix for a default ioredis client that queues offline and never rejects.
   */
  private async run(op: () => Promise<unknown>): Promise<unknown> {
    if (this.timeoutMs === 0) {
      return op();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new BudgetCapError(
            `Redis did not respond within ${String(this.timeoutMs)}ms.`,
          ),
        );
      }, this.timeoutMs);
      // Never keep the process alive just for this watchdog.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    try {
      return await Promise.race([op(), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Turn a Redis failure into a fail-open decision or a thrown error. */
  private handleFailure(error: unknown): BudgetCapDecision {
    if (!this.failOpen) {
      // Wrap so an integrator logging the error can't leak the full key (which
      // may embed a subKey/user id) via ioredis' `command.args`. The original
      // error is preserved as `cause` for debugging.
      throw new BudgetCapError('The Redis budget-cap operation failed.', {
        cause: error,
      });
    }
    if (this.onDegraded !== undefined) {
      try {
        this.onDegraded(error);
      } catch {
        // A broken alert hook must never break the request path.
      }
    }
    return this.degradedDecision();
  }

  private decisionFrom(count: number): BudgetCapDecision {
    return {
      allowed: count <= this.limit,
      count,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      degraded: false,
    };
  }

  private degradedDecision(): BudgetCapDecision {
    return {
      allowed: true,
      count: 0,
      limit: this.limit,
      remaining: this.limit,
      degraded: true,
    };
  }
}

/** Shared amount/estimate validation. */
function validateAmount(value: number, name: string): void {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new BudgetCapError(
      `${name} must be an integer between 1 and Number.MAX_SAFE_INTEGER.`,
    );
  }
}

/** Narrow the untyped Redis reply to the integer count the script returns. */
function toCount(reply: unknown): number {
  const count = coerceInteger(reply);
  if (count === undefined || count < 0) {
    // A negative or non-integer count means the counter overflowed int64 or the
    // key holds a non-numeric value — the cap is no longer trustworthy. Throwing
    // routes it through fail-open (or a thrown error) instead of returning a
    // bogus `allowed: true` with `degraded: false`.
    throw new BudgetCapError(
      `Unexpected Redis reply for the budget counter: ${String(reply)}`,
    );
  }
  return count;
}

/** Parse the `{settled, count}` reply of {@link SETTLE_BUDGET_CAP_LUA}. */
function parseSettleReply(reply: unknown): {
  settled: boolean;
  count: number;
} {
  if (Array.isArray(reply) && reply.length === 2) {
    const settled = coerceInteger(reply[0]);
    const count = coerceInteger(reply[1]);
    if (settled !== undefined && count !== undefined && count >= 0) {
      return { settled: settled === 1, count };
    }
  }
  throw new BudgetCapError(
    `Unexpected Redis reply for the settle operation: ${String(reply)}`,
  );
}

/** Coerce a Redis integer reply (number or numeric string) to an integer. */
function coerceInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  // Some clients surface integer replies as strings; accept those too.
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && String(parsed) === value.trim()) {
      return parsed;
    }
  }
  return undefined;
}
