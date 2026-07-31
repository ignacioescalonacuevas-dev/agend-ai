/**
 * Roles del sistema (EETT §4): solo los 4 que nombra el propio EETT —
 * `admision`/`encargado_servicio`/`jefatura` (per-establecimiento) y
 * `coordinador_red` (visión agregada de los 10 establecimientos, de solo
 * lectura — ver `rls-contexto.ts` y la migración de escritura, D-035).
 */

export const ROLES_PERFIL = ['admision', 'encargado_servicio', 'jefatura', 'coordinador_red'] as const;

export type RolPerfil = (typeof ROLES_PERFIL)[number];

/**
 * Contexto de sesión derivado de `perfiles` para un usuario ya autenticado
 * (hoy solo se usa desde tests; una futura capa de wiring de Supabase Auth
 * llamará `obtenerContextoSesion()` con el user id real de la sesión).
 */
export interface ContextoSesion {
  userId: string;
  rol: RolPerfil;
  establecimientoId: string | null;
}
