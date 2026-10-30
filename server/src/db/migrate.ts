import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db → ../../migrations (funciona via tsx e a partir de dist/db)
export const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Aplica as migrações .sql em ordem alfabética, cada uma em sua transação.
 * Registra o checksum e recusa continuar se uma migração já aplicada foi alterada.
 * Usa advisory lock para que duas instâncias não migrem ao mesmo tempo.
 */
export async function runMigrations(pool: Pool): Promise<MigrationResult> {
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>();
    const rows = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    for (const r of rows.rows) done.set(r.name, r.checksum);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) {
          throw new Error(
            `A migração já aplicada ${file} foi modificada. Crie uma nova migração em vez de editá-la.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migração ${file}: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(727274)');
    } finally {
      client.release();
    }
  }
}
