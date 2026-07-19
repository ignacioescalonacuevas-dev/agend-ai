/**
 * Date handling in America/Santiago (RF-1, NFR "Zona horaria").
 *
 * Agenda files carry wall-clock Santiago times; the database stores
 * timestamptz (UTC instants). Luxon carries the IANA tz database, so the
 * Chilean DST switches (first Saturday of September / first Saturday of
 * April) are honored without hand-written offset math.
 */
import { DateTime } from 'luxon';

export const ZONA_CHILE = 'America/Santiago';

const FORMATOS_FECHA_HORA = [
  'dd-MM-yyyy H:mm',
  'dd/MM/yyyy H:mm',
  'yyyy-MM-dd H:mm',
  'dd-MM-yyyy H:mm:ss',
  'dd/MM/yyyy H:mm:ss',
  'yyyy-MM-dd H:mm:ss',
  "yyyy-MM-dd'T'H:mm",
  "yyyy-MM-dd'T'H:mm:ss",
];

/**
 * Parses a Santiago wall-clock date/time into a UTC instant. `hora` may come
 * in a separate column or be embedded in `fecha`. Returns null if unparseable.
 */
export function parsearFechaHoraSantiago(fecha: string, hora?: string): Date | null {
  const texto = [fecha.trim(), hora?.trim()].filter(Boolean).join(' ');
  for (const formato of FORMATOS_FECHA_HORA) {
    const dt = DateTime.fromFormat(texto, formato, { zone: ZONA_CHILE });
    if (dt.isValid) return dt.toJSDate();
  }
  const iso = DateTime.fromISO(texto, { zone: ZONA_CHILE });
  return iso.isValid ? iso.toJSDate() : null;
}

/** Formats a UTC instant as Santiago local time for UI and reports. */
export function formatearSantiago(instante: Date, formato = 'dd-MM-yyyy HH:mm'): string {
  return DateTime.fromJSDate(instante, { zone: ZONA_CHILE }).toFormat(formato);
}

/** Minutes offset from UTC for a given instant in Santiago (test helper for DST edges). */
export function offsetSantiago(instante: Date): number {
  return DateTime.fromJSDate(instante, { zone: ZONA_CHILE }).offset;
}
