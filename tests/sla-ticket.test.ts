import { describe, expect, it } from 'vitest';
import { calcularLimitesSla, sumarDiasHabiles } from '../src/domain/sla-ticket';

// 2026-08-20 15:00Z = jueves 11:00 Santiago (invierno, sin cambio de hora
// en el rango de estas pruebas). Aug 21 = viernes (ver cascada.persistencia.test.ts).
const APERTURA = new Date('2026-08-20T15:00:00Z');

describe('calcularLimitesSla (EETT §6, Anexo 8)', () => {
  it('alta: 1h primera respuesta / 4h resolución, horas corridas', () => {
    const limites = calcularLimitesSla('alta', APERTURA, new Set());
    expect(limites.primeraRespuestaLimite).toEqual(new Date('2026-08-20T16:00:00Z'));
    expect(limites.resolucionLimite).toEqual(new Date('2026-08-20T19:00:00Z'));
  });

  it('media: 6h primera respuesta / 24h resolución, horas corridas', () => {
    const limites = calcularLimitesSla('media', APERTURA, new Set());
    expect(limites.primeraRespuestaLimite).toEqual(new Date('2026-08-20T21:00:00Z'));
    expect(limites.resolucionLimite).toEqual(new Date('2026-08-21T15:00:00Z'));
  });

  it('baja: 24h primera respuesta corridas / 5 días hábiles resolución', () => {
    const limites = calcularLimitesSla('baja', APERTURA, new Set());
    expect(limites.primeraRespuestaLimite).toEqual(new Date('2026-08-21T15:00:00Z'));
    // jue 20 -> +5 hábiles saltando sáb 22/dom 23 -> jue 27.
    expect(limites.resolucionLimite).toEqual(new Date('2026-08-27T15:00:00Z'));
  });

  it('baja: un feriado entre medio corre el límite de resolución un día más', () => {
    const limites = calcularLimitesSla('baja', APERTURA, new Set(['2026-08-25']));
    expect(limites.resolucionLimite).toEqual(new Date('2026-08-28T15:00:00Z'));
  });
});

describe('sumarDiasHabiles', () => {
  it('salta fin de semana', () => {
    // jue 20 + 1 hábil = vie 21.
    expect(sumarDiasHabiles(APERTURA, 1, new Set())).toEqual(new Date('2026-08-21T15:00:00Z'));
  });

  it('salta sábado y domingo por igual (a diferencia de esDiaBloqueado)', () => {
    // jue 20 + 2 hábiles: vie 21 (1), sáb/dom no cuentan, lun 24 (2).
    expect(sumarDiasHabiles(APERTURA, 2, new Set())).toEqual(new Date('2026-08-24T15:00:00Z'));
  });

  it('salta un feriado entre semana', () => {
    // jue 20 + 3 hábiles con feriado el lun 24: vie21(1), mar25(2), mié26(3).
    expect(sumarDiasHabiles(APERTURA, 3, new Set(['2026-08-24']))).toEqual(
      new Date('2026-08-26T15:00:00Z'),
    );
  });
});
