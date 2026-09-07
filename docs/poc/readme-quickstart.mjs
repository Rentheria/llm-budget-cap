// Copia VERBATIM del quick-start del README 0.2.0 (secciones "Config recomendada
// del cliente" + "Un tope de gasto real en tokens/centavos"), con callGemini
// simulada. Debe topar dentro del presupuesto.
import Redis from 'ioredis';
import { BudgetCap } from '../../dist/index.js';

// --- README: Recommended Redis client config ---
const redis = new Redis(process.env.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 2,
});
await new Promise((res) => redis.once('ready', res)); // esperar conexión (solo para el PoC)
await redis.flushall();

// callGemini simulada: cuesta 400 tokens reales por llamada.
let realTokensBilled = 0;
async function callGemini() {
  realTokensBilled += 400;
  return { usage: { totalTokens: 400 } };
}
const estimatedTokens = 400;

// --- README: A real spend cap in tokens/cents ---
const cap = new BudgetCap({ redis, key: 'gemini:tokens', limit: 1_000 });

async function handleRequest() {
  // 1. Reserve an estimate BEFORE the paid call. This is what caps.
  const reservation = await cap.reserve('user-123', estimatedTokens);
  if (!reservation.allowed) {
    return { status: 429, error: 'Token budget exhausted.' };
  }
  // 2. Make the paid call.
  const response = await callGemini();
  // 3. Settle with the real cost.
  await cap.settle(reservation, response.usage.totalTokens);
  return { status: 200 };
}

// 20 requests concurrentes contra un presupuesto de 1000 tokens (2.5 llamadas).
const responses = await Promise.all(Array.from({ length: 20 }, handleRequest));
const ok = responses.filter((r) => r.status === 200).length;
const capped = responses.filter((r) => r.status === 429).length;

console.log(
  JSON.stringify(
    {
      limit: 1000,
      concurrentRequests: 20,
      paidCallsMade: ok,
      cappedWith429: capped,
      realTokensBilled,
      withinBudget: realTokensBilled <= 1000,
    },
    null,
    2,
  ),
);

await redis.quit();
