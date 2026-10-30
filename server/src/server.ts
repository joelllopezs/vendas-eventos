import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { expireDueCarts } from './services/cart.js';
import { reconcileStock } from './services/stock.js';

const pool = createPool();
const mig = await runMigrations(pool);
if (mig.applied.length) console.log(`Migrações aplicadas: ${mig.applied.join(', ')}`);

// Recuperação na partida: encerra reservas órfãs e corrige o contador de reservas.
const rec = await reconcileStock(pool, { fix: true });
if (rec.mismatches.length || rec.orphanReservations) console.warn('Estoque reconciliado na partida:', rec);

const app = await buildApp(pool);

// Expiração de reservas no SERVIDOR (independe do navegador); o loop nunca se sobrepõe.
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const n = await expireDueCarts(pool);
    if (n) app.log.info({ expired: n }, 'carrinhos expirados');
  } catch (err) {
    app.log.error({ err }, 'falha no job de expiração');
  } finally {
    running = false;
  }
}, config.expiryJobIntervalMs);

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
