/**
 * Background worker (RF-2/RF-3): pg-boss over the same Postgres (no Redis).
 *
 *   npm run worker            # cron scheduler + cascade processing
 *   EJECUTAR_SCHEDULER_AL_INICIO=1 npm run worker   # also run the
 *                             # scheduler pass immediately at boot (dev)
 *
 * Channels are mock adapters until Meta/Twilio credentials exist; swapping
 * in real adapters only replaces the CanalMensajeria implementations.
 */
import PgBoss from 'pg-boss';
import { CanalLlamadaMock } from '@/canales/ivr-mock';
import { CanalMock } from '@/canales/mock';
import { ejecutarPasoCascada, type DatosCascada } from '@/jobs/cascada';
import { encolarContactos, encolarInformativos } from '@/jobs/scheduler';
import { obtenerPool } from '@/lib/db';

export const COLA_SCHEDULER = 'scheduler-contacto';
export const COLA_CASCADA = 'cascada-contacto';

const REINTENTOS = { retryLimit: 5, retryBackoff: true, retryDelay: 60 } as const;

function claveUnica(datos: DatosCascada): string {
  return `cascada-${datos.citaId}-${datos.paso}`;
}

async function principal(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') throw new Error('DATABASE_URL no está configurada');

  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();
  await boss.createQueue(COLA_SCHEDULER);
  await boss.createQueue(COLA_CASCADA);

  const db = obtenerPool();
  const deps = {
    db,
    whatsapp: new CanalMock('whatsapp', { log: true }),
    sms: new CanalMock('sms', { log: true }),
    llamada: new CanalLlamadaMock({ log: true }),
    baseUrlRespuesta: process.env.BASE_URL_RESPUESTA ?? 'http://localhost:3000',
    programar: async (datos: DatosCascada, ejecutarEn: Date) => {
      await boss.send(COLA_CASCADA, datos as unknown as object, {
        startAfter: ejecutarEn,
        singletonKey: claveUnica(datos),
        ...REINTENTOS,
      });
    },
  };

  const pasadaScheduler = async (): Promise<void> => {
    const resumen = await encolarContactos({
      db,
      encolar: async (citaId) => {
        const datos: DatosCascada = { citaId, paso: 'interactivo_1' };
        await boss.send(COLA_CASCADA, datos as unknown as object, {
          singletonKey: claveUnica(datos),
          ...REINTENTOS,
        });
      },
    });
    console.log(
      `[scheduler] encoladas=${resumen.encoladas.length} reencoladas=${resumen.reencoladas.length}`,
    );

    const resumenInformativos = await encolarInformativos({
      db,
      encolar: async (citaId) => {
        const datos: DatosCascada = { citaId, paso: 'informativo' };
        await boss.send(COLA_CASCADA, datos as unknown as object, {
          singletonKey: claveUnica(datos),
          ...REINTENTOS,
        });
      },
    });
    console.log(`[scheduler] informativos encolados=${resumenInformativos.encoladas.length}`);
  };

  // Hourly pass, expressed in the hospital's timezone.
  await boss.schedule(COLA_SCHEDULER, '0 * * * *', undefined, { tz: 'America/Santiago' });
  await boss.work(COLA_SCHEDULER, async () => {
    await pasadaScheduler();
  });

  await boss.work(COLA_CASCADA, async (trabajos) => {
    for (const trabajo of trabajos) {
      const datos = trabajo.data as unknown as DatosCascada;
      const resultado = await ejecutarPasoCascada(deps, datos);
      console.log(`[cascada] cita=${datos.citaId} paso=${datos.paso} -> ${resultado.accion}`);
      if (resultado.accion === 'fallido') {
        // Throwing lets pg-boss apply retryLimit/backoff; the 'fallido'
        // attempt row authorizes the resend on the next run.
        throw new Error(`envío fallido: ${resultado.error}`);
      }
    }
  });

  if (process.env.EJECUTAR_SCHEDULER_AL_INICIO === '1') {
    await pasadaScheduler();
  }

  console.log('[worker] listo: scheduler horario + cascada activos');
}

principal().catch((err) => {
  console.error(err);
  process.exit(1);
});
