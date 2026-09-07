// PoC ANTES — M-02: con el cliente que construye el README (defaults de ioredis:
// enableOfflineQueue:true), un Redis inalcanzable NO rechaza: encola offline y
// checkAndIncrement se cuelga en vez de degradar. Medimos cuánto tarda.
import Redis from 'ioredis';
import { BudgetCap } from '../../dist/index.js';

// Puerto muerto: nada escucha aquí.
const DEAD_URL = 'redis://127.0.0.1:6398';
// Cliente TAL CUAL el README 0.1.0 (README.md:42): new Redis(url), sin opciones.
const redis = new Redis(DEAD_URL);
redis.on('error', () => {}); // silenciar ruido de reconexión

const cap = new BudgetCap({ redis, key: 'poc:hang', limit: 500 });

const started = Date.now();
const HARD_CAP_MS = 8000;

const decision = await Promise.race([
  cap.checkAndIncrement().then((d) => ({ kind: 'decided', d })),
  new Promise((resolve) =>
    setTimeout(() => resolve({ kind: 'still-hanging' }), HARD_CAP_MS),
  ),
]);

const elapsed = Date.now() - started;
console.log(
  JSON.stringify(
    {
      patron: 'README 0.1.0 (new Redis(url), defaults)',
      outcome: decision.kind,
      elapsedMs: elapsed,
      note:
        decision.kind === 'still-hanging'
          ? `SIGUE COLGADO tras ${HARD_CAP_MS}ms — failOpen nunca se disparó`
          : JSON.stringify(decision.d),
    },
    null,
    2,
  ),
);

redis.disconnect();
process.exit(0);
