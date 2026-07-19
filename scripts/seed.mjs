// Synthetic seed data (rule: NO real patient data in dev environments).
// RUNs are verifier-valid but fictitious; phones use the +5699999xxxx range.
// Usage: DATABASE_URL=... node scripts/seed.mjs
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

function digitoVerificador(cuerpo) {
  let suma = 0;
  let mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i -= 1) {
    suma += Number(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const resto = 11 - (suma % 11);
  return resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
}
const runSintetico = (n) => `${n}-${digitoVerificador(String(n))}`;

const SERVICIOS = [
  ['dermatologia', 'Dermatología'],
  ['oftalmologia', 'Oftalmología'],
  ['traumatologia', 'Traumatología'],
  ['medicina-interna', 'Medicina Interna'],
  ['cardiologia', 'Cardiología'],
];

const NOMBRES = [
  'Ana Prueba Soto', 'Luis Ficticio Rojas', 'Carmen Sintética Díaz',
  'Jorge Ejemplo Muñoz', 'Rosa Demo Fuentes', 'Pedro Ensayo Vargas',
  'Marta Simulada Castro', 'Diego Piloto Reyes',
];

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query('begin');

  for (const [id, nombre] of SERVICIOS) {
    await client.query(
      `insert into servicios (id, nombre) values ($1, $2)
       on conflict (id) do update set nombre = excluded.nombre, activo = true`,
      [id, nombre],
    );
  }

  let citas = 0;
  for (let i = 0; i < 40; i += 1) {
    const run = runSintetico(21_000_000 + i);
    const nombre = NOMBRES[i % NOMBRES.length];
    const telefono = `+56999990${String(100 + i).slice(-3)}`;
    await client.query(
      `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
       values ($1, $2, array[$3], true)
       on conflict (run) do nothing`,
      [run, nombre, telefono],
    );

    const servicio = SERVICIOS[i % SERVICIOS.length][0];
    const horas = 25 + (i % 20); // spread inside and around the 24–48 h window
    const res = await client.query(
      `insert into citas (run_paciente, servicio, profesional, fecha_hora)
       values ($1, $2, 'Dra. Sintética Prueba', now() + make_interval(hours => $3))
       on conflict on constraint citas_clave_natural do nothing`,
      [run, servicio, horas],
    );
    citas += res.rowCount ?? 0;
  }

  // Waiting list for slot recovery (hito 5): pre-consented, mixed priorities.
  for (let i = 0; i < 15; i += 1) {
    const run = runSintetico(22_000_000 + i);
    await client.query(
      `insert into pacientes (run, nombre, telefonos, consentimiento_contacto)
       values ($1, $2, array[$3], true)
       on conflict (run) do nothing`,
      [run, `Espera ${NOMBRES[i % NOMBRES.length]}`, `+56999991${String(100 + i).slice(-3)}`],
    );
    await client.query(
      `insert into lista_espera (run_paciente, servicio, prioridad, pre_consentido, fecha_ingreso)
       values ($1, $2, $3, true, now() - make_interval(days => $4))
       on conflict on constraint lista_espera_unica do nothing`,
      [run, SERVICIOS[i % SERVICIOS.length][0], (i % 3) * 10 + 10, 30 - i],
    );
  }

  await client.query(
    `insert into eventos_auditoria (entidad, entidad_id, accion, actor, detalle)
     values ('sistema', 'seed', 'seed_sintetico', 'sistema', '{"nota": "datos sintéticos de desarrollo"}')`,
  );

  await client.query('commit');
  console.log(`seed ok: ${SERVICIOS.length} servicios, ~40 pacientes, ${citas} citas, 15 en lista de espera`);
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  await client.end();
}
