// PoC DESPUÉS — M-02: incluso con el cliente default del README (que encola
// offline y nunca rechaza), el timeoutMs decide dentro del presupuesto de tiempo
// en vez de colgarse. Probamos contra un Redis inalcanzable.
import Redis from 'ioredis';
import { BudgetCap } from '../../dist/index.js';

const DEAD_URL = 'redis://127.0.0.1:6398'; // nada escucha aquí
const redis = new Redis(DEAD_URL); // defaults del README: enableOfflineQueue:true
redis.on('error', () => {});

// timeoutMs default es 5000; lo bajamos a 800 para el demo.
const cap = new BudgetCap({ redis, key: 'poc:timeout', limit: 500, timeoutMs: 800 });

const started = Date.now();
const decision = await cap.checkAndIncrement();
const elapsed = Date.now() - started;

console.log(JSON.stringify({
  patron: 'README 0.2.0 (new Redis(url) defaults + timeoutMs:800)',
  elapsedMs: elapsed,
  decidedWithinTimeout: elapsed < 2000,
  decision,
}, null, 2));

redis.disconnect();
process.exit(0);
