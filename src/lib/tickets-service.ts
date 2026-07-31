/**
 * Ticket creation service (EETT §6, mesa de ayuda) — mirrors the
 * parse→persist→audit shape of `ingesta-service.ts`.
 *
 * Enforces la regla no discrecional del EETT: cualquier incidente marcado
 * `interrumpeEnvioMensajes` se crea con `criticidad = 'alta'` sin importar
 * lo que haya pedido el llamador; si pidió otra cosa, el override queda
 * auditado.
 */
import { calcularLimitesSla, type CriticidadTicket } from '@/domain/sla-ticket';
import { conTransaccion } from '@/lib/db';
import { obtenerFeriados } from '@/lib/feriados-repo';

export type CanalTicket = 'telefono' | 'correo' | 'whatsapp' | 'portal' | 'presencial';

export interface DatosTicket {
  establecimientoId: string;
  canal: CanalTicket;
  solicitanteNombre: string;
  solicitanteContacto?: string;
  categoria: string;
  criticidad: CriticidadTicket;
  interrumpeEnvioMensajes?: boolean;
  profesionalAsignado?: string;
  actor: string;
}

export interface TicketCreado {
  id: string;
  numero: number;
  criticidad: CriticidadTicket;
}

export async function crearTicket(datos: DatosTicket): Promise<TicketCreado> {
  return conTransaccion(async (client) => {
    const feriados = await obtenerFeriados(client);
    const fechaApertura = new Date();
    const interrumpe = datos.interrumpeEnvioMensajes === true;
    const criticidadFinal: CriticidadTicket = interrumpe ? 'alta' : datos.criticidad;
    const limites = calcularLimitesSla(criticidadFinal, fechaApertura, feriados);

    const res = await client.query(
      `insert into tickets
         (establecimiento_id, canal, solicitante_nombre, solicitante_contacto,
          categoria, criticidad, interrumpe_envio_mensajes, profesional_asignado,
          fecha_apertura, primera_respuesta_limite, resolucion_limite)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, numero`,
      [
        datos.establecimientoId,
        datos.canal,
        datos.solicitanteNombre,
        datos.solicitanteContacto ?? null,
        datos.categoria,
        criticidadFinal,
        interrumpe,
        datos.profesionalAsignado ?? null,
        fechaApertura,
        limites.primeraRespuestaLimite,
        limites.resolucionLimite,
      ],
    );
    const fila = res.rows[0] as { id: string; numero: string | number };

    await client.query(
      `insert into eventos_auditoria (entidad, entidad_id, accion, actor, detalle)
       values ($1, $2, $3, $4, $5)`,
      [
        'ticket',
        fila.id,
        'ticket_creado',
        datos.actor,
        JSON.stringify({ criticidad: criticidadFinal, categoria: datos.categoria }),
      ],
    );

    if (interrumpe && datos.criticidad !== 'alta') {
      await client.query(
        `insert into eventos_auditoria (entidad, entidad_id, accion, actor, detalle)
         values ($1, $2, $3, $4, $5)`,
        [
          'ticket',
          fila.id,
          'criticidad_forzada_alta',
          'sistema:mesa-ayuda',
          JSON.stringify({ criticidadSolicitada: datos.criticidad }),
        ],
      );
    }

    return { id: fila.id, numero: Number(fila.numero), criticidad: criticidadFinal };
  });
}
