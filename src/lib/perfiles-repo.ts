/** Loads a user's session context from `perfiles` (mismo patrón que `feriados-repo.ts`). */
import type pg from 'pg';
import type { ContextoSesion, RolPerfil } from '@/domain/perfil';

export async function obtenerContextoSesion(
  db: pg.Pool | pg.PoolClient,
  userId: string,
): Promise<ContextoSesion | null> {
  const res = await db.query<{ rol: RolPerfil; establecimiento_id: string | null }>(
    'select rol, establecimiento_id from perfiles where user_id = $1',
    [userId],
  );
  const fila = res.rows[0];
  if (fila === undefined) return null;
  return { userId, rol: fila.rol, establecimientoId: fila.establecimiento_id };
}
