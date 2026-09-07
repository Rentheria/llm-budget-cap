// PoC ANTES — reproduce el patrón "spend cap real" del README 0.1.0:
// llamar al LLM PRIMERO y contabilizar DESPUÉS con checkAndIncrement.
// Mide cuántos tokens se gastan realmente bajo concurrencia.
import Redis from 'ioredis';
import { BudgetCap } from '../../dist/index.js';

const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6399';
const redis = new Redis(URL, { maxRetriesPerRequest: 2 });
await redis.flushall();

const LIMIT = 1000;
const CONCURRENCY = 50;
const TOKENS_PER_CALL = 400;

const cap = new BudgetCap({
  redis,
  key: 'poc:before',
  limit: LIMIT,
  windowMs: 60_000,
});

let tokensReallySpent = 0;
let paidCalls = 0;

// Simula la llamada de pago: cuesta TOKENS_PER_CALL reales.
async function callLLM() {
  paidCalls += 1;
  tokensReallySpent += TOKENS_PER_CALL;
  return { usage: { totalTokens: TOKENS_PER_CALL } };
}

// Patrón EXACTO del README 0.1.0 (README.md:79-83): call → then checkAndIncrement.
async function handler() {
  const response = await callLLM(); // ⬅️ el dinero YA se gastó
  const decision = await cap.checkAndIncrement(
    undefined,
    response.usage.totalTokens,
  );
  return decision.allowed;
}

const results = await Promise.all(Array.from({ length: CONCURRENCY }, handler));
const allowed = results.filter(Boolean).length;

console.log(
  JSON.stringify(
    {
      patron: 'README 0.1.0 (call-first, count-after)',
      limit: LIMIT,
      concurrency: CONCURRENCY,
      tokensPerCall: TOKENS_PER_CALL,
      paidCalls,
      tokensReallySpent,
      overBudgetFactor: +(tokensReallySpent / LIMIT).toFixed(2),
      decisionsAllowed: allowed,
    },
    null,
    2,
  ),
);

await redis.quit();
