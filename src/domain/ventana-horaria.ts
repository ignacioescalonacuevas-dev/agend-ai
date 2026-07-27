/**
 * Contact time windows, per canal (EETT §"Requisitos del Convenio"):
 *
 *   - Llamadas salientes (IVR): 09:00–11:30 y 14:00–17:00 L-V; 09:00–13:00
 *     sábado.
 *   - Mensajería (WhatsApp/SMS): 08:30–19:00 L-V; 09:00–13:00 sábado.
 *   - Domingos y feriados: bloqueados para todo canal.
 *
 * Jobs landing outside the window are deferred to the next opening, never
 * dropped. Fase 0 used one 09:00–20:00 window for every canal; esto
 * reemplaza esa ventana única por los tramos exactos del EETT.
 */
import { DateTime } from 'luxon';
import { esDiaBloqueado } from './feriados';
import { ZONA_CHILE } from './fechas';

export type CanalVentana = 'whatsapp' | 'sms' | 'llamada';

/** Hours expressed as decimals (11.5 = 11:30) for simple range comparisons. */
interface Tramo {
  desde: number;
  hasta: number;
}

const SABADO = 6; // Luxon: weekday 1 = Monday .. 7 = Sunday

// El EETT agrupa WhatsApp y SMS bajo "mensajería" (una sola ventana); solo
// las llamadas salientes (IVR) tienen su propio horario, partido en dos
// tramos por la pausa de mediodía.
const VENTANAS: Record<CanalVentana, { laboral: Tramo[]; sabado: Tramo[] }> = {
  whatsapp: { laboral: [{ desde: 8.5, hasta: 19 }], sabado: [{ desde: 9, hasta: 13 }] },
  sms: { laboral: [{ desde: 8.5, hasta: 19 }], sabado: [{ desde: 9, hasta: 13 }] },
  llamada: {
    laboral: [
      { desde: 9, hasta: 11.5 },
      { desde: 14, hasta: 17 },
    ],
    sabado: [{ desde: 9, hasta: 13 }],
  },
};

function tramosDelDia(canal: CanalVentana, local: DateTime): readonly Tramo[] {
  return local.weekday === SABADO ? VENTANAS[canal].sabado : VENTANAS[canal].laboral;
}

function horaDecimal(local: DateTime): number {
  return local.hour + local.minute / 60 + local.second / 3600;
}

function inicioDeTramo(local: DateTime, tramo: Tramo): DateTime {
  const horas = Math.floor(tramo.desde);
  const minutos = Math.round((tramo.desde - horas) * 60);
  return local.set({ hour: horas, minute: minutos, second: 0, millisecond: 0 });
}

export function dentroDeVentana(
  canal: CanalVentana,
  instante: Date,
  feriados: ReadonlySet<string>,
): boolean {
  if (esDiaBloqueado(instante, feriados)) return false;
  const local = DateTime.fromJSDate(instante, { zone: ZONA_CHILE });
  const hora = horaDecimal(local);
  return tramosDelDia(canal, local).some((t) => hora >= t.desde && hora < t.hasta);
}

/**
 * Returns `instante` unchanged when inside the window; otherwise the next
 * valid opening for `canal` (skipping domingos, feriados, y fuera de tramo).
 * Weekdays (L-V) share one set of tramos; sábado has its own, shorter,
 * single tramo; domingo nunca tiene tramos (bloqueado por `esDiaBloqueado`).
 */
export function proximaAperturaVentana(
  canal: CanalVentana,
  instante: Date,
  feriados: ReadonlySet<string>,
): Date {
  let cursor = DateTime.fromJSDate(instante, { zone: ZONA_CHILE });

  // 14 days is a generous cap: even a Saturday-only window opens at least
  // once a week, so this always terminates well before the cap.
  for (let dia = 0; dia < 14; dia += 1) {
    if (!esDiaBloqueado(cursor.toJSDate(), feriados)) {
      for (const tramo of tramosDelDia(canal, cursor)) {
        const apertura = inicioDeTramo(cursor, tramo);
        const cierre = apertura.set({
          hour: Math.floor(tramo.hasta),
          minute: Math.round((tramo.hasta - Math.floor(tramo.hasta)) * 60),
        });
        if (cursor >= apertura && cursor < cierre) return cursor.toJSDate();
        if (cursor < apertura) return apertura.toJSDate();
        // cursor is past this tramo's close: try the next tramo (if any).
      }
    }
    cursor = cursor.plus({ days: 1 }).startOf('day');
  }
  throw new Error(`no se encontró apertura de ventana para "${canal}" en 14 días`);
}
