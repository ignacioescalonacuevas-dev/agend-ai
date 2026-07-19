/**
 * Chilean phone normalization to E.164 (+56...) — RF-1.
 *
 * Accepted inputs (with any spacing, dots, dashes or parentheses):
 *   '+56 9 1234 5678', '56912345678', '912345678', '09 1234 5678',
 *   '221234567' (Santiago landline), '+56221234567'.
 * Rejected: anything that does not resolve to exactly 9 national digits.
 */
export function normalizarTelefono(entrada: string): string | null {
  let digitos = entrada.replace(/[^0-9+]/g, '');
  if (digitos.startsWith('+')) digitos = digitos.slice(1);
  if (digitos.startsWith('56') && digitos.length > 9) digitos = digitos.slice(2);
  // Trunk zero sometimes exported by legacy systems ('09...').
  if (digitos.startsWith('0') && digitos.length === 10) digitos = digitos.slice(1);
  // Chilean national numbers (mobile and landline) are 9 digits since 2016.
  if (!/^[2-9][0-9]{8}$/.test(digitos)) return null;
  return `+56${digitos}`;
}

export function esMovil(e164: string): boolean {
  return e164.startsWith('+569');
}
