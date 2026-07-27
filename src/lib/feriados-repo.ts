/** Loads the holiday calendar (`feriados` table) as a lookup set. */
import type pg from 'pg';

export async function obtenerFeriados(db: pg.Pool | pg.PoolClient): Promise<ReadonlySet<string>> {
  const res = await db.query<{ fecha: string }>('select fecha::text from feriados');
  return new Set(res.rows.map((r) => r.fecha));
}
