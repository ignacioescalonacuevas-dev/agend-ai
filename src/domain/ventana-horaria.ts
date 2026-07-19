/**
 * Contact time window (RF-2): patients are only contacted between 09:00 and
 * 20:00 America/Santiago. Jobs landing outside the window are deferred to
 * the next opening, never dropped.
 */
import { DateTime } from 'luxon';
import { ZONA_CHILE } from './fechas';

export const HORA_APERTURA = 9;
export const HORA_CIERRE = 20;

export function dentroDeVentana(instante: Date): boolean {
  const hora = DateTime.fromJSDate(instante, { zone: ZONA_CHILE }).hour;
  return hora >= HORA_APERTURA && hora < HORA_CIERRE;
}

/**
 * Returns `instante` unchanged when inside the window; otherwise the next
 * 09:00 Santiago (today if before 09:00, tomorrow if at/after 20:00).
 * DST switches are handled by luxon's tz database.
 */
export function proximaAperturaVentana(instante: Date): Date {
  if (dentroDeVentana(instante)) return instante;
  const local = DateTime.fromJSDate(instante, { zone: ZONA_CHILE });
  const aperturaHoy = local.set({ hour: HORA_APERTURA, minute: 0, second: 0, millisecond: 0 });
  const apertura = local.hour < HORA_APERTURA ? aperturaHoy : aperturaHoy.plus({ days: 1 });
  return apertura.toJSDate();
}
