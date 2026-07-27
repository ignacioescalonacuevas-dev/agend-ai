/**
 * Outbound-call configuration (EETT §"Requisitos del Convenio": llamadas
 * salientes deben usar el prefijo 600, normativa SUBTEL 2025).
 *
 * El mock de hoy solo registra este valor (no hay carrier real detrás
 * todavía); el adaptador real de telefonía lo usará como remitente de la
 * llamada saliente.
 */
export const PREFIJO_LLAMADA_SALIENTE = '600';
