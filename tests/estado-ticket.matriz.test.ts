import { describe, expect, it } from 'vitest';
import {
  ESTADOS_TICKET,
  TABLA_TRANSICIONES_TICKET,
  esTransicionTicketValida,
} from '../src/domain/estado-ticket';

/**
 * Exhaustive coverage of the mesa-de-ayuda transition matrix (EETT §6):
 * every (from, to) pair is asserted, so any accidental edit to
 * TABLA_TRANSICIONES_TICKET fails a test.
 */
const VALIDAS: ReadonlySet<string> = new Set([
  'abierto>en_atencion',
  'en_atencion>resuelto',
  'resuelto>cerrado',
]);

describe('transition matrix (mesa de ayuda)', () => {
  for (const desde of ESTADOS_TICKET) {
    for (const hacia of ESTADOS_TICKET) {
      const esperado = VALIDAS.has(`${desde}>${hacia}`);
      it(`${desde} -> ${hacia} is ${esperado ? 'valid' : 'invalid'}`, () => {
        expect(esTransicionTicketValida(desde, hacia)).toBe(esperado);
      });
    }
  }

  it('covers exactly the 3 valid transitions (lineal, sin reapertura en v1)', () => {
    const total = ESTADOS_TICKET.flatMap((desde) =>
      ESTADOS_TICKET.filter((hacia) => esTransicionTicketValida(desde, hacia)),
    ).length;
    expect(total).toBe(VALIDAS.size);
  });
});

describe('table structure', () => {
  it('has an entry for every state, and no extras', () => {
    expect(Object.keys(TABLA_TRANSICIONES_TICKET).sort()).toEqual([...ESTADOS_TICKET].sort());
  });

  it('only references known states as targets', () => {
    for (const destinos of Object.values(TABLA_TRANSICIONES_TICKET)) {
      for (const destino of destinos) {
        expect(ESTADOS_TICKET).toContain(destino);
      }
    }
  });

  it('cerrado is terminal', () => {
    expect(TABLA_TRANSICIONES_TICKET.cerrado).toHaveLength(0);
  });

  it('never allows self-transitions', () => {
    for (const estado of ESTADOS_TICKET) {
      expect(esTransicionTicketValida(estado, estado)).toBe(false);
    }
  });
});
