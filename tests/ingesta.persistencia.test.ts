import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { cargarAgenda } from '../src/lib/ingesta-service';
import { cerrarPool } from '../src/lib/db';
import { transicionar } from '../src/domain/estado-cita';

const DATABASE_URL = process.env.DATABASE_URL;

const ENCABEZADO = 'RUT Paciente;Nombre;Teléfono;Especialidad;Médico;Fecha;Hora';

function csv(filas: string[]): Buffer {
  return Buffer.from([ENCABEZADO, ...filas].join('\n'), 'utf8');
}

describe.skipIf(!DATABASE_URL)('cargarAgenda (integration)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into servicios (id, nombre) values
         ('dermatologia', 'Dermatología'),
         ('medicina-interna', 'Medicina Interna')
       on conflict (id) do nothing`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await cerrarPool();
  });

  it('loads valid rows, reports invalid ones, and audits the upload', async () => {
    const reporte = await cargarAgenda(
      csv([
        '30.111.111-8;Ana Ingesta Uno;+56 9 7000 0001;Dermatología;Dr. Uno;25-08-2026;09:30',
        '30.111.112-6;Beto Ingesta Dos;+56 9 7000 0002;Medicina Interna;Dra. Dos;25-08-2026;10:00',
        'RUN-MALO;Carla Error;+56 9 7000 0003;Dermatología;Dr. Uno;25-08-2026;10:30',
        '30.111.113-4;Dora Error;123;Astrología;Dr. Uno;01-01-2020;11:00',
      ]),
      'agenda_test.csv',
      { actor: 'test:admision' },
    );

    expect(reporte.totalFilas).toBe(4);
    expect(reporte.citasNuevas).toBe(2);
    expect(reporte.citasActualizadas).toBe(0);
    expect(reporte.rechazadas).toHaveLength(2);
    expect(reporte.rechazadas.map((r) => r.fila)).toEqual([3, 4]);

    const citas = await pool.query(
      `select c.estado, c.origen, p.nombre, p.telefonos
       from citas c join pacientes p on p.run = c.run_paciente
       where c.run_paciente = '30111111-8'`,
    );
    expect(citas.rows).toHaveLength(1);
    expect(citas.rows[0]).toMatchObject({ estado: 'pendiente', origen: 'agenda' });
    expect(citas.rows[0].telefonos).toEqual(['+56970000001']);

    const auditoria = await pool.query(
      `select detalle from eventos_auditoria
       where accion = 'carga_agenda' and entidad_id = 'agenda_test.csv'
       order by id desc limit 1`,
    );
    expect(auditoria.rows[0].detalle).toMatchObject({
      totalFilas: 4,
      citasNuevas: 2,
      filasRechazadas: 2,
    });
  });

  it('re-uploading updates by natural key without duplicating or resetting estado', async () => {
    const fila = '30.222.221-5;Elena Recarga;+56 9 7000 0010;Dermatología;Dr. Antes;26-08-2026;12:00';
    const primera = await cargarAgenda(csv([fila]), 'recarga.csv', { actor: 'test:admision' });
    expect(primera.citasNuevas).toBe(1);

    const cita = await pool.query(
      `select id from citas where run_paciente = '30222221-5' and servicio = 'dermatologia'`,
    );
    const citaId = cita.rows[0].id as string;

    // The appointment moves forward in its lifecycle between uploads.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await transicionar(client, { citaId, hacia: 'en_contacto', actor: 'test:sistema' });
      await client.query('commit');
    } finally {
      client.release();
    }

    const segunda = await cargarAgenda(
      csv([fila.replace('Dr. Antes', 'Dr. Después')]),
      'recarga.csv',
      { actor: 'test:admision' },
    );
    expect(segunda.citasNuevas).toBe(0);
    expect(segunda.citasActualizadas).toBe(1);

    const resultado = await pool.query(
      `select estado, profesional from citas where id = $1`,
      [citaId],
    );
    // profesional refreshed, estado untouched by the re-upload.
    expect(resultado.rows[0]).toEqual({ estado: 'en_contacto', profesional: 'Dr. Después' });

    const conteo = await pool.query(
      `select count(*)::int as n from citas where run_paciente = '30222221-5'`,
    );
    expect(conteo.rows[0].n).toBe(1);
  });

  it('appends new phone numbers without duplicating known ones', async () => {
    const base = '30.333.331-2;Fabián Fonos;+56 9 7000 0020;Dermatología;;27-08-2026;09:00';
    await cargarAgenda(csv([base]), 'fonos1.csv', { actor: 'test:admision' });
    // Same patient, different appointment and a second phone.
    await cargarAgenda(
      csv(['30.333.331-2;Fabián Fonos;+56 9 7000 0021;Dermatología;;28-08-2026;09:00']),
      'fonos2.csv',
      { actor: 'test:admision' },
    );
    await cargarAgenda(csv([base.replace('27-08', '29-08')]), 'fonos3.csv', {
      actor: 'test:admision',
    });

    const paciente = await pool.query(
      `select telefonos from pacientes where run = '30333331-2'`,
    );
    expect(paciente.rows[0].telefonos).toEqual(['+56970000020', '+56970000021']);
  });

  it('parses XLSX with native date cells', async () => {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Agenda');
    hoja.addRow(['RUT Paciente', 'Nombre', 'Teléfono', 'Especialidad', 'Médico', 'Fecha y hora']);
    // Excel date cell: wall-clock components, interpreted as Santiago time.
    hoja.addRow([
      '30.444.441-K',
      'Gloria Excel',
      '+56 9 7000 0030',
      'Medicina Interna',
      'Dra. Hoja',
      new Date(Date.UTC(2026, 7, 30, 15, 45)),
    ]);
    const contenido = Buffer.from(await libro.xlsx.writeBuffer());

    const reporte = await cargarAgenda(contenido, 'agenda_test.xlsx', { actor: 'test:admision' });
    expect(reporte.rechazadas).toEqual([]);
    expect(reporte.citasNuevas).toBe(1);

    const cita = await pool.query(
      `select fecha_hora from citas where run_paciente = '30444441-K'`,
    );
    // 30-08-2026 15:45 Santiago (winter, UTC-4) = 19:45Z.
    expect(new Date(cita.rows[0].fecha_hora).toISOString()).toBe('2026-08-30T19:45:00.000Z');
  });

  it('saves the effective mapping as a reusable template when asked', async () => {
    await cargarAgenda(
      csv(['30.555.551-7;Hugo Plantilla;+56 9 7000 0040;Dermatología;;31-08-2026;08:30']),
      'plantilla.csv',
      { actor: 'test:admision', guardarPlantilla: 'ssasur-estandar' },
    );
    const plantilla = await pool.query(
      `select mapeo from plantillas_mapeo where nombre = 'ssasur-estandar'`,
    );
    expect(plantilla.rows[0].mapeo).toMatchObject({
      run: 'RUT Paciente',
      servicio: 'Especialidad',
    });
  });
});
