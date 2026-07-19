/**
 * Chilean RUN validation and normalization (RF-1).
 *
 * Stored format (see migration CHECK): digits without dots, dash, verifier
 * digit — e.g. '12345678-5', '7654321-K'.
 */

/** Computes the mod-11 verifier digit for a RUN body (digits only). */
export function calcularDigitoVerificador(cuerpo: string): string {
  let suma = 0;
  let multiplicador = 2;
  for (let i = cuerpo.length - 1; i >= 0; i -= 1) {
    suma += Number(cuerpo.charAt(i)) * multiplicador;
    multiplicador = multiplicador === 7 ? 2 : multiplicador + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

/**
 * Normalizes any common RUN spelling ('12.345.678-5', '12345678-5',
 * '123456785', with lowercase k or stray spaces) to the canonical stored
 * form. Returns null when the format or the verifier digit is invalid.
 */
export function normalizarRun(entrada: string): string | null {
  const limpio = entrada.trim().toUpperCase().replace(/\./g, '').replace(/\s+/g, '');
  if (limpio.length < 2) return null;
  const conGuion = limpio.includes('-')
    ? limpio
    : `${limpio.slice(0, -1)}-${limpio.slice(-1)}`;
  const m = /^([1-9][0-9]{6,7})-([0-9K])$/.exec(conGuion);
  if (!m) return null;
  const cuerpo = m[1]!;
  const dv = m[2]!;
  if (calcularDigitoVerificador(cuerpo) !== dv) return null;
  return `${cuerpo}-${dv}`;
}

/** Generates a synthetic but verifier-valid RUN from a numeric seed (for seeds/tests). */
export function runSintetico(cuerpoNumerico: number): string {
  const cuerpo = String(cuerpoNumerico);
  return `${cuerpo}-${calcularDigitoVerificador(cuerpo)}`;
}
