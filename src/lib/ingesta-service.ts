/**
 * Agenda upload service (RF-1): parse → map → validate → persist → audit.
 *
 * Re-uploads update instead of duplicating (upsert on the natural key
 * RUN + servicio + fecha_hora) and NEVER touch the appointment state — a
 * re-upload must not undo a confirmation or cancellation already recorded.
 */
import type pg from 'pg';
import {
  detectarMapeo,
  validarFilas,
  type CitaNormalizada,
  type FilaRechazada,
  type MapeoColumnas,
} from '@/domain/ingesta';
import { parsearArchivoAgenda } from '@/lib/agenda-parser';
import { conTransaccion } from '@/lib/db';

export interface ReporteCarga {
  archivo: string;
  totalFilas: number;
  citasNuevas: number;
  citasActualizadas: number;
  pacientesNuevos: number;
  rechazadas: FilaRechazada[];
  mapeoUsado: MapeoColumnas;
}

export class MapeoIncompletoError extends Error {
  constructor(readonly faltantes: string[]) {
    super(
      `No se pudieron detectar columnas obligatorias: ${faltantes.join(', ')}. ` +
        'Indique el mapeo manualmente o guarde una plantilla.',
    );
    this.name = 'MapeoIncompletoError';
  }
}

export interface OpcionesCarga {
  /** Which of the ten establecimientos this upload belongs to. */
  establecimientoId: string;
  actor: string;
  /** Explicit mapping; omitted = auto-detect from headers. */
  mapeo?: MapeoColumnas;
  /** Saves the effective mapping under this template name for reuse. */
  guardarPlantilla?: string;
}

export async function cargarAgenda(
  contenido: Buffer,
  nombreArchivo: string,
  opciones: OpcionesCarga,
): Promise<ReporteCarga> {
  const { encabezados, filas } = await parsearArchivoAgenda(contenido, nombreArchivo);

  let mapeo: MapeoColumnas;
  if (opciones.mapeo !== undefined) {
    mapeo = opciones.mapeo;
  } else {
    const deteccion = detectarMapeo(encabezados);
    if (deteccion.faltantes.length > 0) {
      throw new MapeoIncompletoError(deteccion.faltantes);
    }
    mapeo = deteccion.mapeo;
  }

  return conTransaccion(async (client) => {
    const servicios = await client.query(
      'select id from servicios where establecimiento_id = $1 and activo',
      [opciones.establecimientoId],
    );
    const serviciosValidos: ReadonlySet<string> = new Set(
      servicios.rows.map((r: { id: string }) => r.id),
    );

    const { validas, rechazadas } = validarFilas(filas, mapeo, { serviciosValidos });

    let citasNuevas = 0;
    let citasActualizadas = 0;
    let pacientesNuevos = 0;

    for (const cita of validas) {
      const resultado = await persistirCita(client, opciones.establecimientoId, cita);
      if (resultado.pacienteNuevo) pacientesNuevos += 1;
      if (resultado.citaNueva) citasNuevas += 1;
      else citasActualizadas += 1;
    }

    if (opciones.guardarPlantilla !== undefined && opciones.guardarPlantilla !== '') {
      await client.query(
        `insert into plantillas_mapeo (establecimiento_id, nombre, mapeo) values ($1, $2, $3)
         on conflict (establecimiento_id, nombre) do update
           set mapeo = excluded.mapeo, actualizado_at = now()`,
        [opciones.establecimientoId, opciones.guardarPlantilla, JSON.stringify(mapeo)],
      );
    }

    await client.query(
      `insert into eventos_auditoria (entidad, entidad_id, accion, actor, detalle)
       values ('agenda', $1, 'carga_agenda', $2, $3)`,
      [
        nombreArchivo,
        opciones.actor,
        JSON.stringify({
          establecimientoId: opciones.establecimientoId,
          totalFilas: filas.length,
          citasNuevas,
          citasActualizadas,
          pacientesNuevos,
          filasRechazadas: rechazadas.length,
          erroresPorFila: rechazadas.map((r) => ({ fila: r.fila, errores: r.errores })),
        }),
      ],
    );

    return {
      archivo: nombreArchivo,
      totalFilas: filas.length,
      citasNuevas,
      citasActualizadas,
      pacientesNuevos,
      rechazadas,
      mapeoUsado: mapeo,
    };
  });
}

async function persistirCita(
  client: pg.PoolClient,
  establecimientoId: string,
  cita: CitaNormalizada,
): Promise<{ pacienteNuevo: boolean; citaNueva: boolean }> {
  // Upsert patient: refresh the name, append a not-yet-known phone. The
  // upload implies contact consent was captured upstream by admisión.
  const paciente = await client.query(
    `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
     values ($1, $2, array[$3], true)
     on conflict (run) do update set
       nombre = excluded.nombre,
       telefonos = case
         when $3 = any (pacientes.telefonos) then pacientes.telefonos
         else pacientes.telefonos || $3
       end,
       actualizado_at = now()
     returning (xmax = 0) as insertado`,
    [cita.run, cita.nombre, cita.telefono],
  );

  // Upsert appointment on the natural key. Only mutable scheduling fields
  // are refreshed; estado/origen are preserved on re-uploads.
  const fila = await client.query(
    `insert into citas (establecimiento_id, run_paciente, servicio, profesional, fecha_hora)
     values ($1, $2, $3, $4, $5)
     on conflict on constraint citas_clave_natural do update set
       profesional = excluded.profesional,
       actualizado_at = now()
     returning (xmax = 0) as insertado`,
    [establecimientoId, cita.run, cita.servicio, cita.profesional, cita.fechaHora],
  );

  return {
    pacienteNuevo: paciente.rows[0]?.insertado === true,
    citaNueva: fila.rows[0]?.insertado === true,
  };
}
