/**
 * Atomic budget-cap counter, run as a single Lua script inside Redis.
 *
 * One `INCRBY` and, only when the window is fresh (`current == amount`) or the
 * key somehow lost its TTL (`ttl < 0`), one `PEXPIRE` — all in ONE Lua
 * execution. Because Redis runs a script to completion without interleaving
 * other commands, two near-simultaneous requests close to the cap can never
 * both read a stale value and overshoot it, and the TTL is never left
 * un-armed.
 *
 * This is the whole reason the library exists as a Lua script and not a
 * `GET` + `SET`: the read-modify-write of the naive approach has a race window
 * between the read and the write where a second request slips through. See the
 * README for the worked example.
 *
 * The script rejects `amount < 1` itself (`redis.error_reply`) so it stays safe
 * even when reused directly via the exported constant: a caller cannot turn the
 * increment into a decrement and rearm the TTL. `BudgetCap` also validates the
 * amount before calling, so this is defense in depth.
 *
 * Works on Redis < 7 too: it uses `PTTL` + `PEXPIRE` rather than the newer
 * `PEXPIRE ... NX` flag. Returns the post-increment count.
 *
 *   KEYS[1] = counter key
 *   ARGV[1] = window length in milliseconds
 *   ARGV[2] = amount to add this call (integer >= 1)
 */
export const ATOMIC_BUDGET_CAP_LUA = `
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
`;

/**
 * Settle a prior reservation against its real cost, atomically.
 *
 * Applies a signed delta (`realCost - reserved`) to an EXISTING counter without
 * re-arming its TTL — the window started when the reservation was made and must
 * not be extended by the settle. If the key no longer exists (the window
 * elapsed, or Redis evicted it between reserve and settle) the settle is a
 * no-op: there is nothing left in this window to adjust.
 *
 * A refund that would drive the counter below zero is clamped to `0` while
 * preserving whatever TTL the key had (read `PTTL`, `SET`, re-`PEXPIRE` — all in
 * the same atomic script, so no window is ever left un-armed).
 *
 * Returns a two-element array `{settled, count}`:
 *   settled = 1 and count = post-settle value, or
 *   settled = 0 and count = 0 when the key was already gone (nothing settled).
 *
 *   KEYS[1] = counter key
 *   ARGV[1] = signed delta to apply (realCost - reserved)
 */
export const SETTLE_BUDGET_CAP_LUA = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  return {0, 0}
end
local delta = tonumber(ARGV[1])
if delta == nil then
  return redis.error_reply("BUDGETCAP: settle delta must be a number")
end
local current = redis.call("INCRBY", KEYS[1], delta)
if current < 0 then
  local ttl = redis.call("PTTL", KEYS[1])
  redis.call("SET", KEYS[1], 0)
  if ttl > 0 then
    redis.call("PEXPIRE", KEYS[1], ttl)
  end
  current = 0
end
return {1, current}
`;
