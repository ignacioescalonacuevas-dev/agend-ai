/**
 * Parses agenda files (CSV or XLSX) into header + rows of strings (RF-1).
 * Server-side only.
 */
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';

export interface ArchivoParseado {
  encabezados: string[];
  filas: Record<string, string>[];
}

export async function parsearArchivoAgenda(
  contenido: Buffer,
  nombreArchivo: string,
): Promise<ArchivoParseado> {
  const extension = nombreArchivo.toLowerCase().split('.').pop();
  if (extension === 'csv') return parsearCsv(contenido);
  if (extension === 'xlsx') return parsearXlsx(contenido);
  throw new Error(`Formato de archivo no soportado: .${extension} (use .csv o .xlsx)`);
}

function parsearCsv(contenido: Buffer): ArchivoParseado {
  const registros = parseCsv(contenido, {
    columns: true,
    bom: true,
    delimiter: [',', ';'],
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  const encabezados = registros.length > 0 ? Object.keys(registros[0]!) : [];
  return { encabezados, filas: registros };
}

async function parsearXlsx(contenido: Buffer): Promise<ArchivoParseado> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(contenido as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) throw new Error('El archivo Excel no tiene hojas');

  const encabezados: string[] = [];
  hoja.getRow(1).eachCell({ includeEmpty: false }, (celda, col) => {
    encabezados[col - 1] = celdaATexto(celda.value);
  });

  const filas: Record<string, string>[] = [];
  hoja.eachRow((filaExcel, numero) => {
    if (numero === 1) return;
    const fila: Record<string, string> = {};
    let vacia = true;
    encabezados.forEach((encabezado, indice) => {
      if (!encabezado) return;
      const texto = celdaATexto(filaExcel.getCell(indice + 1).value);
      fila[encabezado] = texto;
      if (texto !== '') vacia = false;
    });
    if (!vacia) filas.push(fila);
  });

  return { encabezados: encabezados.filter(Boolean), filas };
}

function celdaATexto(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) {
    // ExcelJS surfaces Excel date serials as UTC-based JS Dates holding the
    // wall-clock components; reformat so downstream parsing treats them as
    // Santiago wall time.
    const dt = DateTime.fromJSDate(valor, { zone: 'utc' });
    return dt.second === 0 && dt.hour === 0 && dt.minute === 0
      ? dt.toFormat('yyyy-MM-dd')
      : dt.toFormat('yyyy-MM-dd HH:mm');
  }
  if (typeof valor === 'object') {
    if ('richText' in valor) return valor.richText.map((t) => t.text).join('');
    if ('text' in valor) return String(valor.text);
    if ('result' in valor) return celdaATexto(valor.result as ExcelJS.CellValue);
    if ('error' in valor) return '';
  }
  return String(valor).trim();
}
