import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  CitaNoEncontradaError,
  TransicionInvalidaError,
  transicionar,
} from '../src/domain/estado-cita';

/**
 * Integration tests against a real Postgres with the migrations applied.
 * Run via `npm run test:full` (spins up a throwaway cluster) or point
 * DATABASE_URL at any disposable database with the migrations applied.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('transicionar() persistence', () => {
  let pool: pg.Pool;
  let seq = 0;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Runs `fn` inside a transaction; commits unless `fn` throws. */
  async function conTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Seeds a synthetic paciente + cita (fake but format-valid RUN). */
  async function crearCita(estadoInicial?: string): Promise<string> {
    seq += 1;
    const run = `${10_000_000 + seq}-K`.replace('-K', '-1');
    return conTx(async (client) => {
      await client.query(
        `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
         values ($1, $2, $3, true) on conflict (run) do nothing`,
        [run, `Paciente Sintético ${seq}`, ['+56900000' + String(100 + seq)]],
      );
      const res = await client.query(
        `insert into citas (establecimiento_id, run_paciente, servicio, profesional, fecha_hora)
         values ('hospital-puerto-aysen', $1, 'dermatologia', 'Dra. Prueba', now() + interval '36 hours')
         returning id`,
        [run],
      );
      const id = res.rows[0].id as string;
      if (estadoInicial && estadoInicial !== 'pendiente') {
        await client.query('update citas set estado = $2 where id = $1', [id, estadoInicial]);
      }
      return id;
    });
  }

  async function leerEstado(citaId: string): Promise<string> {
    const res = await pool.query('select estado from citas where id = $1', [citaId]);
    return res.rows[0].estado;
  }

  async function eventosDe(citaId: string) {
    const res = await pool.query(
      `select accion, actor, detalle from eventos_auditoria
       where entidad = 'cita' and entidad_id = $1 order by id`,
      [citaId],
    );
    return res.rows;
  }

  it('persists a valid transition and its audit event in the same tx', async () => {
    const citaId = await crearCita();

    const resultado = await conTx((client) =>
      transicionar(client, { citaId, hacia: 'en_contacto', actor: 'sistema', motivo: 'cascada' }),
    );

    expect(resultado).toEqual({ citaId, desde: 'pendiente', hacia: 'en_contacto' });
    expect(await leerEstado(citaId)).toBe('en_contacto');

    const eventos = await eventosDe(citaId);
    expect(eventos).toHaveLength(1);
    expect(eventos[0].accion).toBe('transicion_estado');
    expect(eventos[0].actor).toBe('sistema');
    expect(eventos[0].detalle).toMatchObject({
      desde: 'pendiente',
      hacia: 'en_contacto',
      motivo: 'cascada',
    });
  });

  it('walks the full happy path pendiente -> en_contacto -> confirmada', async () => {
    const citaId = await crearCita();

    await conTx((c) => transicionar(c, { citaId, hacia: 'en_contacto', actor: 'sistema' }));
    await conTx((c) =>
      transicionar(c, { citaId, hacia: 'confirmada', actor: 'webhook:whatsapp' }),
    );

    expect(await leerEstado(citaId)).toBe('confirmada');
    const acciones = (await eventosDe(citaId)).map((e) => e.accion);
    expect(acciones).toEqual(['transicion_estado', 'transicion_estado']);
  });

  it('rejects an invalid transition, keeps the state and audits the rejection', async () => {
    const citaId = await crearCita();

    // pendiente -> confirmada skips en_contacto and must be rejected.
    // Catch inside the tx and commit, so the rejection audit event survives.
    let capturado: unknown;
    await conTx(async (client) => {
      try {
        await transicionar(client, { citaId, hacia: 'confirmada', actor: 'webhook:whatsapp' });
      } catch (err) {
        capturado = err;
      }
    });

    expect(capturado).toBeInstanceOf(TransicionInvalidaError);
    const error = capturado as TransicionInvalidaError;
    expect(error.desde).toBe('pendiente');
    expect(error.hacia).toBe('confirmada');
    expect(await leerEstado(citaId)).toBe('pendiente');

    const eventos = await eventosDe(citaId);
    expect(eventos).toHaveLength(1);
    expect(eventos[0].accion).toBe('transicion_rechazada');
  });

  it('rejects transitions out of terminal states', async () => {
    const citaId = await crearCita('cancelada');

    await expect(
      conTx((c) => transicionar(c, { citaId, hacia: 'en_contacto', actor: 'sistema' })),
    ).rejects.toBeInstanceOf(TransicionInvalidaError);
    expect(await leerEstado(citaId)).toBe('cancelada');
  });

  it('throws CitaNoEncontradaError for an unknown cita', async () => {
    await expect(
      conTx((c) =>
        transicionar(c, {
          citaId: '00000000-0000-0000-0000-000000000000',
          hacia: 'en_contacto',
          actor: 'sistema',
        }),
      ),
    ).rejects.toBeInstanceOf(CitaNoEncontradaError);
  });

  it('state change and audit event share the transaction: rollback undoes both', async () => {
    const citaId = await crearCita();

    const client = await pool.connect();
    try {
      await client.query('begin');
      await transicionar(client, { citaId, hacia: 'en_contacto', actor: 'sistema' });
      await client.query('rollback');
    } finally {
      client.release();
    }

    expect(await leerEstado(citaId)).toBe('pendiente');
    expect(await eventosDe(citaId)).toHaveLength(0);
  });
});

describe.skipIf(!DATABASE_URL)('schema guarantees', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('eventos_auditoria blocks UPDATE even for the table owner (trigger guard)', async () => {
    await pool.query(
      `insert into eventos_auditoria (entidad, entidad_id, accion, actor)
       values ('test', 'x', 'prueba', 'test')`,
    );
    await expect(
      pool.query(`update eventos_auditoria set actor = 'tampered' where entidad = 'test'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`delete from eventos_auditoria where entidad = 'test'`),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('truncate eventos_auditoria')).rejects.toThrow(/append-only/);
  });

  it('eventos_auditoria denies UPDATE/DELETE to application roles at GRANT level', async () => {
    const client = await pool.connect();
    try {
      await client.query('set role authenticated');
      await expect(
        client.query(`update eventos_auditoria set actor = 'x' where entidad = 'test'`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query(`delete from eventos_auditoria where entidad = 'test'`),
      ).rejects.toThrow(/permission denied/);
      // INSERT and SELECT stay allowed: it is an append-only log, not a vault.
      await client.query(
        `insert into eventos_auditoria (entidad, entidad_id, accion, actor)
         values ('test', 'grants', 'prueba', 'authenticated')`,
      );
      const res = await client.query(
        `select count(*)::int as n from eventos_auditoria where entidad = 'test'`,
      );
      expect(res.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.query('reset role').catch(() => undefined);
      client.release();
    }
  });

  it('citas dedups by natural key RUN + servicio + fecha_hora (RF-1)', async () => {
    await pool.query(
      `insert into pacientes (run, nombre) values ('20000001-1', 'Dup Test')
       on conflict (run) do nothing`,
    );
    // Fixed fixture: remove leftovers from previous runs on the same DB.
    await pool.query(`delete from citas where run_paciente = '20000001-1'`);
    const fecha = '2026-08-01T14:00:00Z';
    await pool.query(
      `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
       values ('hospital-puerto-aysen', '20000001-1', 'oftalmologia', $1)`,
      [fecha],
    );
    await expect(
      pool.query(
        `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
         values ('hospital-puerto-aysen', '20000001-1', 'oftalmologia', $1)`,
        [fecha],
      ),
    ).rejects.toThrow(/citas_clave_natural/);
  });

  it('a cupo can never hold two live offers at once (partial unique index)', async () => {
    await pool.query(
      `insert into pacientes (run, nombre) values ('20000002-K', 'Oferta Test')
       on conflict (run) do nothing`,
    );
    const cita = await pool.query(
      `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora, estado_cupo)
       values ('hospital-puerto-aysen', '20000002-K', 'traumatologia',
               now() + interval '30 hours', 'liberado')
       returning id`,
    );
    const cupoId = cita.rows[0].id;
    await pool.query(
      `insert into ofertas_recupero (cupo_cita_id, run_paciente, expira_at)
       values ($1, '20000002-K', now() + interval '2 hours')`,
      [cupoId],
    );
    await expect(
      pool.query(
        `insert into ofertas_recupero (cupo_cita_id, run_paciente, expira_at)
         values ($1, '20000002-K', now() + interval '2 hours')`,
        [cupoId],
      ),
    ).rejects.toThrow(/ofertas_recupero_una_activa_por_cupo/);
  });

  it('rejects a malformed RUN at the schema level', async () => {
    await expect(
      pool.query(`insert into pacientes (run, nombre) values ('12.345.678-5', 'Mal RUN')`),
    ).rejects.toThrow(/pacientes_run_formato/);
  });
});
