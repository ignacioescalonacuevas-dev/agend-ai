import { describe, expect, it } from 'vitest';
import {
  ESTADOS_CITA,
  TABLA_TRANSICIONES,
  esTransicionValida,
  type EstadoCita,
} from '../src/domain/estado-cita';

/**
 * Exhaustive coverage of the RF-5 transition matrix: every (from, to) pair
 * is asserted, so any accidental edit to TABLA_TRANSICIONES fails a test.
 */
const VALIDAS: ReadonlySet<string> = new Set([
  'pendiente>en_contacto',
  'en_contacto>confirmada',
  'en_contacto>cancelada',
  'en_contacto>reagendar',
  'en_contacto>incontactable',
]);

describe('transition matrix (RF-5)', () => {
  for (const desde of ESTADOS_CITA) {
    for (const hacia of ESTADOS_CITA) {
      const esperado = VALIDAS.has(`${desde}>${hacia}`);
      it(`${desde} -> ${hacia} is ${esperado ? 'valid' : 'invalid'}`, () => {
        expect(esTransicionValida(desde, hacia)).toBe(esperado);
      });
    }
  }

  it('covers exactly the 5 valid transitions of RF-5', () => {
    const total = ESTADOS_CITA.flatMap((desde) =>
      ESTADOS_CITA.filter((hacia) => esTransicionValida(desde, hacia)),
    ).length;
    expect(total).toBe(VALIDAS.size);
  });
});

describe('table structure', () => {
  it('has an entry for every state, and no extras', () => {
    expect(Object.keys(TABLA_TRANSICIONES).sort()).toEqual([...ESTADOS_CITA].sort());
  });

  it('only references known states as targets', () => {
    for (const destinos of Object.values(TABLA_TRANSICIONES)) {
      for (const destino of destinos) {
        expect(ESTADOS_CITA).toContain(destino);
      }
    }
  });

  it('response states are terminal in Fase 0', () => {
    const terminales: EstadoCita[] = ['confirmada', 'cancelada', 'reagendar', 'incontactable'];
    for (const estado of terminales) {
      expect(TABLA_TRANSICIONES[estado]).toHaveLength(0);
    }
  });

  it('never allows self-transitions', () => {
    for (const estado of ESTADOS_CITA) {
      expect(esTransicionValida(estado, estado)).toBe(false);
    }
  });
});
