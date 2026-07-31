/**
 * SLA de la mesa de ayuda (EETT §6, Anexo 8): plazos de primera respuesta y
 * resolución por criticidad, medidos desde `fecha_apertura`.
 *
 *   alta:  1h primera respuesta / 4h resolución  (horas corridas — una
 *          falla que interrumpe el servicio no puede esperar horario hábil)
 *   media: 6h / 24h (corridas)
 *   baja:  24h (corridas) / 5 días hábiles
 *
 * "Día hábil" aquí es lunes a viernes sin feriados (criterio administrativo,
 * Ley 19.880): a diferencia de `esDiaBloqueado` en `feriados.ts` —que trata
 * el sábado como día de contacto reducido, no bloqueado— el sábado SÍ es
 * inhábil para este cálculo. Por eso no se reutiliza `esDiaBloqueado`.
 */
import { DateTime } from 'luxon';
import { ZONA_CHILE } from './fechas';

export type CriticidadTicket = 'alta' | 'media' | 'baja';

export interface LimitesSla {
  primeraRespuestaLimite: Date;
  resolucionLimite: Date;
}

const HORA_MS = 3_600_000;
const SABADO = 6; // Luxon: weekday 1 = Monday .. 7 = Sunday
const DOMINGO = 7;

function esDiaHabilAdministrativo(local: DateTime, feriados: ReadonlySet<string>): boolean {
  if (local.weekday === SABADO || local.weekday === DOMINGO) return false;
  return !feriados.has(local.toFormat('yyyy-MM-dd'));
}

/** Avanza `dias` días hábiles desde `fecha`, preservando la hora del día. */
export function sumarDiasHabiles(fecha: Date, dias: number, feriados: ReadonlySet<string>): Date {
  let cursor = DateTime.fromJSDate(fecha, { zone: ZONA_CHILE });
  let restantes = dias;
  while (restantes > 0) {
    cursor = cursor.plus({ days: 1 });
    if (esDiaHabilAdministrativo(cursor, feriados)) restantes -= 1;
  }
  return cursor.toJSDate();
}

export function calcularLimitesSla(
  criticidad: CriticidadTicket,
  fechaApertura: Date,
  feriados: ReadonlySet<string>,
): LimitesSla {
  if (criticidad === 'alta') {
    return {
      primeraRespuestaLimite: new Date(fechaApertura.getTime() + 1 * HORA_MS),
      resolucionLimite: new Date(fechaApertura.getTime() + 4 * HORA_MS),
    };
  }
  if (criticidad === 'media') {
    return {
      primeraRespuestaLimite: new Date(fechaApertura.getTime() + 6 * HORA_MS),
      resolucionLimite: new Date(fechaApertura.getTime() + 24 * HORA_MS),
    };
  }
  return {
    primeraRespuestaLimite: new Date(fechaApertura.getTime() + 24 * HORA_MS),
    resolucionLimite: sumarDiasHabiles(fechaApertura, 5, feriados),
  };
}
