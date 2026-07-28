import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { CanalLlamadaMock } from '../src/canales/ivr-mock';
import { CanalMock } from '../src/canales/mock';
import { runSintetico } from '../src/domain/run';
import {
  HORAS_ANTES_LLAMADA,
  HORAS_VERIFICACION_POST_LLAMADA,
  MINUTOS_ENTRE_INTERACTIVOS,
  ejecutarPasoCascada,
  type DatosCascada,
  type DepsCascada,
} from '../src/jobs/cascada';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('ejecutarPasoCascada (RF-3, D-029/D-031)', () => {
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
    fallarLlamada?: boolean;
  }): DepsCascada & {
    programados: Programado[];
    whatsappMock: CanalMock;
    smsMock: CanalMock;
    llamadaMock: CanalLlamadaMock;
  } {
    const programados: Programado[] = [];
    const whatsappMock = new CanalMock('whatsapp', {
      fallar: () => opciones?.fallarWhatsApp === true,
    });
    const smsMock = new CanalMock('sms');
    const llamadaMock = new CanalLlamadaMock({
      fallar: () => opciones?.fallarLlamada === true,
    });
    return {
      db: pool,
      whatsapp: whatsappMock,
      sms: smsMock,
      llamada: llamadaMock,
      baseUrlRespuesta: 'https://respuesta.prueba',
      ahora: () => opciones?.ahora ?? AHORA,
      programar: async (datos, ejecutarEn) => {
        programados.push({ datos, ejecutarEn });
      },
      programados,
      whatsappMock,
      smsMock,
      llamadaMock,
    };
  }

  async function crearCita(estado: string, horasDesdeAhora: number): Promise<string> {
    seq += 1;
    const run = runSintetico(seq);
    await pool.query(
      `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
       values ($1, $2, array['+56999910001'], true) on conflict (run) do nothing`,
      [run, `Cascada ${seq}`],
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

  const crearCitaEnContacto = (horasDesdeAhora = 36) => crearCita('en_contacto', horasDesdeAhora);
  const crearCitaPendiente = (horasDesdeAhora = 150) => crearCita('pendiente', horasDesdeAhora);

  async function intentosDe(citaId: string) {
    const res = await pool.query(
      `select canal, plantilla, resultado, external_message_id, paso
       from intentos_contacto where cita_id = $1 order by enviado_at`,
      [citaId],
    );
    return res.rows;
  }

  it('paso informativo sends a one-way WhatsApp reminder and does not chain', async () => {
    const citaId = await crearCitaPendiente();
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'informativo' });

    expect(resultado.accion).toBe('enviado');
    expect(deps.whatsappMock.enviados).toHaveLength(1);
    expect(deps.whatsappMock.enviados[0]!.texto).toContain('solo informativo');

    const intentos = await intentosDe(citaId);
    expect(intentos).toHaveLength(1);
    expect(intentos[0]).toMatchObject({ canal: 'whatsapp', resultado: 'enviado', paso: 'informativo' });

    expect(deps.programados).toHaveLength(0);
    const cita = await pool.query('select estado from citas where id = $1', [citaId]);
    expect(cita.rows[0].estado).toBe('pendiente');
  });

  it('paso informativo is skipped once the cita already entered the interactive cascade', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'informativo' });
    expect(resultado).toEqual({ accion: 'omitido', motivo: 'estado_en_contacto' });
    expect(deps.whatsappMock.enviados).toHaveLength(0);
  });

  it('interactivo_1 sends WhatsApp with buttons and schedules interactivo_2 at +120min', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_1' });

    expect(resultado.accion).toBe('enviado');
    expect(deps.whatsappMock.enviados).toHaveLength(1);
    expect(deps.whatsappMock.enviados[0]!.texto).toContain('le recordamos su cita');
    expect(deps.whatsappMock.enviados[0]!.texto).toContain('Dermatología');

    const intentos = await intentosDe(citaId);
    expect(intentos).toHaveLength(1);
    expect(intentos[0]).toMatchObject({ canal: 'whatsapp', resultado: 'enviado', paso: 'interactivo_1' });
    expect(intentos[0].external_message_id).toMatch(/^mock-whatsapp-/);

    expect(deps.programados).toHaveLength(1);
    expect(deps.programados[0]!.datos).toEqual({ citaId, paso: 'interactivo_2' });
    expect(deps.programados[0]!.ejecutarEn).toEqual(
      new Date(AHORA.getTime() + MINUTOS_ENTRE_INTERACTIVOS * 60_000),
    );
  });

  it('defers without side effects when outside the contact window', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps({ ahora: NOCHE });

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_1' });

    expect(resultado.accion).toBe('diferido');
    expect(deps.whatsappMock.enviados).toHaveLength(0);
    expect(await intentosDe(citaId)).toHaveLength(0);
    expect(deps.programados).toHaveLength(1);
    // interactivo_1 = WhatsApp; next opening: Aug 21 (Friday) 08:30 Santiago = 12:30Z.
    expect(deps.programados[0]!.ejecutarEn.toISOString()).toBe('2026-08-21T12:30:00.000Z');
    expect(deps.programados[0]!.datos).toEqual({ citaId, paso: 'interactivo_1' });
  });

  it('interactivo_2 sends the SMS and anchors llamada to T-24h when that is still ahead', async () => {
    // fecha_hora = AHORA+36h, so T-24h = AHORA+12h (ahead of "ahora").
    const citaId = await crearCitaEnContacto(36);
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_2' });

    expect(resultado.accion).toBe('enviado');
    expect(deps.smsMock.enviados).toHaveLength(1);
    expect(deps.smsMock.enviados[0]!.texto).toContain(`https://respuesta.prueba/r/${citaId}`);
    expect(deps.programados[0]!.datos).toEqual({ citaId, paso: 'llamada' });
    expect(deps.programados[0]!.ejecutarEn).toEqual(
      new Date(AHORA.getTime() + 12 * 3_600_000),
    );
  });

  it('interactivo_2 runs llamada as soon as possible once T-24h has already passed', async () => {
    // fecha_hora = AHORA+20h, so T-24h = AHORA-4h (already in the past).
    const citaId = await crearCitaEnContacto(20);
    const deps = crearDeps();

    await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_2' });

    expect(deps.programados[0]!.datos).toEqual({ citaId, paso: 'llamada' });
    expect(deps.programados[0]!.ejecutarEn).toEqual(AHORA);
  });

  it('llamada places an automated IVR confirmation call and schedules verificacion at +4h', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'llamada' });

    expect(resultado.accion).toBe('enviado');
    expect(deps.llamadaMock.colocadas).toHaveLength(1);
    expect(deps.llamadaMock.colocadas[0]!.telefono).toBe('+56999910001');
    expect(deps.llamadaMock.colocadas[0]!.remitente).toBe('600');
    expect(deps.llamadaMock.colocadas[0]!.texto).toContain('presione 1');

    const intentos = await intentosDe(citaId);
    expect(intentos[0]).toMatchObject({ canal: 'llamada', resultado: 'enviado', paso: 'llamada' });
    expect(intentos[0].external_message_id).toMatch(/^mock-llamada-/);
    expect(deps.programados[0]!.datos).toEqual({ citaId, paso: 'verificacion' });
    expect(deps.programados[0]!.ejecutarEn).toEqual(
      new Date(AHORA.getTime() + HORAS_VERIFICACION_POST_LLAMADA * 3_600_000),
    );
  });

  it('a failed call is recorded and the retry is allowed to redial', async () => {
    const citaId = await crearCitaEnContacto();

    const fallando = crearDeps({ fallarLlamada: true });
    const fallo = await ejecutarPasoCascada(fallando, { citaId, paso: 'llamada' });
    expect(fallo.accion).toBe('fallido');
    expect((await intentosDe(citaId))[0]).toMatchObject({ canal: 'llamada', resultado: 'fallido' });
    expect(fallando.programados).toHaveLength(0);

    const sano = crearDeps();
    const reintento = await ejecutarPasoCascada(sano, { citaId, paso: 'llamada' });
    expect(reintento.accion).toBe('enviado');

    const intentos = await intentosDe(citaId);
    expect(intentos).toHaveLength(1); // same row, updated in place
    expect(intentos[0]).toMatchObject({ resultado: 'enviado', paso: 'llamada' });
    expect(sano.programados[0]!.datos).toEqual({ citaId, paso: 'verificacion' });
  });

  it('after the llamada step, verificacion marks the cita incontactable', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    await ejecutarPasoCascada(deps, { citaId, paso: 'llamada' });
    expect(deps.programados.at(-1)!.datos).toEqual({ citaId, paso: 'verificacion' });

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'verificacion' });
    expect(resultado.accion).toBe('incontactable');

    const cita = await pool.query('select estado from citas where id = $1', [citaId]);
    expect(cita.rows[0].estado).toBe('incontactable');
  });

  it('stops silently once the patient responded (estado != en_contacto)', async () => {
    const citaId = await crearCitaEnContacto();
    await pool.query(`update citas set estado = 'confirmada' where id = $1`, [citaId]);
    const deps = crearDeps();

    const paso = await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_2' });
    expect(paso).toEqual({ accion: 'omitido', motivo: 'estado_confirmada' });

    const verificacion = await ejecutarPasoCascada(deps, { citaId, paso: 'verificacion' });
    expect(verificacion.accion).toBe('omitido');

    expect(deps.smsMock.enviados).toHaveLength(0);
    expect(deps.programados).toHaveLength(0);
    const cita = await pool.query('select estado from citas where id = $1', [citaId]);
    expect(cita.rows[0].estado).toBe('confirmada');
  });

  it('running the same step twice sends only once (unique cita/paso)', async () => {
    const citaId = await crearCitaEnContacto();
    const deps = crearDeps();

    await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_1' });
    const repetido = await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_1' });

    expect(repetido).toEqual({ accion: 'omitido', motivo: 'paso_ya_ejecutado' });
    expect(deps.whatsappMock.enviados).toHaveLength(1);
    expect(await intentosDe(citaId)).toHaveLength(1);
    expect(deps.programados).toHaveLength(1);
  });

  it('a failed send is recorded and the retry is allowed to resend', async () => {
    const citaId = await crearCitaEnContacto();

    const fallando = crearDeps({ fallarWhatsApp: true });
    const fallo = await ejecutarPasoCascada(fallando, { citaId, paso: 'interactivo_1' });
    expect(fallo.accion).toBe('fallido');
    expect((await intentosDe(citaId))[0]).toMatchObject({ resultado: 'fallido' });
    expect(fallando.programados).toHaveLength(0); // no next step after a failure

    const sano = crearDeps();
    const reintento = await ejecutarPasoCascada(sano, { citaId, paso: 'interactivo_1' });
    expect(reintento.accion).toBe('enviado');

    const intentos = await intentosDe(citaId);
    expect(intentos).toHaveLength(1); // same row, updated in place
    expect(intentos[0]).toMatchObject({ resultado: 'enviado', paso: 'interactivo_1' });
    expect(sano.programados[0]!.datos).toEqual({ citaId, paso: 'interactivo_2' });
  });

  it('skips contact when the appointment time already passed', async () => {
    const citaId = await crearCitaEnContacto(-1);
    const deps = crearDeps();

    const resultado = await ejecutarPasoCascada(deps, { citaId, paso: 'interactivo_1' });
    expect(resultado).toEqual({ accion: 'omitido', motivo: 'cita_vencida' });
    expect(deps.whatsappMock.enviados).toHaveLength(0);
  });

  it('exposes the EETT anchors used to build the episode', () => {
    expect(MINUTOS_ENTRE_INTERACTIVOS).toBe(120);
    expect(HORAS_ANTES_LLAMADA).toBe(24);
    expect(HORAS_VERIFICACION_POST_LLAMADA).toBe(4);
  });
});
