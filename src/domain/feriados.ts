/**
 * Blocked-day check (EETT §"Requisitos del Convenio": "Días bloqueados:
 * domingos y festivos, sin contacto de ningún tipo").
 *
 * Pure domain logic: the caller supplies the holiday set (loaded from the
 * `feriados` table) as 'YYYY-MM-DD' strings in America/Santiago.
 */
import { DateTime } from 'luxon';
import { ZONA_CHILE } from './fechas';

const DOMINGO = 7; // Luxon: weekday 1 = Monday .. 7 = Sunday

export function esDiaBloqueado(instante: Date, feriados: ReadonlySet<string>): boolean {
  const local = DateTime.fromJSDate(instante, { zone: ZONA_CHILE });
  if (local.weekday === DOMINGO) return true;
  return feriados.has(local.toFormat('yyyy-MM-dd'));
}
