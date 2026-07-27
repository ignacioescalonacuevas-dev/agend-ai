/**
 * Contact cascade executor (RF-3).
 *
 * Steps per cycle: 1) WhatsApp template with buttons, 2) T+4h SMS with a
 * one-tap link, 3) T+8h manual-call task for an operator. A second cycle
 * mirrors the first starting T+12h; 4h after the second cycle ends, a
 * verification step marks the cita 'incontactable' if it is still waiting.
 * Silence NEVER frees the slot (RF-5): 'incontactable' only stops contact.
 *
 * Idempotency: the unique index on (cita_id, ciclo, paso) means each step
 * sends at most once, however many times its job is retried; a step whose
 * attempt failed ('fallido') is allowed to resend.
 */
import type pg from 'pg';
import type { CanalMensajeria } from '@/canales/tipos';
import {
  PLANTILLA_SMS_ENLACE,
  PLANTILLA_WHATSAPP_BOTONES,
  textoSmsEnlace,
  textoWhatsAppBotones,
} from '@/canales/plantillas';
import { transicionar, type EstadoCita } from '@/domain/estado-cita';
import { formatearSantiago } from '@/domain/fechas';
import { dentroDeVentana, proximaAperturaVentana, type CanalVentana } from '@/domain/ventana-horaria';
import { obtenerFeriados } from '@/lib/feriados-repo';

export const HORAS_ENTRE_PASOS = 4;

export interface DatosCascada {
  citaId: string;
  ciclo: 1 | 2;
  paso: 1 | 2 | 3 | 'verificacion';
}

export interface DepsCascada {
  db: pg.Pool;
  whatsapp: CanalMensajeria;
  sms: CanalMensajeria;
  /** Schedules a future cascade job (pg-boss send with startAfter). */
  programar: (datos: DatosCascada, ejecutarEn: Date) => Promise<void>;
  /** Base URL for the public one-tap response page (tokens land in hito 4). */
  baseUrlRespuesta: string;
  ahora?: () => Date;
}

export type ResultadoPaso =
  | { accion: 'enviado'; canal: 'whatsapp' | 'sms'; externalMessageId: string }
  | { accion: 'tarea_llamada_creada' }
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

/** Paso 1 = WhatsApp, paso 2 = SMS, paso 3 = llamada (EETT: ventanas distintas por canal). */
function canalDelPaso(paso: 1 | 2 | 3): CanalVentana {
  if (paso === 1) return 'whatsapp';
  if (paso === 2) return 'sms';
  return 'llamada';
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

    // A response (or any terminal state) stops the cascade silently.
    if (cita.estado !== 'en_contacto') {
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
        motivo: '2 ciclos completos sin respuesta',
      });
      await client.query('commit');
      return { accion: 'incontactable' };
    }

    // Step-level idempotency: one attempt per (cita, ciclo, paso); only a
    // failed attempt may be retried.
    const previo = await client.query(
      `select id, resultado from intentos_contacto
       where cita_id = $1 and ciclo = $2 and paso = $3
       for update`,
      [cita.id, datos.ciclo, datos.paso],
    );
    const intentoPrevio = previo.rows[0] as { id: string; resultado: string } | undefined;
    if (intentoPrevio !== undefined && intentoPrevio.resultado !== 'fallido') {
      await client.query('rollback');
      return { accion: 'omitido', motivo: 'paso_ya_ejecutado' };
    }

    const resultado = await ejecutarEnvio(deps, client, cita, datos, intentoPrevio?.id);
    await client.query('commit');

    // Chain the next step only after this one is safely persisted.
    if (resultado.accion === 'enviado' || resultado.accion === 'tarea_llamada_creada') {
      const siguiente = siguientePaso(datos);
      if (siguiente !== null) {
        await deps.programar(
          siguiente,
          new Date(ahora.getTime() + HORAS_ENTRE_PASOS * 3_600_000),
        );
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

function siguientePaso(actual: DatosCascada): DatosCascada | null {
  const { citaId, ciclo, paso } = actual;
  if (paso === 1) return { citaId, ciclo, paso: 2 };
  if (paso === 2) return { citaId, ciclo, paso: 3 };
  if (paso === 3) {
    return ciclo === 1
      ? { citaId, ciclo: 2, paso: 1 }
      : { citaId, ciclo: 2, paso: 'verificacion' };
  }
  return null;
}

async function ejecutarEnvio(
  deps: DepsCascada,
  client: pg.PoolClient,
  cita: FilaCita,
  datos: DatosCascada,
  intentoFallidoId: string | undefined,
): Promise<ResultadoPaso> {
  const variables = {
    nombre: cita.nombre,
    servicio: cita.servicio_nombre,
    fechaLocal: formatearSantiago(cita.fecha_hora),
  };

  // Paso 3 queues a manual call instead of sending a message (fase 0).
  if (datos.paso === 3) {
    await guardarIntento(client, cita.id, datos, {
      canal: 'llamada',
      plantilla: null,
      resultado: 'pendiente',
      externalMessageId: null,
      intentoFallidoId,
    });
    await client.query(
      `insert into eventos_auditoria (entidad, entidad_id, accion, actor, detalle)
       values ('cita', $1, 'tarea_llamada_creada', 'sistema:cascada', $2)`,
      [cita.id, JSON.stringify({ ciclo: datos.ciclo })],
    );
    return { accion: 'tarea_llamada_creada' };
  }

  const canal = datos.paso === 1 ? deps.whatsapp : deps.sms;
  const plantilla = datos.paso === 1 ? PLANTILLA_WHATSAPP_BOTONES : PLANTILLA_SMS_ENLACE;
  const texto =
    datos.paso === 1
      ? textoWhatsAppBotones(variables)
      : textoSmsEnlace({
          ...variables,
          // TODO(hito 4): replace with the signed single-use token URL.
          enlace: `${deps.baseUrlRespuesta}/r/${cita.id}`,
        });

  const telefono = cita.telefonos[0];
  if (telefono === undefined) {
    await guardarIntento(client, cita.id, datos, {
      canal: canal.canal,
      plantilla,
      resultado: 'fallido',
      externalMessageId: null,
      intentoFallidoId,
    });
    return { accion: 'fallido', error: 'paciente_sin_telefono' };
  }

  try {
    const envio = await canal.enviar({ telefono, plantilla, texto });
    await guardarIntento(client, cita.id, datos, {
      canal: canal.canal,
      plantilla,
      resultado: 'enviado',
      externalMessageId: envio.externalMessageId,
      intentoFallidoId,
    });
    return { accion: 'enviado', canal: canal.canal, externalMessageId: envio.externalMessageId };
  } catch (err) {
    // Record the failure and keep it retryable (pg-boss backoff re-runs the
    // job; the 'fallido' attempt row authorizes the resend).
    await guardarIntento(client, cita.id, datos, {
      canal: canal.canal,
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
       (cita_id, canal, plantilla, resultado, external_message_id, ciclo, paso)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      citaId,
      intento.canal,
      intento.plantilla,
      intento.resultado,
      intento.externalMessageId,
      datos.ciclo,
      datos.paso,
    ],
  );
}
