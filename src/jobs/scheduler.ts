/**
 * Hourly contact scheduler (RF-2): picks 'pendiente' appointments whose
 * fecha_hora falls in the +24h..+48h window, moves them to 'en_contacto'
 * (which is what makes the selection idempotent — a cita never enters the
 * cascade twice) and enqueues the first cascade step ('interactivo_1',
 * D-029/D-031).
 *
 * A recovery pass re-enqueues appointments that entered 'en_contacto' but
 * never produced an attempt (e.g. the queue insert was lost after the
 * transition committed); the enqueue callback must be idempotent per cita
 * (pg-boss singletonKey covers that in the worker).
 *
 * `encolarInformativos` is a separate, independent pass (also hourly, see
 * worker.ts) for the EETT's one-way informational reminder: it enqueues the
 * 'informativo' step for 'pendiente' citas whose fecha_hora falls 5-7 days
 * out, WITHOUT transitioning estado (that transition is reserved for the
 * +24h/+48h window above) — the informational reminder and the interactive
 * cascade are independent tracks that happen to share the same cita.
 */
import type pg from 'pg';
import { transicionar } from '@/domain/estado-cita';

export interface DepsScheduler {
  db: pg.Pool;
  /** Enqueues cascade step 1 for the cita; must be idempotent per cita. */
  encolar: (citaId: string) => Promise<void>;
  ahora?: () => Date;
  /** Minutes an attempt-less 'en_contacto' cita may sit before re-enqueue. */
  umbralRecuperacionMin?: number;
}

export interface ResumenScheduler {
  encoladas: string[];
  reencoladas: string[];
}

export async function encolarContactos(deps: DepsScheduler): Promise<ResumenScheduler> {
  const ahora = deps.ahora?.() ?? new Date();
  const umbralMin = deps.umbralRecuperacionMin ?? 90;

  const client = await deps.db.connect();
  const encoladas: string[] = [];
  try {
    await client.query('begin');
    const elegibles = await client.query(
      `select id from citas
       where estado = 'pendiente'
         and fecha_hora >= $1::timestamptz + interval '24 hours'
         and fecha_hora <= $1::timestamptz + interval '48 hours'
       order by fecha_hora
       for update skip locked`,
      [ahora],
    );
    for (const fila of elegibles.rows as { id: string }[]) {
      await transicionar(client, {
        citaId: fila.id,
        hacia: 'en_contacto',
        actor: 'scheduler',
        motivo: 'ingreso_cascada',
      });
      encoladas.push(fila.id);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  // Enqueue AFTER commit so a rollback never leaves ghost jobs. A crash in
  // between is healed by the recovery pass below.
  for (const citaId of encoladas) {
    await deps.encolar(citaId);
  }

  const huerfanas = await deps.db.query(
    `select c.id from citas c
     where c.estado = 'en_contacto'
       and c.fecha_hora > $1::timestamptz
       and c.actualizado_at < $1::timestamptz - make_interval(mins => $2)
       and not exists (select 1 from intentos_contacto ic where ic.cita_id = c.id)
     order by c.fecha_hora`,
    [ahora, umbralMin],
  );
  const reencoladas: string[] = [];
  for (const fila of huerfanas.rows as { id: string }[]) {
    await deps.encolar(fila.id);
    reencoladas.push(fila.id);
  }

  return { encoladas, reencoladas };
}

export interface ResumenInformativos {
  encoladas: string[];
}

/**
 * EETT: recordatorio informativo 5-7 días antes de la cita, enviado "al
 * momento del agendamiento" — en la práctica, un scan hourly en vez de un
 * hook en la ingesta, para no acoplar pg-boss a la transacción de carga de
 * agenda (D-031). El anti-join contra `intentos_contacto` evita reencolar
 * una cita que ya lo recibió; no hay transición de estado.
 */
export async function encolarInformativos(deps: DepsScheduler): Promise<ResumenInformativos> {
  const ahora = deps.ahora?.() ?? new Date();

  const elegibles = await deps.db.query(
    `select c.id from citas c
     where c.estado = 'pendiente'
       and c.fecha_hora >= $1::timestamptz + interval '5 days'
       and c.fecha_hora <= $1::timestamptz + interval '7 days'
       and not exists (
         select 1 from intentos_contacto ic
         where ic.cita_id = c.id and ic.paso = 'informativo'
       )
     order by c.fecha_hora`,
    [ahora],
  );

  const encoladas: string[] = [];
  for (const fila of elegibles.rows as { id: string }[]) {
    await deps.encolar(fila.id);
    encoladas.push(fila.id);
  }

  return { encoladas };
}
