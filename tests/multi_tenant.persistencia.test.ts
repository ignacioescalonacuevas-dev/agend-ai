import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runSintetico } from '../src/domain/run';

/**
 * Integration tests for the Fase 1 multi-tenant foundation (establecimientos
 * + RLS). `postgres` is a superuser and bypasses RLS like any Postgres
 * superuser, so isolation can only be observed by actually assuming the
 * `authenticated` role — same pattern already used for the append-only
 * grant tests in estado-cita.persistencia.test.ts.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('multi-tenant isolation (Fase 1)', () => {
  let pool: pg.Pool;
  let seq = 60_000_000 + (Date.now() % 900_000);

  const SITIO_A = 'hospital-puerto-aysen';
  const SITIO_B = 'hospital-cochrane';

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function crearCita(establecimientoId: string, servicio = 'dermatologia'): Promise<string> {
    seq += 1;
    const run = runSintetico(seq);
    await pool.query(
      `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
       values ($1, $2, array['+56999920001'], true) on conflict (run) do nothing`,
      [run, `Multitenant ${seq}`],
    );
    const res = await pool.query(
      `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
       values ($1, $2, $3, now() + interval '36 hours')
       returning id`,
      [establecimientoId, run, servicio],
    );
    return res.rows[0].id as string;
  }

  /** Runs `fn` on a connection scoped as `authenticated` for one establecimiento. */
  async function comoEstablecimiento<T>(
    establecimientoId: string | null,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role authenticated');
      await client.query(`select set_config('app.coordinador_red', 'false', true)`);
      await client.query(`select set_config('app.establecimiento_id', $1, true)`, [
        establecimientoId ?? '',
      ]);
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  async function comoCoordinadorRed<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role authenticated');
      await client.query(`select set_config('app.coordinador_red', 'true', true)`);
      return await fn(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  it('a site only sees its own citas under RLS', async () => {
    const citaA = await crearCita(SITIO_A);
    const citaB = await crearCita(SITIO_B);

    const vistasDesdeA = await comoEstablecimiento(SITIO_A, (client) =>
      client.query('select id from citas where id = any($1::uuid[])', [[citaA, citaB]]),
    );
    expect(vistasDesdeA.rows.map((r) => r.id)).toEqual([citaA]);

    const vistasDesdeB = await comoEstablecimiento(SITIO_B, (client) =>
      client.query('select id from citas where id = any($1::uuid[])', [[citaA, citaB]]),
    );
    expect(vistasDesdeB.rows.map((r) => r.id)).toEqual([citaB]);
  });

  it('a session with no establecimiento set sees nothing (fails closed)', async () => {
    const citaA = await crearCita(SITIO_A);

    const vistas = await comoEstablecimiento(null, (client) =>
      client.query('select id from citas where id = $1', [citaA]),
    );
    expect(vistas.rows).toHaveLength(0);
  });

  it('el Coordinador de la Red ve citas de todos los establecimientos', async () => {
    const citaA = await crearCita(SITIO_A);
    const citaB = await crearCita(SITIO_B);

    const vistas = await comoCoordinadorRed((client) =>
      client.query('select id from citas where id = any($1::uuid[]) order by id', [
        [citaA, citaB],
      ]),
    );
    expect(vistas.rows.map((r) => r.id).sort()).toEqual([citaA, citaB].sort());
  });

  it('el mismo slug de servicio puede existir en dos establecimientos distintos', async () => {
    const servicios = await pool.query(
      `select establecimiento_id, id from servicios where id = 'dermatologia' order by establecimiento_id`,
    );
    // 'hospital-cochrane' sorts before 'hospital-puerto-aysen'.
    expect(servicios.rows.map((r) => r.establecimiento_id)).toEqual([SITIO_B, SITIO_A]);
  });

  it('lista_espera respeta el mismo aislamiento', async () => {
    seq += 1;
    const run = runSintetico(seq);
    await pool.query(
      `insert into pacientes (run, nombre) values ($1, 'Lista Espera Multitenant')
       on conflict (run) do nothing`,
      [run],
    );
    await pool.query(
      `insert into lista_espera (establecimiento_id, run_paciente, servicio, pre_consentido)
       values ($1, $2, 'dermatologia', true)
       on conflict on constraint lista_espera_unica do nothing`,
      [SITIO_A, run],
    );

    const vistoDesdeB = await comoEstablecimiento(SITIO_B, (client) =>
      client.query('select id from lista_espera where run_paciente = $1', [run]),
    );
    expect(vistoDesdeB.rows).toHaveLength(0);

    const vistoDesdeA = await comoEstablecimiento(SITIO_A, (client) =>
      client.query('select id from lista_espera where run_paciente = $1', [run]),
    );
    expect(vistoDesdeA.rows).toHaveLength(1);
  });

  it('plantillas_mapeo respeta el mismo aislamiento', async () => {
    await pool.query(
      `insert into plantillas_mapeo (establecimiento_id, nombre, mapeo)
       values ($1, 'plantilla-multitenant-test', '{"run": "RUT"}'::jsonb)
       on conflict (establecimiento_id, nombre) do nothing`,
      [SITIO_A],
    );

    const vistoDesdeB = await comoEstablecimiento(SITIO_B, (client) =>
      client.query(`select id from plantillas_mapeo where nombre = 'plantilla-multitenant-test'`),
    );
    expect(vistoDesdeB.rows).toHaveLength(0);

    const vistoDesdeA = await comoEstablecimiento(SITIO_A, (client) =>
      client.query(`select id from plantillas_mapeo where nombre = 'plantilla-multitenant-test'`),
    );
    expect(vistoDesdeA.rows).toHaveLength(1);
  });
});
