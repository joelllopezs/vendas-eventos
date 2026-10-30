import pg from 'pg';
import { config } from '../config.js';

// int8 (COUNT/SUM) como number — os valores deste sistema cabem com folga em 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// date como string 'AAAA-MM-DD' (evita deslocamento por fuso).
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;
export type Q = Pick<pg.Pool, 'query'>;

export function createPool(url = config.databaseUrl, max = config.dbPoolMax): Pool {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000 });
}

const RETRYABLE = new Set(['40001', '40P01']);

/** Executa fn em uma transação; repete em caso de deadlock/falha de serialização. */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* conexão já inválida */
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && i < attempts) {
        await new Promise((r) => setTimeout(r, 20 * i + Math.random() * 30));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export const isUniqueViolation = (err: unknown, constraint?: string) =>
  (err as { code?: string }).code === '23505' &&
  (!constraint || (err as { constraint?: string }).constraint === constraint);
