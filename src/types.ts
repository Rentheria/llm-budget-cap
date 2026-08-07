/**
 * Minimal structural type for the Redis client this library needs.
 *
 * It matches ioredis' `eval(script, numKeys, ...args)` signature exactly, so an
 * ioredis client satisfies it with no adapter. Any client exposing the same
 * `eval` shape (e.g. a thin wrapper over node-redis) works too — see the README.
 * The library never imports ioredis itself; it only depends on this contract.
 */
export interface RedisEvalClient {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

/** Options for a {@link BudgetCap} instance. */
export interface BudgetCapOptions {
  /** ioredis-compatible client (see {@link RedisEvalClient}). */
  readonly redis: RedisEvalClient;
  /**
   * Base Redis key for the counter. When a `subKey` is passed to a call, it is
   * appended as `${key}:${subKey}` (e.g. one cap per tenant/user/IP).
   */
  readonly key: string;
  /** Maximum spend/usage allowed within the window. Must be an integer >= 1. */
  readonly limit: number;
  /**
   * Fixed window length in milliseconds, measured from the first hit (NOT a
   * sliding window). Defaults to 24h. Must be an integer >= 1 and
   * <= Number.MAX_SAFE_INTEGER when provided.
   */
  readonly windowMs?: number;
  /**
   * When the Redis call fails or times out, allow the operation through
   * (`allowed: true`, `degraded: true`) instead of throwing. Defaults to `true`
   * — a briefly unmetered feature during a Redis outage beats taking the
   * feature down. Set to `false` to fail closed (a {@link BudgetCapError} is
   * thrown, with the underlying error as its `cause`).
   */
  readonly failOpen?: boolean;
  /**
   * Hard timeout in milliseconds for each Redis operation. If Redis does not
   * answer within this budget, the call is decided by {@link failOpen} instead
   * of hanging — this makes degraded mode real even when the ioredis client is
   * left with its defaults (`enableOfflineQueue: true`), where a dead Redis
   * queues commands offline and never rejects. Defaults to `5000`. Set to `0`
   * to disable the timeout (not recommended). Must be an integer >= 0.
   */
  readonly timeoutMs?: number;
  /**
   * Optional callback invoked with the underlying error whenever a call
   * degrades to a fail-open result (`degraded: true`). Use it to alert/meter
   * outages without wrapping every call. Its own throws are swallowed so a
   * broken hook can never break the request path. Only meaningful with
   * `failOpen: true` (with `failOpen: false` the error is thrown, not degraded).
   */
  readonly onDegraded?: (error: unknown) => void;
}

/** Outcome of a single {@link BudgetCap} call. */
export interface BudgetCapDecision {
  /** Whether the caller may proceed (the post-increment count is within limit). */
  readonly allowed: boolean;
  /** Counter value AFTER this increment. `0` on a degraded (fail-open) result. */
  readonly count: number;
  /** The configured limit, echoed back for convenience. */
  readonly limit: number;
  /** Spend/usage still allowed in this window: `max(0, limit - count)`. */
  readonly remaining: number;
  /**
   * `true` when the Redis call failed/timed out and the result is a fail-open
   * fallback rather than a real count. Callers should alert on this.
   */
  readonly degraded: boolean;
}

/**
 * A reservation made by {@link BudgetCap.reserve}. It is a {@link BudgetCapDecision}
 * (check `.allowed` before making the paid call) that also carries what it needs
 * to be settled later — pass it back to {@link BudgetCap.settle} with the real
 * cost. The `subKey`/`reserved` fields let `settle` target the exact same
 * counter, so you cannot accidentally settle against the wrong key.
 */
export interface BudgetCapReservation extends BudgetCapDecision {
  /** The subKey this reservation was made under (for {@link BudgetCap.settle}). */
  readonly subKey: string | undefined;
  /** The amount reserved by this call (for {@link BudgetCap.settle}). */
  readonly reserved: number;
}
