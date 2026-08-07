// PoC DESPUÉS — mismo escenario que before-overspend, ahora con el patrón
// reserve/settle que enseña el README 0.2.0. El gasto real debe quedar DENTRO
// del presupuesto.
import Redis from 'ioredis';
import { BudgetCap } from '../../dist/index.js';

const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6399';
const redis = new Redis(URL, { maxRetriesPerRequest: 2 });
await redis.flushall();

const LIMIT = 1000;
const CONCURRENCY = 50;
const TOKENS_PER_CALL = 400;

const cap = new BudgetCap({ redis, key: 'poc:after', limit: LIMIT, windowMs: 60_000 });

let tokensReallySpent = 0;
let paidCalls = 0;

async function callLLM() {
  paidCalls += 1;
  tokensReallySpent += TOKENS_PER_CALL;
  return { usage: { totalTokens: TOKENS_PER_CALL } };
}

// Patrón README 0.2.0: reserve ANTES, call, settle con el real.
async function handler() {
  const reservation = await cap.reserve(undefined, TOKENS_PER_CALL);
  if (!reservation.allowed) return false; // topado: NO se hace la llamada de pago
  const response = await callLLM();
  await cap.settle(reservation, response.usage.totalTokens);
  return true;
}

const results = await Promise.all(Array.from({ length: CONCURRENCY }, handler));
const allowed = results.filter(Boolean).length;

console.log(JSON.stringify({
  patron: 'README 0.2.0 (reserve-first, settle-after)',
  limit: LIMIT,
  concurrency: CONCURRENCY,
  tokensPerCall: TOKENS_PER_CALL,
  paidCalls,
  tokensReallySpent,
  overBudgetFactor: +(tokensReallySpent / LIMIT).toFixed(2),
  withinBudget: tokensReallySpent <= LIMIT,
  paidCallsAllowed: allowed,
}, null, 2));

await redis.quit();
