import { describe, expect, it } from 'vitest';
import { esMovil, normalizarTelefono } from '../src/domain/telefono';

describe('normalizarTelefono', () => {
  it.each([
    ['+56 9 8877 6655', '+56988776655'],
    ['56988776655', '+56988776655'],
    ['988776655', '+56988776655'],
    ['09 8877 6655', '+56988776655'],
    ['9-8877-6655', '+56988776655'],
    ['(56) 9 8877 6655', '+56988776655'],
    ['221234567', '+56221234567'],
    ['+56221234567', '+56221234567'],
  ])('normalizes %s to %s', (entrada, esperado) => {
    expect(normalizarTelefono(entrada)).toBe(esperado);
  });

  it.each([
    ['12345', 'too short'],
    ['5698877665', 'eight national digits'],
    ['98877665512', 'too long'],
    ['188776655', 'starts with 1'],
    ['no es un fono', 'letters'],
    ['', 'empty'],
  ])('rejects %s (%s)', (entrada) => {
    expect(normalizarTelefono(entrada)).toBeNull();
  });
});

describe('esMovil', () => {
  it('detects mobile vs landline', () => {
    expect(esMovil('+56988776655')).toBe(true);
    expect(esMovil('+56221234567')).toBe(false);
  });
});
