import { Pool } from 'pg';
import { config } from '../config.js';
import { runMigrations } from './migrate.js';

const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
try {
  const r = await runMigrations(pool);
  console.log(`Migrações aplicadas: ${r.applied.length ? r.applied.join(', ') : '(nenhuma nova)'}`);
  if (r.skipped.length) console.log(`Já aplicadas: ${r.skipped.join(', ')}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
