import { describe, expect, it } from 'vitest';
import {
  detectarMapeo,
  normalizarServicio,
  validarFilas,
  type MapeoColumnas,
} from '../src/domain/ingesta';

const SERVICIOS = new Set(['dermatologia', 'medicina-interna']);
const AHORA = new Date('2026-07-19T12:00:00Z');

const MAPEO: MapeoColumnas = {
  run: 'RUT Paciente',
  nombre: 'Nombre',
  telefono: 'Teléfono',
  servicio: 'Especialidad',
  profesional: 'Médico',
  fecha: 'Fecha',
  hora: 'Hora',
};

function filaValida(extra: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    'RUT Paciente': '12.345.678-5',
    Nombre: 'María Ejemplo Pérez',
    'Teléfono': '+56 9 8877 6655',
    Especialidad: 'Dermatología',
    'Médico': 'Dra. Prueba',
    Fecha: '25-08-2026',
    Hora: '10:30',
    ...extra,
  };
}

describe('normalizarServicio', () => {
  it.each([
    ['Dermatología', 'dermatologia'],
    ['MEDICINA INTERNA', 'medicina-interna'],
    ['  Oftalmología ', 'oftalmologia'],
  ])('%s -> %s', (entrada, esperado) => {
    expect(normalizarServicio(entrada)).toBe(esperado);
  });
});

describe('detectarMapeo', () => {
  it('detects SSASUR-style headers with accents and casing', () => {
    const { mapeo, faltantes } = detectarMapeo([
      'RUT Paciente',
      'Nombre',
      'Teléfono',
      'Especialidad',
      'Médico',
      'Fecha',
      'Hora',
    ]);
    expect(faltantes).toEqual([]);
    expect(mapeo).toMatchObject({
      run: 'RUT Paciente',
      nombre: 'Nombre',
      telefono: 'Teléfono',
      servicio: 'Especialidad',
      profesional: 'Médico',
      fecha: 'Fecha',
      hora: 'Hora',
    });
  });

  it('accepts a combined fecha_hora column', () => {
    const { faltantes } = detectarMapeo(['RUN', 'Nombre', 'Fono', 'Servicio', 'Fecha y hora']);
    expect(faltantes).toEqual([]);
  });

  it('reports missing required columns', () => {
    const { faltantes } = detectarMapeo(['Nombre', 'Comentario']);
    expect(faltantes).toContain('run');
    expect(faltantes).toContain('telefono');
    expect(faltantes).toContain('servicio');
    expect(faltantes).toContain('fecha_hora');
  });
});

describe('validarFilas', () => {
  it('normalizes a fully valid row', () => {
    const { validas, rechazadas } = validarFilas([filaValida()], MAPEO, {
      serviciosValidos: SERVICIOS,
      ahora: AHORA,
    });
    expect(rechazadas).toEqual([]);
    expect(validas).toHaveLength(1);
    expect(validas[0]).toMatchObject({
      run: '12345678-5',
      nombre: 'María Ejemplo Pérez',
      telefono: '+56988776655',
      servicio: 'dermatologia',
      profesional: 'Dra. Prueba',
    });
    expect(validas[0]!.fechaHora.toISOString()).toBe('2026-08-25T14:30:00.000Z');
  });

  it('collects every error of a bad row instead of stopping at the first', () => {
    const { validas, rechazadas } = validarFilas(
      [
        filaValida({
          'RUT Paciente': '12345678-9',
          'Teléfono': '123',
          Especialidad: 'Astrología',
          Fecha: '01-01-2020',
        }),
      ],
      MAPEO,
      { serviciosValidos: SERVICIOS, ahora: AHORA },
    );
    expect(validas).toEqual([]);
    expect(rechazadas).toHaveLength(1);
    const errores = rechazadas[0]!.errores.join(' | ');
    expect(errores).toContain('RUN inválido');
    expect(errores).toContain('Teléfono no normalizable');
    expect(errores).toContain('Servicio inexistente');
    expect(errores).toContain('no está en el futuro');
  });

  it('rejects appointments in the past', () => {
    const { rechazadas } = validarFilas(
      [filaValida({ Fecha: '18-07-2026' })],
      MAPEO,
      { serviciosValidos: SERVICIOS, ahora: AHORA },
    );
    expect(rechazadas[0]!.errores).toContain('La cita no está en el futuro');
  });

  it('keeps the first occurrence and rejects in-file duplicates by natural key', () => {
    const { validas, rechazadas } = validarFilas(
      [filaValida(), filaValida({ 'Médico': 'Otro Médico' })],
      MAPEO,
      { serviciosValidos: SERVICIOS, ahora: AHORA },
    );
    expect(validas).toHaveLength(1);
    expect(rechazadas).toHaveLength(1);
    expect(rechazadas[0]!.fila).toBe(2);
    expect(rechazadas[0]!.errores[0]).toContain('duplicada');
  });

  it('reports 1-based row numbers matching the source file order', () => {
    const { rechazadas } = validarFilas(
      [filaValida(), filaValida({ 'RUT Paciente': 'malo', Fecha: '26-08-2026' })],
      MAPEO,
      { serviciosValidos: SERVICIOS, ahora: AHORA },
    );
    expect(rechazadas).toHaveLength(1);
    expect(rechazadas[0]!.fila).toBe(2);
  });
});
