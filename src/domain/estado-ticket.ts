/**
 * Ticket lifecycle state machine (EETT §6, mesa de ayuda) — mirrors the
 * pattern of `estado-cita.ts`: a declarative transition table, a single
 * `transicionarTicket()` entry point that locks, validates, persists and
 * audits in the caller's transaction.
 *
 * Lineal, sin reapertura en v1 (DECISIONS.md D-034):
 *
 *   abierto → en_atencion → resuelto → cerrado
 *
 * Dos reglas de negocio viven en la transición, no solo en la tabla:
 *  - Entrar a 'en_atencion' por primera vez estampa `primera_respuesta_at`
 *    (campo 8 del EETT).
 *  - Entrar a 'resuelto' exige `causaRaiz` (campo 11) y estampa
 *    `resolucion_at` (campo 9).
 */
import type { ClienteDb } from './estado-cita';

export const ESTADOS_TICKET = ['abierto', 'en_atencion', 'resuelto', 'cerrado'] as const;

export type EstadoTicket = (typeof ESTADOS_TICKET)[number];

export const TABLA_TRANSICIONES_TICKET: Readonly<Record<EstadoTicket, readonly EstadoTicket[]>> = {
  abierto: ['en_atencion'],
  en_atencion: ['resuelto'],
  resuelto: ['cerrado'],
  cerrado: [],
};

export function esTransicionTicketValida(desde: EstadoTicket, hacia: EstadoTicket): boolean {
  return TABLA_TRANSICIONES_TICKET[desde].includes(hacia);
}

export class TransicionTicketInvalidaError extends Error {
  constructor(
    readonly ticketId: string,
    readonly desde: EstadoTicket,
    readonly hacia: EstadoTicket,
  ) {
    super(`Invalid transition for ticket ${ticketId}: ${desde} -> ${hacia}`);
    this.name = 'TransicionTicketInvalidaError';
  }
}

export class TicketNoEncontradoError extends Error {
  constructor(readonly ticketId: string) {
    super(`Ticket not found: ${ticketId}`);
    this.name = 'TicketNoEncontradoError';
  }
}

export class CausaRaizRequeridaError extends Error {
  constructor(readonly ticketId: string) {
    super(`causa_raiz es obligatoria para resolver el ticket ${ticketId}`);
    this.name = 'CausaRaizRequeridaError';
  }
}

export interface ComandoTransicionTicket {
  ticketId: string;
  hacia: EstadoTicket;
  /** Who initiated it: a user id, 'sistema', etc. */
  actor: string;
  /** Required when `hacia === 'resuelto'`. */
  causaRaiz?: string;
  /** Appended to `acciones` (log narrativo) si viene informada. */
  nota?: string;
}

export interface ResultadoTransicionTicket {
  ticketId: string;
  desde: EstadoTicket;
  hacia: EstadoTicket;
}

interface FilaTicket {
  estado: EstadoTicket;
  primera_respuesta_at: Date | null;
  acciones: string | null;
}

export async function transicionarTicket(
  db: ClienteDb,
  cmd: ComandoTransicionTicket,
): Promise<ResultadoTransicionTicket> {
  const res = await db.query(
    'select estado, primera_respuesta_at, acciones from tickets where id = $1 for update',
    [cmd.ticketId],
  );
  if (res.rowCount === 0) {
    throw new TicketNoEncontradoError(cmd.ticketId);
  }
  const fila = res.rows[0] as FilaTicket;
  const desde = fila.estado;

  if (!esTransicionTicketValida(desde, cmd.hacia)) {
    await registrarEvento(db, {
      entidad: 'ticket',
      entidadId: cmd.ticketId,
      accion: 'transicion_rechazada',
      actor: cmd.actor,
      detalle: { desde, hacia: cmd.hacia },
    });
    throw new TransicionTicketInvalidaError(cmd.ticketId, desde, cmd.hacia);
  }

  if (cmd.hacia === 'resuelto' && (cmd.causaRaiz === undefined || cmd.causaRaiz.trim() === '')) {
    throw new CausaRaizRequeridaError(cmd.ticketId);
  }

  const estampaPrimeraRespuesta = cmd.hacia === 'en_atencion' && fila.primera_respuesta_at === null;
  const estampaResolucion = cmd.hacia === 'resuelto';
  const acciones = concatenarAccion(fila.acciones, cmd.actor, cmd.nota);

  await db.query(
    `update tickets
     set estado = $2,
         causa_raiz = coalesce($3, causa_raiz),
         acciones = $4,
         primera_respuesta_at = case when $5 then now() else primera_respuesta_at end,
         resolucion_at = case when $6 then now() else resolucion_at end,
         actualizado_at = now()
     where id = $1`,
    [cmd.ticketId, cmd.hacia, cmd.causaRaiz ?? null, acciones, estampaPrimeraRespuesta, estampaResolucion],
  );

  await registrarEvento(db, {
    entidad: 'ticket',
    entidadId: cmd.ticketId,
    accion: 'transicion_estado',
    actor: cmd.actor,
    detalle: { desde, hacia: cmd.hacia, nota: cmd.nota ?? null },
  });

  return { ticketId: cmd.ticketId, desde, hacia: cmd.hacia };
}

function concatenarAccion(actual: string | null, actor: string, nota: string | undefined): string | null {
  if (nota === undefined) return actual;
  const linea = `[${new Date().toISOString()}] ${actor}: ${nota}`;
  return actual === null ? linea : `${actual}\n${linea}`;
}

interface EventoAuditoria {
  entidad: string;
  entidadId: string;
  accion: string;
  actor: string;
  detalle: Record<string, unknown>;
}

async function registrarEvento(db: ClienteDb, evento: EventoAuditoria): Promise<void> {
  await db.query(
    `insert into eventos_auditoria (entidad, entidad_id, accion, actor, detalle)
     values ($1, $2, $3, $4, $5)`,
    [evento.entidad, evento.entidadId, evento.accion, evento.actor, JSON.stringify(evento.detalle)],
  );
}
