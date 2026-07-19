import { describe, expect, it } from 'vitest';
import { formatearSantiago } from '../src/domain/fechas';
import { dentroDeVentana, proximaAperturaVentana } from '../src/domain/ventana-horaria';

// Winter (UTC-4): 2026-08-20. Summer (UTC-3): 2026-01-15.
const casos: [string, boolean][] = [
  ['2026-08-20T12:59:00Z', false], // 08:59 Santiago winter
  ['2026-08-20T13:00:00Z', true], // 09:00 exact opening
  ['2026-08-20T15:00:00Z', true], // 11:00
  ['2026-08-20T23:59:00Z', true], // 19:59
  ['2026-08-21T00:00:00Z', false], // 20:00 exact closing
  ['2026-08-21T02:00:00Z', false], // 22:00
  ['2026-01-15T11:59:00Z', false], // 08:59 Santiago summer (UTC-3)
  ['2026-01-15T12:00:00Z', true], // 09:00 summer
  ['2026-01-15T23:00:00Z', false], // 20:00 summer
];

describe('dentroDeVentana (09:00–20:00 America/Santiago)', () => {
  it.each(casos)('%s -> %s', (iso, esperado) => {
    expect(dentroDeVentana(new Date(iso))).toBe(esperado);
  });
});

describe('proximaAperturaVentana', () => {
  it('returns the same instant when already inside the window', () => {
    const dentro = new Date('2026-08-20T15:00:00Z');
    expect(proximaAperturaVentana(dentro)).toEqual(dentro);
  });

  it('defers to today 09:00 when before opening', () => {
    const madrugada = new Date('2026-08-20T10:00:00Z'); // 06:00 Santiago
    expect(formatearSantiago(proximaAperturaVentana(madrugada))).toBe('20-08-2026 09:00');
  });

  it('defers to tomorrow 09:00 when after closing', () => {
    const noche = new Date('2026-08-21T01:30:00Z'); // 21:30 Santiago Aug 20
    expect(formatearSantiago(proximaAperturaVentana(noche))).toBe('21-08-2026 09:00');
  });

  it('handles the spring-forward night (Sep 5→6 2026, clocks skip 00:00→01:00)', () => {
    const noche = new Date('2026-09-06T04:30:00Z'); // 01:30 Santiago, already UTC-3
    const apertura = proximaAperturaVentana(noche);
    expect(formatearSantiago(apertura)).toBe('06-09-2026 09:00');
    expect(apertura.toISOString()).toBe('2026-09-06T12:00:00.000Z'); // 09:00 at UTC-3
  });

  it('handles the fall-back night (Apr 4→5 2026, repeated 23:00 hour)', () => {
    const noche = new Date('2026-04-05T03:30:00Z'); // 23:30 Santiago Apr 4 (2nd pass, UTC-4)
    const apertura = proximaAperturaVentana(noche);
    expect(formatearSantiago(apertura)).toBe('05-04-2026 09:00');
    expect(apertura.toISOString()).toBe('2026-04-05T13:00:00.000Z'); // 09:00 at UTC-4
  });
});
