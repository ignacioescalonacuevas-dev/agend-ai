/**
 * Aplica un `ContextoSesion` a una conexión Postgres para que las políticas
 * RLS (`app_establecimiento_visible`/`app_establecimiento_propio`) surtan
 * efecto — el mismo `set local role` + `set_config` que hoy fijan a mano
 * los tests de RLS. Pensado para que una futura capa de wiring de Supabase
 * Auth real llame esto por request con el `userId` de la sesión; hasta
 * entonces lo usan directamente los tests.
 *
 * Debe correr dentro de una transacción abierta por el llamador (`set
 * local` solo dura hasta el próximo commit/rollback).
 */
import type pg from 'pg';
import type { ContextoSesion } from '@/domain/perfil';

export async function aplicarContextoSesion(
  client: pg.PoolClient,
  contexto: ContextoSesion,
): Promise<void> {
  await client.query('set local role authenticated');
  await client.query(`select set_config('app.coordinador_red', $1, true)`, [
    String(contexto.rol === 'coordinador_red'),
  ]);
  await client.query(`select set_config('app.establecimiento_id', $1, true)`, [
    contexto.establecimientoId ?? '',
  ]);
}
