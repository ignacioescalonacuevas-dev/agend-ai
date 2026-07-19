import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { CanalMock } from '../src/canales/mock';
import { runSintetico } from '../src/domain/run';
import {
  HORAS_ENTRE_PASOS,
  ejecutarPasoCascada,
  type DatosCascada,
  type DepsCascada,
} from '../src/jobs/cascada';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('ejecutarPasoCascada (RF-3)', () => {
  let pool: pg.Pool;
  // Unique base per run so re-runs against the same DB never collide.
  let seq = 50_000_000 + (Date.now() % 900_000);
  // 11:00 Santiago (winter): inside the contact window.
  const AHORA = new Date('2026-08-20T15:00:00Z');
  // 22:00 Santiago: outside the window.
  const NOCHE = new Date('2026-08-21T02:00:00Z');

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  interface Programado {
    datos: DatosCascada;
    ejecutarEn: Date;
  }

  function crearDeps(opciones?: {
    ahora?: Date;
    fallarWhatsApp?: boolean;
  }): DepsCascada & {
    programados: Programado[];
    whatsappMock: CanalMock;
    smsMock: CanalMock;
  } {
    const programados: Programado[] = [];
    const whatsappMock = new CanalMock('whatsapp', {
      fallar: () => opciones?.fallarWhatsApp === true,
    });
    const smsMock = new CanalMock('sms');
    return {
      db: pool,
      whatsapp: whatsappMock,
      sms: smsMock,
      baseUrlRespuesta: 'https://respuesta.prueba',
      ahora: () => opciones?.ahora ?? AHORA,
      programar: async (datos, ejecutarEn) => {
        programados.push({ datos, ejecutarEn });
      },
      programados,
      whatsappMock,
      smsMock,
    };
  }

  async function crearCitaEnContacto(horasDesdeAhora = 36): Promise<string> {
    seq += 1;
    const run = runSintetico(seq);
    await pool.query(
      `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
       values ($1, $2, array['+56999910001'], true) on conflict (run) do nothing`,
      [run, `Cascada ${seq}`],
    );
    const res = await pool.query(
      `insert into citas (run_paciente, servicio, fecha_hora, estado)
       values ($1, 'dermatologia', $2::timestamptz + make_interval(hours => $3), 'en_contacto')
       returning id`,
      [run, AHORA, horasDesdeAhora],
    );
    return res.rows[0].id as string;
  }

  async function intentosDe(citaId: string) {
    const res = await pool.query(
      `select canal, plantilla, resultado, external_message_id, ciclo, paso
       from intentos_contacto where cita_id = $1 order by ciclo, paso`,
      [citaId],
    );
    return res.rows;
  }

  it('paso 1 sends WhatsApp, records the attempt and schedules paso 2 at +4h', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 1 });

    expect(resultado.accion).toBe('enviado');
    expect(deps.whatsappMock.enviados).toHaveLength(1);
    expect(deps.whatsappMock.enviados[0]!.texto).toContain('le recordamos su cita');
    expect(deps.whatsappMock.enviados[0]!.texto).toContain('Dermatología');

    const intentos = await intentosDe(citaId);
    expect(intentos).toHaveLength(1);
    expect(intentos[0]).toMatchObject({
      canal: 'whatsapp',
      resultado: 'enviado',
      ciclo: 1,
      paso: 1,
    });
    expect(intentos[0].external_message_id).toMatch(/^mock-whatsapp-/);

    expect(deps.programados).toHaveLength(1);
    expect(deps.programados[0]!.datos).toEqual({ citaId, ciclo: 1, paso: 2 });
    expect(deps.programados[0]!.ejecutarEn).toEqual(
      new Date(AHORA.getTime() + HORAS_ENTRE_PASOS * 3_600_000),
    );
  });

  it('defers without side effects when outside the contact window', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps({ ahora: NOCHE });

    const resultado = await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 1 });

    expect(resultado.accion).toBe('diferido');
    expect(deps.whatsappMock.enviados).toHaveLength(0);
    expect(await intentosDe(citaId)).toHaveLength(0);
    expect(deps.programados).toHaveLength(1);
    // Next opening: Aug 21 09:00 Santiago = 13:00Z.
    expect(deps.programados[0]!.ejecutarEn.toISOString()).toBe('2026-08-21T13:00:00.000Z');
    expect(deps.programados[0]!.datos).toEqual({ citaId, ciclo: 1, paso: 1 });
  });

  it('paso 2 sends the SMS with the one-tap link', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 2 });

    expect(resultado.accion).toBe('enviado');
    expect(deps.smsMock.enviados).toHaveLength(1);
    expect(deps.smsMock.enviados[0]!.texto).toContain(`https://respuesta.prueba/r/${citaId}`);
    expect(deps.programados[0]!.datos).toEqual({ citaId, ciclo: 1, paso: 3 });
  });

  it('paso 3 queues a manual call task and chains cycle 2', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 3 });

    expect(resultado.accion).toBe('tarea_llamada_creada');
    const intentos = await intentosDe(citaId);
    expect(intentos[0]).toMatchObject({ canal: 'llamada', resultado: 'pendiente' });
    expect(deps.programados[0]!.datos).toEqual({ citaId, ciclo: 2, paso: 1 });

    const auditoria = await pool.query(
      `select count(*)::int as n from eventos_auditoria
       where entidad = 'cita' and entidad_id = $1 and accion = 'tarea_llamada_creada'`,
      [citaId],
    );
    expect(auditoria.rows[0].n).toBe(1);
  });

  it('after cycle 2 paso 3, verification marks the cita incontactable', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    await ejecutarPasoCascada(deps, { citaId, ciclo: 2, paso: 3 });
    expect(deps.programados.at(-1)!.datos).toEqual({ citaId, ciclo: 2, paso: 'verificacion' });

    const resultado = await ejecutarPasoCascada(deps, { citaId, ciclo: 2, paso: 'verificacion' });
    expect(resultado.accion).toBe('incontactable');

    const cita = await pool.query('select estado from citas where id = $1', [citaId]);
    expect(cita.rows[0].estado).toBe('incontactable');
  });

  it('stops silently once the patient responded (estado != en_contacto)', async () => {
    const citaId = await crearCitaEnContacto();
    await pool.query(`update citas set estado = 'confirmada' where id = $1`, [citaId]);
    const deps = crearDeps();

    const paso = await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 2 });
    expect(paso).toEqual({ accion: 'omitido', motivo: 'estado_confirmada' });

    const verificacion = await ejecutarPasoCascada(deps, {
      citaId,
      ciclo: 2,
      paso: 'verificacion',
    });
    expect(verificacion.accion).toBe('omitido');

    expect(deps.smsMock.enviados).toHaveLength(0);
    expect(deps.programados).toHaveLength(0);
    const cita = await pool.query('select estado from citas where id = $1', [citaId]);
    expect(cita.rows[0].estado).toBe('confirmada');
  });

  it('running the same step twice sends only once (unique ciclo/paso)', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 1 });
    const repetido = await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 1 });

    expect(repetido).toEqual({ accion: 'omitido', motivo: 'paso_ya_ejecutado' });
    expect(deps.whatsappMock.enviados).toHaveLength(1);
    expect(await intentosDe(citaId)).toHaveLength(1);
    expect(deps.programados).toHaveLength(1);
  });

  it('a failed send is recorded and the retry is allowed to resend', async () => {
    const citaId = await crearCitaEnContacto();

    const fallando = crearDeps({ fallarWhatsApp: true });
    const fallo = await ejecutarPasoCascada(fallando, { citaId, ciclo: 1, paso: 1 });
    expect(fallo.accion).toBe('fallido');
    expect((await intentosDe(citaId))[0]).toMatchObject({ resultado: 'fallido' });
    expect(fallando.programados).toHaveLength(0); // no next step after a failure

    const sano = crearDeps();
    const reintento = await ejecutarPasoCascada(sano, { citaId, ciclo: 1, paso: 1 });
    expect(reintento.accion).toBe('enviado');

    const intentos = await intentosDe(citaId);
    expect(intentos).toHaveLength(1); // same row, updated in place
    expect(intentos[0]).toMatchObject({ resultado: 'enviado', ciclo: 1, paso: 1 });
    expect(sano.programados[0]!.datos).toEqual({ citaId, ciclo: 1, paso: 2 });
  });

  it('skips contact when the appointment time already passed', async () => {
    const citaId = await crearCitaEnContacto(-1);
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, ciclo: 1, paso: 1 });
    expect(resultado).toEqual({ accion: 'omitido', motivo: 'cita_vencida' });
    expect(deps.whatsappMock.enviados).toHaveLength(0);
  });
});
