import { describe, expect, it } from 'vitest';
import { formatearSantiago } from '../src/domain/fechas';
import { dentroDeVentana, proximaAperturaVentana } from '../src/domain/ventana-horaria';

// 2026-08-20 = jueves (laboral, invierno UTC-4). 2026-08-21 = viernes.
// 2026-08-22 = sábado. 2026-08-23 = domingo. 2026-08-24 = lunes.
const SIN_FERIADOS: ReadonlySet<string> = new Set();

describe('dentroDeVentana — mensajería (WhatsApp/SMS), 08:30–19:00 L-V', () => {
  const casos: [string, boolean][] = [
    ['2026-08-20T12:29:00Z', false], // 08:29 Santiago
    ['2026-08-20T12:30:00Z', true], // 08:30 apertura exacta
    ['2026-08-20T22:59:00Z', true], // 18:59
    ['2026-08-20T23:00:00Z', false], // 19:00 cierre exacto
  ];
  it.each(casos)('whatsapp %s -> %s', (iso, esperado) => {
    expect(dentroDeVentana('whatsapp', new Date(iso), SIN_FERIADOS)).toBe(esperado);
  });
  it.each(casos)('sms %s -> %s (misma ventana que whatsapp)', (iso, esperado) => {
    expect(dentroDeVentana('sms', new Date(iso), SIN_FERIADOS)).toBe(esperado);
  });
});

describe('dentroDeVentana — llamadas (IVR), 09:00–11:30 y 14:00–17:00 L-V', () => {
  const casos: [string, boolean][] = [
    ['2026-08-20T12:59:00Z', false], // 08:59
    ['2026-08-20T13:00:00Z', true], // 09:00 apertura tramo 1
    ['2026-08-20T15:29:00Z', true], // 11:29
    ['2026-08-20T15:30:00Z', false], // 11:30 cierre tramo 1
    ['2026-08-20T17:59:00Z', false], // 13:59 (pausa de mediodía)
    ['2026-08-20T18:00:00Z', true], // 14:00 apertura tramo 2
    ['2026-08-20T20:59:00Z', true], // 16:59
    ['2026-08-20T21:00:00Z', false], // 17:00 cierre tramo 2
  ];
  it.each(casos)('%s -> %s', (iso, esperado) => {
    expect(dentroDeVentana('llamada', new Date(iso), SIN_FERIADOS)).toBe(esperado);
  });
});

describe('dentroDeVentana — sábado, 09:00–13:00 para todo canal', () => {
  const casos: [string, boolean][] = [
    ['2026-08-22T12:59:00Z', false], // 08:59 Santiago sábado
    ['2026-08-22T13:00:00Z', true], // 09:00
    ['2026-08-22T16:59:00Z', true], // 12:59
    ['2026-08-22T17:00:00Z', false], // 13:00
  ];
  for (const canal of ['whatsapp', 'sms', 'llamada'] as const) {
    it.each(casos)(`${canal} %s -> %s`, (iso, esperado) => {
      expect(dentroDeVentana(canal, new Date(iso), SIN_FERIADOS)).toBe(esperado);
    });
  }
});

describe('dentroDeVentana — domingos y feriados bloqueados para todo canal', () => {
  it('domingo, aunque caiga en horario nominal', () => {
    // 2026-08-23 = domingo, 10:00 Santiago.
    expect(dentroDeVentana('whatsapp', new Date('2026-08-23T14:00:00Z'), SIN_FERIADOS)).toBe(
      false,
    );
  });

  it('feriado en día laboral, aunque caiga en horario nominal', () => {
    // 2026-01-01 = Año Nuevo, jueves, 10:00 Santiago (verano).
    const feriados = new Set(['2026-01-01']);
    expect(dentroDeVentana('whatsapp', new Date('2026-01-01T13:00:00Z'), feriados)).toBe(false);
  });

  it('el mismo día sin el feriado en el set no está bloqueado', () => {
    expect(dentroDeVentana('whatsapp', new Date('2026-01-01T13:00:00Z'), SIN_FERIADOS)).toBe(
      true,
    );
  });
});

describe('proximaAperturaVentana', () => {
  it('returns the same instant when already inside the window', () => {
    const dentro = new Date('2026-08-20T15:00:00Z'); // 11:00 Santiago jueves
    expect(proximaAperturaVentana('whatsapp', dentro, SIN_FERIADOS)).toEqual(dentro);
  });

  it('defers to today 08:30 when before opening', () => {
    const madrugada = new Date('2026-08-20T11:00:00Z'); // 07:00 Santiago
    expect(formatearSantiago(proximaAperturaVentana('whatsapp', madrugada, SIN_FERIADOS))).toBe(
      '20-08-2026 08:30',
    );
  });

  it('llamada salta la pausa de mediodía al segundo tramo del mismo día', () => {
    const mediodia = new Date('2026-08-20T16:00:00Z'); // 12:00 Santiago jueves
    const apertura = proximaAperturaVentana('llamada', mediodia, SIN_FERIADOS);
    expect(apertura.toISOString()).toBe('2026-08-20T18:00:00.000Z'); // 14:00 Santiago
  });

  it('llamada después del último tramo defiere al día siguiente', () => {
    const noche = new Date('2026-08-20T22:00:00Z'); // 18:00 Santiago jueves
    const apertura = proximaAperturaVentana('llamada', noche, SIN_FERIADOS);
    expect(apertura.toISOString()).toBe('2026-08-21T13:00:00.000Z'); // 09:00 Santiago viernes
  });

  it('viernes fuera de horario defiere al sábado (ventana propia, no lunes)', () => {
    const noche = new Date('2026-08-21T23:30:00Z'); // 19:30 Santiago viernes
    const apertura = proximaAperturaVentana('whatsapp', noche, SIN_FERIADOS);
    expect(apertura.toISOString()).toBe('2026-08-22T13:00:00.000Z'); // 09:00 Santiago sábado
  });

  it('sábado fuera de horario salta el domingo y defiere al lunes', () => {
    const tarde = new Date('2026-08-22T18:00:00Z'); // 14:00 Santiago sábado
    const apertura = proximaAperturaVentana('whatsapp', tarde, SIN_FERIADOS);
    expect(apertura.toISOString()).toBe('2026-08-24T12:30:00.000Z'); // 08:30 Santiago lunes
  });

  it('domingo defiere al lunes sin importar la hora', () => {
    const domingo = new Date('2026-08-23T14:00:00Z'); // 10:00 Santiago domingo
    const apertura = proximaAperturaVentana('whatsapp', domingo, SIN_FERIADOS);
    expect(apertura.toISOString()).toBe('2026-08-24T12:30:00.000Z'); // 08:30 Santiago lunes
  });

  it('feriado defiere al siguiente día hábil', () => {
    // 2026-01-01 es feriado (jueves); el siguiente día hábil es viernes 2 de enero.
    const feriados = new Set(['2026-01-01']);
    const apertura = proximaAperturaVentana('whatsapp', new Date('2026-01-01T13:00:00Z'), feriados);
    expect(apertura.toISOString()).toBe('2026-01-02T11:30:00.000Z'); // 08:30 Santiago (verano UTC-3)
  });

  it('handles the spring-forward weekend (Sep 5→6 2026 is sábado→domingo)', () => {
    // 01:30 Santiago domingo, ya en horario de verano (UTC-3): domingo
    // bloqueado, defiere al lunes 7 de septiembre.
    const noche = new Date('2026-09-06T04:30:00Z');
    const apertura = proximaAperturaVentana('whatsapp', noche, SIN_FERIADOS);
    expect(formatearSantiago(apertura)).toBe('07-09-2026 08:30');
    expect(apertura.toISOString()).toBe('2026-09-07T11:30:00.000Z');
  });

  it('handles the fall-back weekend (Apr 4→5 2026 is sábado→domingo)', () => {
    // 23:30 Santiago sábado (tras el cambio de hora): ya fuera de la
    // ventana de sábado (cierra 13:00); domingo está bloqueado, defiere al
    // lunes 6 de abril, ya en horario de invierno (UTC-4).
    const noche = new Date('2026-04-05T03:30:00Z');
    const apertura = proximaAperturaVentana('whatsapp', noche, SIN_FERIADOS);
    expect(formatearSantiago(apertura)).toBe('06-04-2026 08:30');
    expect(apertura.toISOString()).toBe('2026-04-06T12:30:00.000Z');
  });
});
