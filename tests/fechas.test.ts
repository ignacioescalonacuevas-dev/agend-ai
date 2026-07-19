import { describe, expect, it } from 'vitest';
import {
  formatearSantiago,
  offsetSantiago,
  parsearFechaHoraSantiago,
} from '../src/domain/fechas';

describe('parsearFechaHoraSantiago', () => {
  it('parses common formats with separate date and time columns', () => {
    const casos: [string, string | undefined][] = [
      ['25-08-2026', '10:30'],
      ['25/08/2026', '10:30'],
      ['2026-08-25', '10:30'],
      ['25-08-2026 10:30', undefined],
      ['2026-08-25T10:30', undefined],
    ];
    for (const [fecha, hora] of casos) {
      const instante = parsearFechaHoraSantiago(fecha, hora);
      expect(instante).not.toBeNull();
      expect(formatearSantiago(instante!)).toBe('25-08-2026 10:30');
    }
  });

  it('returns null for garbage', () => {
    expect(parsearFechaHoraSantiago('mañana', '10:00')).toBeNull();
    expect(parsearFechaHoraSantiago('35-13-2026', '10:00')).toBeNull();
    expect(parsearFechaHoraSantiago('', undefined)).toBeNull();
  });

  it('interprets wall-clock time as Santiago, not UTC', () => {
    // August (winter): Chile continental is UTC-4 → 10:30 local = 14:30Z.
    const invierno = parsearFechaHoraSantiago('25-08-2026', '10:30')!;
    expect(invierno.toISOString()).toBe('2026-08-25T14:30:00.000Z');
    // January (summer, DST): UTC-3 → 10:30 local = 13:30Z.
    const verano = parsearFechaHoraSantiago('15-01-2026', '10:30')!;
    expect(verano.toISOString()).toBe('2026-01-15T13:30:00.000Z');
  });
});

describe('Chilean DST edges (America/Santiago)', () => {
  // DST ends the first Saturday of April at 24:00 (2026: Apr 4 → 5) and
  // starts the first Saturday of September at 24:00 (2026: Sep 5 → 6).
  it('offset flips across the April fall-back', () => {
    expect(offsetSantiago(parsearFechaHoraSantiago('04-04-2026', '12:00')!)).toBe(-180);
    expect(offsetSantiago(parsearFechaHoraSantiago('05-04-2026', '12:00')!)).toBe(-240);
  });

  it('offset flips across the September spring-forward', () => {
    expect(offsetSantiago(parsearFechaHoraSantiago('05-09-2026', '12:00')!)).toBe(-240);
    expect(offsetSantiago(parsearFechaHoraSantiago('06-09-2026', '12:00')!)).toBe(-180);
  });

  it('resolves the ambiguous repeated hour of the fall-back deterministically', () => {
    // 23:30 on Apr 4 happens twice (once per offset); parsing must still
    // yield a single valid instant.
    const instante = parsearFechaHoraSantiago('04-04-2026', '23:30');
    expect(instante).not.toBeNull();
    expect([-180, -240]).toContain(offsetSantiago(instante!));
  });

  it('resolves the nonexistent skipped hour of the spring-forward to a valid instant', () => {
    // 00:30 on Sep 6 does not exist (clocks jump 00:00 → 01:00).
    const instante = parsearFechaHoraSantiago('06-09-2026', '00:30');
    expect(instante).not.toBeNull();
    expect(offsetSantiago(instante!)).toBe(-180);
  });
});
