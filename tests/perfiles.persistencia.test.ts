import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { obtenerContextoSesion } from '../src/lib/perfiles-repo';
import { aplicarContextoSesion } from '../src/lib/rls-contexto';
import { runSintetico } from '../src/domain/run';
import type { ContextoSesion } from '../src/domain/perfil';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('perfiles: constraint + obtenerContextoSesion', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('un rol local sin establecimiento_id viola el constraint', async () => {
    const userId = randomUUID();
    await expect(
      pool.query(`insert into perfiles (user_id, rol, nombre) values ($1, 'admision', 'Sin sitio')`, [
        userId,
      ]),
    ).rejects.toThrow();
  });

  it('coordinador_red sin establecimiento_id es válido', async () => {
    const userId = randomUUID();
    await pool.query(`insert into perfiles (user_id, rol, nombre) values ($1, 'coordinador_red', 'Mariela')`, [
      userId,
    ]);
    const fila = await pool.query('select rol from perfiles where user_id = $1', [userId]);
    expect(fila.rows[0].rol).toBe('coordinador_red');
  });

  it('obtenerContextoSesion retorna null para un user_id desconocido', async () => {
    expect(await obtenerContextoSesion(pool, randomUUID())).toBeNull();
  });

  it('obtenerContextoSesion retorna el rol y establecimiento sembrados', async () => {
    const userId = randomUUID();
    await pool.query(
      `insert into perfiles (user_id, rol, establecimiento_id, nombre)
       values ($1, 'admision', 'hospital-puerto-aysen', 'Juan')`,
      [userId],
    );
    const contexto = await obtenerContextoSesion(pool, userId);
    expect(contexto).toEqual({
      userId,
      rol: 'admision',
      establecimientoId: 'hospital-puerto-aysen',
    });
  });
});

describe.skipIf(!DATABASE_URL)('RLS de escritura por rol (D-035)', () => {
  let pool: pg.Pool;
  let seq = 70_000_000 + (Date.now() % 900_000);
  const SITIO_A = 'hospital-puerto-aysen';
  const SITIO_B = 'hospital-cochrane';

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

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

  async function crearPaciente(): Promise<string> {
    seq += 1;
    const run = runSintetico(seq);
    await pool.query(
      `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
       values ($1, $2, array['+56999930001'], true) on conflict (run) do nothing`,
      [run, `Perfil ${seq}`],
    );
    return run;
  }

  async function crearAdmisionEn(establecimientoId: string): Promise<ContextoSesion> {
    const userId = randomUUID();
    await pool.query(
      `insert into perfiles (user_id, rol, establecimiento_id, nombre)
       values ($1, 'admision', $2, 'Admisión de prueba')`,
      [userId, establecimientoId],
    );
    return { userId, rol: 'admision', establecimientoId };
  }

  async function crearCoordinadorRed(): Promise<ContextoSesion> {
    const userId = randomUUID();
    await pool.query(
      `insert into perfiles (user_id, rol, nombre) values ($1, 'coordinador_red', 'Coordinadora de prueba')`,
      [userId],
    );
    return { userId, rol: 'coordinador_red', establecimientoId: null };
  }

  it('admision puede insertar una cita en su propio establecimiento', async () => {
    const run = await crearPaciente();
    const admisionA = await crearAdmisionEn(SITIO_A);

    const res = await conTx(async (client) => {
      await aplicarContextoSesion(client, admisionA);
      return client.query(
        `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
         values ($1, $2, 'dermatologia', now() + interval '36 hours')
         returning id`,
        [SITIO_A, run],
      );
    });
    expect(res.rows).toHaveLength(1);
  });

  it('admision NO puede insertar una cita en otro establecimiento (RLS rechaza el insert)', async () => {
    const run = await crearPaciente();
    const admisionA = await crearAdmisionEn(SITIO_A);

    await expect(
      conTx(async (client) => {
        await aplicarContextoSesion(client, admisionA);
        return client.query(
          `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
           values ($1, $2, 'dermatologia', now() + interval '36 hours')`,
          [SITIO_B, run],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('admision puede actualizar una cita de su propio establecimiento', async () => {
    const run = await crearPaciente();
    const citaId = (
      await pool.query(
        `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
         values ($1, $2, 'dermatologia', now() + interval '36 hours') returning id`,
        [SITIO_A, run],
      )
    ).rows[0].id as string;
    const admisionA = await crearAdmisionEn(SITIO_A);

    const res = await conTx(async (client) => {
      await aplicarContextoSesion(client, admisionA);
      return client.query(`update citas set profesional = 'Dra. Actualizada' where id = $1`, [citaId]);
    });
    expect(res.rowCount).toBe(1);
  });

  it('admision no afecta filas de otro establecimiento al actualizar (RLS filtra en silencio)', async () => {
    const run = await crearPaciente();
    const citaId = (
      await pool.query(
        `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
         values ($1, $2, 'dermatologia', now() + interval '36 hours') returning id`,
        [SITIO_B, run],
      )
    ).rows[0].id as string;
    const admisionA = await crearAdmisionEn(SITIO_A);

    const res = await conTx(async (client) => {
      await aplicarContextoSesion(client, admisionA);
      return client.query(`update citas set profesional = 'No debería aplicar' where id = $1`, [citaId]);
    });
    expect(res.rowCount).toBe(0);
  });

  it('coordinador_red no puede escribir en ningún establecimiento (alcance de solo lectura)', async () => {
    const run = await crearPaciente();
    const coordinador = await crearCoordinadorRed();

    await expect(
      conTx(async (client) => {
        await aplicarContextoSesion(client, coordinador);
        return client.query(
          `insert into citas (establecimiento_id, run_paciente, servicio, fecha_hora)
           values ($1, $2, 'dermatologia', now() + interval '36 hours')`,
          [SITIO_A, run],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });
});
