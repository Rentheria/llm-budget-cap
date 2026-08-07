# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: a minor
version may carry breaking changes, documented explicitly below).

## [0.2.0] - 2026-07-27

Security-driven release. Two independent audits found that the pattern the 0.1.0
README taught for a "real spend cap" did not actually cap anything, and that the
promised degraded mode did not trigger with the client the README built. Both are
fixed, along with the rest of the open Medium/Low findings.

### Added

- **`reserve(subKey?, estimate?)` + `settle(reservation, realCost)`** — a
  reserve-before-you-spend flow. `reserve` decides **before** the paid call
  (this is what actually caps); `settle` corrects the counter afterwards with the
  real cost (refunds the unused estimate, or charges the overage), atomically and
  without extending the window. Backed by a new `SETTLE_BUDGET_CAP_LUA` script
  (exported). Fixes the 20× overspend measured under concurrency.
- **`timeoutMs` option (default `5000`)** — a hard timeout around every Redis
  call. If Redis hangs (e.g. a default ioredis client that queues offline and
  never rejects), the call is decided by `failOpen` within the budget instead of
  hanging the request. Makes degraded mode real regardless of client config.
- **`onDegraded(error)` callback** — invoked whenever a call degrades to a
  fail-open result, so integrators can alert/meter outages without wrapping every
  call. Its own throws are swallowed.
- **`BudgetCapReservation` type** and **`SETTLE_BUDGET_CAP_LUA`** export.
- `CHANGELOG.md` (this file).

### Changed / Breaking

- **`subKey` is now validated**: must match `[A-Za-z0-9_.-]`, be 1–128 chars, and
  contain no `:`. An empty string is now **rejected** instead of silently falling
  through to the global counter. Prevents cap evasion via trivial variation
  (`u1`, `u1 `, `U1`), unbounded key creation, and namespace collisions.
- **`amount`, `limit`, and `windowMs` are bounded to `Number.MAX_SAFE_INTEGER`**.
  Values above it now throw `BudgetCapError` instead of silently corrupting the
  counter (int64 overflow returning a negative count with `degraded: false`).
- **A negative or non-integer counter reply is now treated as an error** (routed
  through `failOpen`) instead of being returned as a bogus `allowed: true`.
- **`failOpen: false` now throws a `BudgetCapError`** whose `cause` is the
  underlying error, instead of re-throwing the raw ioredis error (whose
  `command.args` could leak the full key, including a per-user `subKey`, into
  logs).
- **The exported `ATOMIC_BUDGET_CAP_LUA` now rejects `amount < 1` itself**
  (`redis.error_reply`), so reusing the script directly can't turn the increment
  into a decrement or re-arm the TTL.
- Corrected "rolling window" to "fixed window" throughout the types/docs — the
  behavior was always a fixed window from the first hit.

### Documentation

- README rewritten so the taught pattern is the one that actually caps
  (`reserve`/`settle`), plus a **Migrating from 0.1.0** section with the explicit
  warning that the old pattern did not cap.
- Added recommended Redis client config (`enableOfflineQueue: false`,
  `maxRetriesPerRequest`) and a **Deployment requirements** section
  (`maxmemory-policy noeviction`, best-effort against `FLUSHALL`/eviction/failover,
  app/env key prefix).

### Not changed (by design)

- The atomic counter (`ATOMIC_BUDGET_CAP_LUA`) and `checkAndIncrement`'s
  call-count behavior are unchanged — both audits confirmed the Lua is atomic and
  `INCRBY`-with-amount introduces no race. Only the additions and validation above.
- Sourcemaps remain in the published tarball: the package is MIT and the source is
  public at the same commit, so the `.map` files expose nothing hidden, and
  dropping them would break stack traces for anyone debugging the package.

## [0.1.0] - 2026-07-21

- Initial release: atomic Redis spend/usage cap via a single Lua `INCRBY` +
  `PEXPIRE` script, `checkAndIncrement`, fixed window, fail-open by default.
