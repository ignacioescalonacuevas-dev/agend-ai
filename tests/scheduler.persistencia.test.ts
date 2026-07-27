import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { encolarContactos } from '../src/jobs/scheduler';
import { runSintetico } from '../src/domain/run';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('encolarContactos (RF-2)', () => {
  let pool: pg.Pool;
  // Unique base per run so re-runs against the same DB never collide on the
  // citas natural key (RUN stays within 8 digits: 40.0M–40.9M).
  let seq = 40_000_000 + (Date.now() % 900_000);
  // Fixed reference instant, inside the contact window (11:00 Santiago).
  const AHORA = new Date('2026-08-20T15:00:00Z');

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function crearCita(horasDesdeAhora: number, estado = 'pendiente'): Promise<string> {
    seq += 1;
    const run = runSintetico(seq);
    await pool.query(
      `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
       values ($1, $2, array['+56999900001'], true) on conflict (run) do nothing`,
      [run, `Sched ${seq}`],
    );
    const res = await pool.query(
      `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora, estado)
       values ('hospital-puerto-aysen', $1, 'dermatologia',
               $2::timestamptz + make_interval(hours => $3), $4)
       returning id`,
      [run, AHORA, horasDesdeAhora, estado],
    );
    return res.rows[0].id as string;
  }

  it('selects only pendiente citas inside the +24h..+48h window and transitions them', async () => {
    const dentro1 = await crearCita(25);
    const dentro2 = await crearCita(47);
    const borde24 = await crearCita(24); // inclusive lower bound
    const antes = await crearCita(23); // too soon
    const despues = await crearCita(49); // too far
    const confirmada = await crearCita(30, 'confirmada'); // not pendiente

    const encoladas: string[] = [];
    const resumen = await encolarContactos({
      db: pool,
      encolar: async (id) => {
        encoladas.push(id);
      },
      ahora: () => AHORA,
    });

    for (const id of [dentro1, dentro2, borde24]) {
      expect(resumen.encoladas).toContain(id);
      expect(encoladas).toContain(id);
    }
    for (const id of [antes, despues, confirmada]) {
      expect(resumen.encoladas).not.toContain(id);
    }

    const estados = await pool.query(
      `select id, estado from citas where id = any($1::uuid[])`,
      [[dentro1, dentro2, borde24, antes, despues]],
    );
    const porId = new Map(estados.rows.map((r) => [r.id, r.estado]));
    expect(porId.get(dentro1)).toBe('en_contacto');
    expect(porId.get(borde24)).toBe('en_contacto');
    expect(porId.get(antes)).toBe('pendiente');
    expect(porId.get(despues)).toBe('pendiente');

    // The transition is audited by transicionar().
    const eventos = await pool.query(
      `select count(*)::int as n from eventos_auditoria
       where entidad = 'cita' and entidad_id = $1 and accion = 'transicion_estado'
         and actor = 'scheduler'`,
      [dentro1],
    );
    expect(eventos.rows[0].n).toBe(1);
  });

  it('never enqueues the same cita twice across runs (idempotent by estado)', async () => {
    const citaId = await crearCita(30);

    const primeras: string[] = [];
    await encolarContactos({ db: pool, encolar: async (id) => void primeras.push(id), ahora: () => AHORA });
    expect(primeras).toContain(citaId);

    // transicionar() stamped actualizado_at with the real clock; align it
    // with the simulated clock so the recovery threshold behaves as in
    // production (the transition just happened).
    await pool.query('update citas set actualizado_at = $2 where id = $1', [citaId, AHORA]);

    const segundas: string[] = [];
    const resumen = await encolarContactos({
      db: pool,
      encolar: async (id) => void segundas.push(id),
      ahora: () => AHORA,
    });
    expect(segundas).not.toContain(citaId);
    expect(resumen.reencoladas).not.toContain(citaId);
  });

  it('re-enqueues orphaned en_contacto citas without attempts after the threshold', async () => {
    const citaId = await crearCita(30);
    // Simulate: transitioned long ago but the enqueue was lost.
    await pool.query(
      `update citas set estado = 'en_contacto',
              actualizado_at = $2::timestamptz - interval '3 hours'
       where id = $1`,
      [citaId, AHORA],
    );

    const encoladas: string[] = [];
    const resumen = await encolarContactos({
      db: pool,
      encolar: async (id) => void encoladas.push(id),
      ahora: () => AHORA,
    });
    expect(resumen.reencoladas).toContain(citaId);
    expect(encoladas).toContain(citaId);

    // With a registered attempt it is no longer considered orphaned.
    await pool.query(
      `insert into intentos_contacto (cita_id, canal, plantilla, resultado, ciclo, paso)
       values ($1, 'whatsapp', 'recordatorio_botones_v1', 'enviado', 1, 1)`,
      [citaId],
    );
    const resumen2 = await encolarContactos({
      db: pool,
      encolar: async () => undefined,
      ahora: () => AHORA,
    });
    expect(resumen2.reencoladas).not.toContain(citaId);
  });
});
