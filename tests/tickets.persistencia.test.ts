import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  CausaRaizRequeridaError,
  TransicionTicketInvalidaError,
  transicionarTicket,
} from '../src/domain/estado-ticket';
import { crearTicket } from '../src/lib/tickets-service';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('mesa de ayuda: crearTicket + transicionarTicket (EETT §6)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** transicionarTicket() expects to run inside an open transaction (mirrors transicionar()). */
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

  async function eventosDe(ticketId: string) {
    const res = await pool.query(
      `select accion, actor, detalle from eventos_auditoria
       where entidad = 'ticket' and entidad_id = $1 order by creado_at`,
      [ticketId],
    );
    return res.rows;
  }

  it('crea un ticket con folio autogenerado, límites de SLA y auditoría', async () => {
    const ticket = await crearTicket({
      establecimientoId: 'hospital-puerto-aysen',
      canal: 'telefono',
      solicitanteNombre: 'Juan Pérez',
      categoria: 'consulta_funcional',
      criticidad: 'media',
      actor: 'admision:juan',
    });

    expect(ticket.numero).toBeGreaterThan(0);
    expect(ticket.criticidad).toBe('media');

    const fila = await pool.query(
      `select estado, criticidad, primera_respuesta_limite, resolucion_limite, fecha_apertura
       from tickets where id = $1`,
      [ticket.id],
    );
    expect(fila.rows[0].estado).toBe('abierto');
    const apertura = new Date(fila.rows[0].fecha_apertura as string).getTime();
    const primeraLimite = new Date(fila.rows[0].primera_respuesta_limite as string).getTime();
    expect(primeraLimite - apertura).toBe(6 * 3_600_000); // media: 6h

    const eventos = await eventosDe(ticket.id);
    expect(eventos.map((e) => e.accion)).toEqual(['ticket_creado']);
  });

  it('un incidente que interrumpe el envío de mensajes fuerza criticidad alta, auditado', async () => {
    const ticket = await crearTicket({
      establecimientoId: 'hospital-puerto-aysen',
      canal: 'portal',
      solicitanteNombre: 'Encargado TI',
      categoria: 'falla_canal_whatsapp',
      criticidad: 'baja', // lo que pidió el llamador
      interrumpeEnvioMensajes: true,
      actor: 'sistema:monitoreo',
    });

    expect(ticket.criticidad).toBe('alta');

    const fila = await pool.query('select criticidad from tickets where id = $1', [ticket.id]);
    expect(fila.rows[0].criticidad).toBe('alta');

    const eventos = await eventosDe(ticket.id);
    expect(eventos.map((e) => e.accion)).toEqual(['ticket_creado', 'criticidad_forzada_alta']);
    expect(eventos[1]!.detalle.criticidadSolicitada).toBe('baja');
  });

  it('no fuerza nada si ya se pidió criticidad alta', async () => {
    const ticket = await crearTicket({
      establecimientoId: 'hospital-puerto-aysen',
      canal: 'correo',
      solicitanteNombre: 'Encargado TI',
      categoria: 'falla_canal_whatsapp',
      criticidad: 'alta',
      interrumpeEnvioMensajes: true,
      actor: 'sistema:monitoreo',
    });
    const eventos = await eventosDe(ticket.id);
    expect(eventos.map((e) => e.accion)).toEqual(['ticket_creado']);
  });

  it('entrar a en_atencion estampa primera_respuesta_at una sola vez', async () => {
    const ticket = await crearTicket({
      establecimientoId: 'hospital-puerto-aysen',
      canal: 'telefono',
      solicitanteNombre: 'María Soto',
      categoria: 'consulta_funcional',
      criticidad: 'baja',
      actor: 'admision:juan',
    });

    await conTx((c) => transicionarTicket(c, { ticketId: ticket.id, hacia: 'en_atencion', actor: 'soporte:ana' }));

    const fila = await pool.query('select primera_respuesta_at from tickets where id = $1', [
      ticket.id,
    ]);
    expect(fila.rows[0].primera_respuesta_at).not.toBeNull();
  });

  it('resolver sin causa_raiz lanza CausaRaizRequeridaError', async () => {
    const ticket = await crearTicket({
      establecimientoId: 'hospital-puerto-aysen',
      canal: 'telefono',
      solicitanteNombre: 'María Soto',
      categoria: 'consulta_funcional',
      criticidad: 'baja',
      actor: 'admision:juan',
    });
    await conTx((c) => transicionarTicket(c, { ticketId: ticket.id, hacia: 'en_atencion', actor: 'soporte:ana' }));

    await expect(
      conTx((c) => transicionarTicket(c, { ticketId: ticket.id, hacia: 'resuelto', actor: 'soporte:ana' })),
    ).rejects.toThrow(CausaRaizRequeridaError);
  });

  it('resolver con causa_raiz estampa resolucion_at, guarda la causa y concatena la nota', async () => {
    const ticket = await crearTicket({
      establecimientoId: 'hospital-puerto-aysen',
      canal: 'telefono',
      solicitanteNombre: 'María Soto',
      categoria: 'consulta_funcional',
      criticidad: 'baja',
      actor: 'admision:juan',
    });
    await conTx((c) =>
      transicionarTicket(c, {
        ticketId: ticket.id,
        hacia: 'en_atencion',
        actor: 'soporte:ana',
        nota: 'tomado por soporte',
      }),
    );
    await conTx((c) =>
      transicionarTicket(c, {
        ticketId: ticket.id,
        hacia: 'resuelto',
        actor: 'soporte:ana',
        causaRaiz: 'configuración incorrecta del webhook',
        nota: 'corregido y verificado',
      }),
    );

    const fila = await pool.query(
      `select resolucion_at, causa_raiz, acciones from tickets where id = $1`,
      [ticket.id],
    );
    expect(fila.rows[0].resolucion_at).not.toBeNull();
    expect(fila.rows[0].causa_raiz).toBe('configuración incorrecta del webhook');
    expect(fila.rows[0].acciones).toContain('tomado por soporte');
    expect(fila.rows[0].acciones).toContain('corregido y verificado');
  });

  it('una transición inválida se rechaza y queda auditada', async () => {
    const ticket = await crearTicket({
      establecimientoId: 'hospital-puerto-aysen',
      canal: 'telefono',
      solicitanteNombre: 'María Soto',
      categoria: 'consulta_funcional',
      criticidad: 'baja',
      actor: 'admision:juan',
    });

    // Catch inside the tx and commit, so the rejection audit event survives
    // (mismo patrón que estado-cita.persistencia.test.ts).
    let capturado: unknown;
    await conTx(async (client) => {
      try {
        await transicionarTicket(client, {
          ticketId: ticket.id,
          hacia: 'resuelto',
          actor: 'soporte:ana',
          causaRaiz: 'no debería aplicar',
        });
      } catch (err) {
        capturado = err;
      }
    });
    expect(capturado).toBeInstanceOf(TransicionTicketInvalidaError);

    const eventos = await eventosDe(ticket.id);
    expect(eventos.map((e) => e.accion)).toEqual(['ticket_creado', 'transicion_rechazada']);
  });
});

describe.skipIf(!DATABASE_URL)('mesa de ayuda: aislamiento multi-tenant', () => {
  let pool: pg.Pool;
  const SITIO_A = 'hospital-puerto-aysen';
  const SITIO_B = 'hospital-cochrane';

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function crearTicketEn(establecimientoId: string): Promise<string> {
    const ticket = await crearTicket({
      establecimientoId,
      canal: 'telefono',
      solicitanteNombre: 'Solicitante Multitenant',
      categoria: 'consulta_funcional',
      criticidad: 'baja',
      actor: 'admision:test',
    });
    return ticket.id;
  }

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

  it('un establecimiento solo ve sus propios tickets bajo RLS', async () => {
    const ticketA = await crearTicketEn(SITIO_A);
    const ticketB = await crearTicketEn(SITIO_B);

    const vistosDesdeA = await comoEstablecimiento(SITIO_A, (client) =>
      client.query('select id from tickets where id = any($1::uuid[])', [[ticketA, ticketB]]),
    );
    expect(vistosDesdeA.rows.map((r) => r.id)).toEqual([ticketA]);
  });
});
