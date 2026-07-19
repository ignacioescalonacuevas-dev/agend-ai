import { describe, expect, it } from 'vitest';
import { calcularDigitoVerificador, normalizarRun, runSintetico } from '../src/domain/run';

describe('calcularDigitoVerificador', () => {
  it.each([
    ['12345678', '5'],
    ['11111111', '1'],
    ['22222222', '2'],
    ['9876543', '3'],
    ['18456789', 'K'],
  ])('body %s -> %s', (cuerpo, dv) => {
    expect(calcularDigitoVerificador(cuerpo)).toBe(dv);
  });
});

describe('normalizarRun', () => {
  it.each([
    ['12.345.678-5', '12345678-5'],
    ['12345678-5', '12345678-5'],
    ['123456785', '12345678-5'],
    [' 12345678-5 ', '12345678-5'],
    ['18456789-k', '18456789-K'],
    ['18456789K', '18456789-K'],
    ['9.876.543-3', '9876543-3'],
  ])('normalizes %s to %s', (entrada, esperado) => {
    expect(normalizarRun(entrada)).toBe(esperado);
  });

  it.each([
    ['12345678-9', 'wrong verifier digit'],
    ['12345678', 'body without verifier resolves to invalid dv'],
    ['1-9', 'too short'],
    ['abc', 'not a RUN'],
    ['', 'empty'],
    ['012345678-5', 'leading zero'],
    ['123.456.789-0', 'nine-digit body'],
  ])('rejects %s (%s)', (entrada) => {
    expect(normalizarRun(entrada)).toBeNull();
  });
});

describe('runSintetico', () => {
  it('produces RUNs that pass normalization', () => {
    for (const semilla of [21_000_000, 21_000_001, 9_876_543, 18_456_789]) {
      const run = runSintetico(semilla);
      expect(normalizarRun(run)).toBe(run);
    }
  });
});
