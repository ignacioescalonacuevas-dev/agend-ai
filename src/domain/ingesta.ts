/**
 * Agenda ingestion — pure domain logic (RF-1).
 *
 * Takes tabular rows (already parsed from CSV/XLSX), applies a column
 * mapping (auto-detected or user-provided), validates each row and returns
 * normalized appointments plus a per-row rejection report. Invalid rows are
 * reported, never silently dropped.
 */
import { parsearFechaHoraSantiago } from './fechas';
import { normalizarRun } from './run';
import { normalizarTelefono } from './telefono';

export type CampoDestino =
  | 'run'
  | 'nombre'
  | 'telefono'
  | 'servicio'
  | 'profesional'
  | 'fecha_hora'
  | 'fecha'
  | 'hora';

/** Maps destination fields to source column headers. */
export type MapeoColumnas = Partial<Record<CampoDestino, string>>;

export interface CitaNormalizada {
  run: string;
  nombre: string;
  telefono: string;
  servicio: string;
  profesional: string | null;
  fechaHora: Date;
}

export interface FilaRechazada {
  /** 1-based row number in the source file (excluding the header row). */
  fila: number;
  errores: string[];
  datos: Record<string, string>;
}

export interface ResultadoValidacion {
  validas: CitaNormalizada[];
  rechazadas: FilaRechazada[];
}

/** Header aliases for first-load auto-detection (accent/case-insensitive). */
const ALIAS: Record<Exclude<CampoDestino, never>, string[]> = {
  run: ['run', 'rut', 'run paciente', 'rut paciente'],
  nombre: ['nombre', 'paciente', 'nombre paciente', 'nombre completo'],
  telefono: ['telefono', 'fono', 'celular', 'movil', 'telefono contacto', 'telefono 1'],
  servicio: ['servicio', 'especialidad', 'unidad'],
  profesional: ['profesional', 'medico', 'doctor', 'tratante'],
  fecha_hora: ['fecha hora', 'fecha_hora', 'fecha y hora', 'fechahora'],
  fecha: ['fecha', 'fecha cita', 'fecha atencion'],
  hora: ['hora', 'hora cita', 'hora atencion'],
};

const OBLIGATORIOS: CampoDestino[] = ['run', 'nombre', 'telefono', 'servicio'];

/**
 * Normalizes a service cell to its catalog slug: 'Dermatología' →
 * 'dermatologia', 'Medicina Interna' → 'medicina-interna'.
 */
export function normalizarServicio(entrada: string): string {
  return entrada
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizarEncabezado(encabezado: string): string {
  return encabezado
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Auto-detects the column mapping from file headers. Returns the mapping and
 * the list of required fields that could not be resolved (empty = usable).
 * A date is resolvable either via 'fecha_hora' or via 'fecha' (+ optional 'hora').
 */
export function detectarMapeo(encabezados: string[]): {
  mapeo: MapeoColumnas;
  faltantes: CampoDestino[];
} {
  const mapeo: MapeoColumnas = {};
  for (const encabezado of encabezados) {
    const clave = normalizarEncabezado(encabezado);
    for (const [campo, alias] of Object.entries(ALIAS) as [CampoDestino, string[]][]) {
      if (mapeo[campo] === undefined && alias.includes(clave)) {
        mapeo[campo] = encabezado;
        break;
      }
    }
  }
  const faltantes = OBLIGATORIOS.filter((campo) => mapeo[campo] === undefined);
  if (mapeo.fecha_hora === undefined && mapeo.fecha === undefined) {
    faltantes.push('fecha_hora');
  }
  return { mapeo, faltantes };
}

export interface OpcionesValidacion {
  /** Valid service identifiers (RF-1: "servicio existente"). */
  serviciosValidos: ReadonlySet<string>;
  /** Reference instant for the future-date rule (defaults to now). */
  ahora?: Date;
}

/**
 * Validates and normalizes every row. Duplicate natural keys inside the same
 * file keep the first occurrence and reject the rest (re-uploads across
 * requests are handled by the upsert on citas_clave_natural).
 */
export function validarFilas(
  filas: Record<string, string>[],
  mapeo: MapeoColumnas,
  opciones: OpcionesValidacion,
): ResultadoValidacion {
  const ahora = opciones.ahora ?? new Date();
  const validas: CitaNormalizada[] = [];
  const rechazadas: FilaRechazada[] = [];
  const clavesVistas = new Set<string>();

  filas.forEach((datos, indice) => {
    const fila = indice + 1;
    const errores: string[] = [];
    const valor = (campo: CampoDestino): string => {
      const columna = mapeo[campo];
      return columna === undefined ? '' : (datos[columna] ?? '').trim();
    };

    const run = normalizarRun(valor('run'));
    if (run === null) {
      errores.push('RUN inválido (formato o dígito verificador incorrecto)');
    }

    const nombre = valor('nombre');
    if (nombre === '') {
      errores.push('Nombre vacío');
    }

    const telefono = normalizarTelefono(valor('telefono'));
    if (telefono === null) {
      errores.push('Teléfono no normalizable a formato +56 (E.164)');
    }

    const servicio = normalizarServicio(valor('servicio'));
    if (servicio === '') {
      errores.push('Servicio vacío');
    } else if (!opciones.serviciosValidos.has(servicio)) {
      errores.push(`Servicio inexistente: "${servicio}"`);
    }

    const fechaHora =
      mapeo.fecha_hora !== undefined
        ? parsearFechaHoraSantiago(valor('fecha_hora'))
        : parsearFechaHoraSantiago(valor('fecha'), valor('hora') || undefined);
    if (fechaHora === null) {
      errores.push('Fecha/hora inválida o en formato no reconocido');
    } else if (fechaHora.getTime() <= ahora.getTime()) {
      errores.push('La cita no está en el futuro');
    }

    if (errores.length === 0) {
      const clave = `${run}|${servicio}|${fechaHora!.toISOString()}`;
      if (clavesVistas.has(clave)) {
        errores.push('Fila duplicada en el archivo (misma clave RUN + servicio + fecha/hora)');
      } else {
        clavesVistas.add(clave);
      }
    }

    if (errores.length > 0) {
      rechazadas.push({ fila, errores, datos });
      return;
    }

    validas.push({
      run: run!,
      nombre,
      telefono: telefono!,
      servicio,
      profesional: valor('profesional') || null,
      fechaHora: fechaHora!,
    });
  });

  return { validas, rechazadas };
}
