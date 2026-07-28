/**
 * Contact cascade executor (RF-3), rediseñado contra las reglas de
 * reintentos del EETT (D-029/D-031, ver DECISIONS.md): un solo episodio de
 * contacto por cita, tope duro de 3 intentos, anclado a la hora de la cita
 * (T = `fecha_hora`), no a offsets relativos entre pasos:
 *
 *   1. `informativo`    — WhatsApp uno-a-muchos, sin botones, ventana
 *                         T-7d..T-5d (encolado por `encolarInformativos`,
 *                         la cita sigue 'pendiente'). No cuenta para el tope
 *                         de 3 ni encadena el siguiente paso.
 *   2. `interactivo_1`  — WhatsApp con botones, ventana T-48h..T-24h (el
 *                         scheduler `encolarContactos` ya cae en esta
 *                         ventana sin cambios). Intento 1/3.
 *   3. `interactivo_2`  — SMS con enlace de un toque, a los 120 min reales
 *                         del intento 1 (cambio de canal, EETT: "máx. 2 por
 *                         canal antes de cambiar" + "mínimo 120 min entre
 *                         intentos del mismo canal"). Intento 2/3.
 *   4. `llamada`        — llamada IVR de confirmación, anclada a T-24h
 *                         (no relativa al paso anterior: el EETT la fija a
 *                         una hora exacta). Solo se ejecuta si la cita sigue
 *                         'en_contacto' ("solo si no hubo respuesta digital
 *                         previa"). Intento 3/3.
 *   5. `verificacion`   — 4h después de la llamada (buffer para el webhook
 *                         del hito 4); marca 'incontactable' si sigue
 *                         'en_contacto'.
 *
 * Silence NEVER frees the slot (RF-5): 'incontactable' only stops contact.
 * Cualquier estado != 'en_contacto' (p.ej. 'confirmada') detiene la cascada
 * en silencio — es la "parada automática" del EETT.
 *
 * Idempotency: the unique index on (cita_id, paso) means each step
 * sends/calls at most once, however many times its job is retried; a step
 * whose attempt failed ('fallido') is allowed to resend.
 *
 * El recontacto post-NSP (2h tras inasistencia detectada) queda fuera de
 * este cambio: depende de marcaje de asistencia, una RF que no existe
 * todavía (ver DECISIONS.md D-031 y PLAN_LICITACION_CONTACTABILIDAD.md §3).
 */
import type pg from 'pg';
import { PREFIJO_LLAMADA_SALIENTE } from '@/canales/config';
import type { CanalLlamada } from '@/canales/ivr-tipos';
import {
  GUION_LLAMADA_CONFIRMACION,
  PLANTILLA_SMS_ENLACE,
  PLANTILLA_WHATSAPP_BOTONES,
  PLANTILLA_WHATSAPP_INFORMATIVO,
  textoLlamadaConfirmacion,
  textoSmsEnlace,
  textoWhatsAppBotones,
  textoWhatsAppInformativo,
} from '@/canales/plantillas';
import type { CanalMensajeria } from '@/canales/tipos';
import { transicionar, type EstadoCita } from '@/domain/estado-cita';
import { formatearSantiago } from '@/domain/fechas';
import { dentroDeVentana, proximaAperturaVentana, type CanalVentana } from '@/domain/ventana-horaria';
import { obtenerFeriados } from '@/lib/feriados-repo';

export const MINUTOS_ENTRE_INTERACTIVOS = 120;
export const HORAS_ANTES_LLAMADA = 24;
export const HORAS_VERIFICACION_POST_LLAMADA = 4;

export type PasoCascada = 'informativo' | 'interactivo_1' | 'interactivo_2' | 'llamada';

export interface DatosCascada {
  citaId: string;
  paso: PasoCascada | 'verificacion';
}

export interface DepsCascada {
  db: pg.Pool;
  whatsapp: CanalMensajeria;
  sms: CanalMensajeria;
  llamada: CanalLlamada;
  /** Schedules a future cascade job (pg-boss send with startAfter). */
  programar: (datos: DatosCascada, ejecutarEn: Date) => Promise<void>;
  /** Base URL for the public one-tap response page (tokens land in hito 4). */
  baseUrlRespuesta: string;
  ahora?: () => Date;
}

export type ResultadoPaso =
  | { accion: 'enviado'; canal: 'whatsapp' | 'sms' | 'llamada'; externalMessageId: string }
  | { accion: 'diferido'; hasta: Date }
  | { accion: 'omitido'; motivo: string }
  | { accion: 'incontactable' }
  | { accion: 'fallido'; error: string };

interface FilaCita {
  id: string;
  estado: EstadoCita;
  servicio: string;
  fecha_hora: Date;
  nombre: string;
  telefonos: string[];
  servicio_nombre: string;
}

/** informativo/interactivo_1 = WhatsApp, interactivo_2 = SMS, llamada = IVR. */
function canalDelPaso(paso: PasoCascada): CanalVentana {
  if (paso === 'llamada') return 'llamada';
  if (paso === 'interactivo_2') return 'sms';
  return 'whatsapp';
}

export async function ejecutarPasoCascada(
  deps: DepsCascada,
  datos: DatosCascada,
): Promise<ResultadoPaso> {
  const ahora = deps.ahora?.() ?? new Date();

  // Defer without touching the database when outside the contact window.
  if (datos.paso !== 'verificacion') {
    const canal = canalDelPaso(datos.paso);
    const feriados = await obtenerFeriados(deps.db);
    if (!dentroDeVentana(canal, ahora, feriados)) {
      const hasta = proximaAperturaVentana(canal, ahora, feriados);
      await deps.programar(datos, hasta);
      return { accion: 'diferido', hasta };
    }
  }

  const client = await deps.db.connect();
  try {
    await client.query('begin');
    const res = await client.query(
      `select c.id, c.estado, c.servicio, c.fecha_hora, p.nombre, p.telefonos,
              s.nombre as servicio_nombre
       from citas c
       join pacientes p on p.run = c.run_paciente
       join servicios s on s.id = c.servicio and s.establecimiento_id = c.establecimiento_id
       where c.id = $1
       for update of c`,
      [datos.citaId],
    );
    if (res.rowCount === 0) {
      await client.query('rollback');
      return { accion: 'omitido', motivo: 'cita_inexistente' };
    }
    const cita = res.rows[0] as FilaCita;

    // 'informativo' fires while the cita is still 'pendiente' (T-7d..T-5d,
    // well before the T-48h contact window opens); every other paso only
    // runs once the scheduler has moved the cita into 'en_contacto'. Any
    // other estado (a response, or a stale run) stops the cascade silently
    // — this is the EETT's "parada automática".
    const estadoEsperado = datos.paso === 'informativo' ? 'pendiente' : 'en_contacto';
    if (cita.estado !== estadoEsperado) {
      await client.query('rollback');
      return { accion: 'omitido', motivo: `estado_${cita.estado}` };
    }

    // The appointment time arrived before the cascade finished: stop.
    if (cita.fecha_hora.getTime() <= ahora.getTime()) {
      await client.query('rollback');
      return { accion: 'omitido', motivo: 'cita_vencida' };
    }

    if (datos.paso === 'verificacion') {
      await transicionar(client, {
        citaId: cita.id,
        hacia: 'incontactable',
        actor: 'sistema:cascada',
        motivo: 'episodio completo sin respuesta',
      });
      await client.query('commit');
      return { accion: 'incontactable' };
    }

    // Step-level idempotency: one attempt per (cita, paso); only a failed
    // attempt may be retried.
    const previo = await client.query(
      `select id, resultado from intentos_contacto
       where cita_id = $1 and paso = $2
       for update`,
      [cita.id, datos.paso],
    );
    const intentoPrevio = previo.rows[0] as { id: string; resultado: string } | undefined;
    if (intentoPrevio !== undefined && intentoPrevio.resultado !== 'fallido') {
      await client.query('rollback');
      return { accion: 'omitido', motivo: 'paso_ya_ejecutado' };
    }

    const resultado = await ejecutarEnvio(deps, client, cita, datos, intentoPrevio?.id);
    await client.query('commit');

    // Chain the next step only after this one is safely persisted.
    // 'informativo' is one-shot: it never enters the 3-attempt cascade.
    if (resultado.accion === 'enviado' && datos.paso !== 'informativo') {
      const siguiente = siguientePaso(datos.citaId, datos.paso as PasoCascada);
      if (siguiente !== null) {
        const ejecutarEn = calcularProximaEjecucion(datos.paso as PasoCascada, cita.fecha_hora, ahora);
        await deps.programar(siguiente, ejecutarEn);
      }
    }
    return resultado;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

function siguientePaso(citaId: string, actual: PasoCascada): DatosCascada | null {
  if (actual === 'interactivo_1') return { citaId, paso: 'interactivo_2' };
  if (actual === 'interactivo_2') return { citaId, paso: 'llamada' };
  if (actual === 'llamada') return { citaId, paso: 'verificacion' };
  return null; // 'informativo' does not chain
}

/**
 * Anchors the next step to `fechaHora` (the cita's time), not to an offset
 * from `ahora` — the EETT fixes `llamada` at exactly T-24h regardless of
 * when `interactivo_2` actually ran. `interactivo_2` itself just needs 120
 * min of separation from `interactivo_1`'s real send time (mismo canal).
 */
function calcularProximaEjecucion(pasoActual: PasoCascada, fechaHora: Date, ahora: Date): Date {
  if (pasoActual === 'interactivo_1') {
    return new Date(ahora.getTime() + MINUTOS_ENTRE_INTERACTIVOS * 60_000);
  }
  if (pasoActual === 'interactivo_2') {
    const anclaLlamada = fechaHora.getTime() - HORAS_ANTES_LLAMADA * 3_600_000;
    return new Date(Math.max(ahora.getTime(), anclaLlamada));
  }
  // pasoActual === 'llamada'
  return new Date(ahora.getTime() + HORAS_VERIFICACION_POST_LLAMADA * 3_600_000);
}

async function ejecutarEnvio(
  deps: DepsCascada,
  client: pg.PoolClient,
  cita: FilaCita,
  datos: DatosCascada,
  intentoFallidoId: string | undefined,
): Promise<ResultadoPaso> {
  const paso = datos.paso as PasoCascada;
  const variables = {
    nombre: cita.nombre,
    servicio: cita.servicio_nombre,
    fechaLocal: formatearSantiago(cita.fecha_hora),
  };

  const canal = canalDelPaso(paso);
  const plantilla: string = {
    informativo: PLANTILLA_WHATSAPP_INFORMATIVO,
    interactivo_1: PLANTILLA_WHATSAPP_BOTONES,
    interactivo_2: PLANTILLA_SMS_ENLACE,
    llamada: GUION_LLAMADA_CONFIRMACION,
  }[paso];

  const telefono = cita.telefonos[0];
  if (telefono === undefined) {
    await guardarIntento(client, cita.id, datos, {
      canal,
      plantilla,
      resultado: 'fallido',
      externalMessageId: null,
      intentoFallidoId,
    });
    return { accion: 'fallido', error: 'paciente_sin_telefono' };
  }

  try {
    let externalMessageId: string;
    if (paso === 'llamada') {
      const llamada = await deps.llamada.llamar({
        telefono,
        guion: plantilla,
        texto: textoLlamadaConfirmacion(variables),
        remitente: PREFIJO_LLAMADA_SALIENTE,
      });
      externalMessageId = llamada.externalCallId;
    } else if (paso === 'interactivo_2') {
      const envio = await deps.sms.enviar({
        telefono,
        plantilla,
        texto: textoSmsEnlace({
          ...variables,
          // TODO(hito 4): replace with the signed single-use token URL.
          enlace: `${deps.baseUrlRespuesta}/r/${cita.id}`,
        }),
      });
      externalMessageId = envio.externalMessageId;
    } else {
      // 'informativo' o 'interactivo_1', ambos por WhatsApp.
      const texto = paso === 'informativo' ? textoWhatsAppInformativo(variables) : textoWhatsAppBotones(variables);
      const envio = await deps.whatsapp.enviar({ telefono, plantilla, texto });
      externalMessageId = envio.externalMessageId;
    }
    await guardarIntento(client, cita.id, datos, {
      canal,
      plantilla,
      resultado: 'enviado',
      externalMessageId,
      intentoFallidoId,
    });
    return { accion: 'enviado', canal, externalMessageId };
  } catch (err) {
    // Record the failure and keep it retryable (pg-boss backoff re-runs the
    // job; the 'fallido' attempt row authorizes the resend).
    await guardarIntento(client, cita.id, datos, {
      canal,
      plantilla,
      resultado: 'fallido',
      externalMessageId: null,
      intentoFallidoId,
    });
    return { accion: 'fallido', error: err instanceof Error ? err.message : String(err) };
  }
}

async function guardarIntento(
  client: pg.PoolClient,
  citaId: string,
  datos: DatosCascada,
  intento: {
    canal: 'whatsapp' | 'sms' | 'llamada';
    plantilla: string | null;
    resultado: 'enviado' | 'fallido' | 'pendiente';
    externalMessageId: string | null;
    intentoFallidoId: string | undefined;
  },
): Promise<void> {
  if (intento.intentoFallidoId !== undefined) {
    await client.query(
      `update intentos_contacto
       set canal = $2, plantilla = $3, resultado = $4, external_message_id = $5,
           enviado_at = now()
       where id = $1`,
      [
        intento.intentoFallidoId,
        intento.canal,
        intento.plantilla,
        intento.resultado,
        intento.externalMessageId,
      ],
    );
    return;
  }
  await client.query(
    `insert into intentos_contacto
       (cita_id, canal, plantilla, resultado, external_message_id, paso)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      citaId,
      intento.canal,
      intento.plantilla,
      intento.resultado,
      intento.externalMessageId,
      datos.paso,
    ],
  );
}
