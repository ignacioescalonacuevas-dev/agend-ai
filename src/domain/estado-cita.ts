/**
 * Appointment state machine — single source of truth (PRD RF-5).
 *
 * Every state transition in the system goes through `transicionar()`, which
 * validates against `TABLA_TRANSICIONES`, persists the new state and emits
 * the audit event in the SAME database transaction (owned by the caller).
 *
 * Critical business rule: silence NEVER frees a slot. Only an explicit
 * 'cancelada' or 'reagendar' transition triggers slot recovery (RF-6);
 * 'incontactable' leaves the slot untouched.
 */

export const ESTADOS_CITA = [
  'pendiente',
  'en_contacto',
  'confirmada',
  'cancelada',
  'reagendar',
  'incontactable',
] as const;

export type EstadoCita = (typeof ESTADOS_CITA)[number];

/**
 * Transition table, exactly as specified in RF-5:
 *
 *   pendiente → en_contacto → { confirmada | cancelada | reagendar | incontactable }
 *
 * States with an empty list are terminal for Fase 0. Possible extensions
 * (late responses after 'incontactable', a patient cancelling after having
 * confirmed) are intentionally NOT included; they are recorded as open
 * proposals in DECISIONS.md pending product sign-off.
 */
export const TABLA_TRANSICIONES: Readonly<Record<EstadoCita, readonly EstadoCita[]>> = {
  pendiente: ['en_contacto'],
  en_contacto: ['confirmada', 'cancelada', 'reagendar', 'incontactable'],
  confirmada: [],
  cancelada: [],
  reagendar: [],
  incontactable: [],
};

export function esTransicionValida(desde: EstadoCita, hacia: EstadoCita): boolean {
  return TABLA_TRANSICIONES[desde].includes(hacia);
}

export class TransicionInvalidaError extends Error {
  constructor(
    readonly citaId: string,
    readonly desde: EstadoCita,
    readonly hacia: EstadoCita,
  ) {
    super(`Invalid transition for cita ${citaId}: ${desde} -> ${hacia}`);
    this.name = 'TransicionInvalidaError';
  }
}

export class CitaNoEncontradaError extends Error {
  constructor(readonly citaId: string) {
    super(`Cita not found: ${citaId}`);
    this.name = 'CitaNoEncontradaError';
  }
}

/**
 * Minimal structural interface satisfied by `pg.PoolClient` / `pg.Client`.
 * Keeps the domain module free of a hard dependency on the driver.
 */
export interface ClienteDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface ComandoTransicion {
  citaId: string;
  hacia: EstadoCita;
  /** Who initiated it: a user id, 'sistema', 'webhook:whatsapp', 'webhook:sms', ... */
  actor: string;
  motivo?: string;
  /** Extra context stored in the audit event (message ids, payload refs, ...). */
  detalle?: Record<string, unknown>;
}

export interface ResultadoTransicion {
  citaId: string;
  desde: EstadoCita;
  hacia: EstadoCita;
}

/**
 * Executes a state transition atomically. MUST be called inside an open
 * transaction owned by the caller — the row lock and the audit event only
 * make sense within one.
 *
 * Behaviour:
 *  - Locks the cita row (`FOR UPDATE`) so concurrent transitions serialize.
 *  - Valid transition: updates `citas.estado` and inserts the
 *    'transicion_estado' audit event; both live or die with the caller's tx.
 *  - Invalid transition: inserts a 'transicion_rechazada' audit event and
 *    throws `TransicionInvalidaError`. No state is changed, so callers should
 *    catch and COMMIT to preserve the rejection event (rolling back is safe
 *    but loses that audit record).
 */
export async function transicionar(
  db: ClienteDb,
  cmd: ComandoTransicion,
): Promise<ResultadoTransicion> {
  const res = await db.query('select estado from citas where id = $1 for update', [cmd.citaId]);
  if (res.rowCount === 0) {
    throw new CitaNoEncontradaError(cmd.citaId);
  }
  const desde = res.rows[0].estado as EstadoCita;

  if (!esTransicionValida(desde, cmd.hacia)) {
    await registrarEvento(db, {
      entidad: 'cita',
      entidadId: cmd.citaId,
      accion: 'transicion_rechazada',
      actor: cmd.actor,
      detalle: { desde, hacia: cmd.hacia, motivo: cmd.motivo ?? null, ...cmd.detalle },
    });
    throw new TransicionInvalidaError(cmd.citaId, desde, cmd.hacia);
  }

  await db.query('update citas set estado = $2, actualizado_at = now() where id = $1', [
    cmd.citaId,
    cmd.hacia,
  ]);

  await registrarEvento(db, {
    entidad: 'cita',
    entidadId: cmd.citaId,
    accion: 'transicion_estado',
    actor: cmd.actor,
    detalle: { desde, hacia: cmd.hacia, motivo: cmd.motivo ?? null, ...cmd.detalle },
  });

  return { citaId: cmd.citaId, desde, hacia: cmd.hacia };
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
