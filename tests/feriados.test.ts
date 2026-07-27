import { describe, expect, it } from 'vitest';
import { esDiaBloqueado } from '../src/domain/feriados';

describe('esDiaBloqueado', () => {
  it('bloquea domingo aunque no esté en la lista de feriados', () => {
    // 2026-08-23 = domingo, 10:00 Santiago.
    expect(esDiaBloqueado(new Date('2026-08-23T14:00:00Z'), new Set())).toBe(true);
  });

  it('no bloquea un lunes cualquiera sin feriados', () => {
    // 2026-08-24 = lunes, 10:00 Santiago.
    expect(esDiaBloqueado(new Date('2026-08-24T14:00:00Z'), new Set())).toBe(false);
  });

  it('bloquea una fecha presente en el set de feriados', () => {
    // 2026-01-01 = jueves, Año Nuevo.
    expect(esDiaBloqueado(new Date('2026-01-01T13:00:00Z'), new Set(['2026-01-01']))).toBe(true);
  });

  it('no bloquea la misma fecha si no está en el set', () => {
    expect(esDiaBloqueado(new Date('2026-01-01T13:00:00Z'), new Set())).toBe(false);
  });
});
