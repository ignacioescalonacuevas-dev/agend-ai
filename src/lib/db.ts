/**
 * Postgres connection pool (server-side only). In later hitos the same
 * database is reached through Supabase; direct pg access is used for
 * transactional writes (state machine, ingestion, recovery locks).
 */
import pg from 'pg';

let pool: pg.Pool | undefined;

export function obtenerPool(): pg.Pool {
  if (pool === undefined) {
    const url = process.env.DATABASE_URL;
    if (url === undefined || url === '') {
      throw new Error('DATABASE_URL no está configurada');
    }
    pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

/** Closes the pool (test teardown; the app keeps it for its lifetime). */
export async function cerrarPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Runs `fn` inside BEGIN/COMMIT, rolling back if it throws. */
export async function conTransaccion<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await obtenerPool().connect();
  try {
    await client.query('begin');
    const resultado = await fn(client);
    await client.query('commit');
    return resultado;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
