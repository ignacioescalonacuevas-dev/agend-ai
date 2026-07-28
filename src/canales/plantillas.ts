/**
 * Patient-facing message templates (RF-3) — Chilean Spanish, formal-close
 * register ("usted"). The WhatsApp text is the mock rendering of the
 * 3-button Meta template; the real template goes to Meta for approval in
 * week 1 (PRD §7) and keeps these same variables.
 */

export const PLANTILLA_WHATSAPP_INFORMATIVO = 'recordatorio_informativo_v1';
export const PLANTILLA_WHATSAPP_BOTONES = 'recordatorio_botones_v1';
export const PLANTILLA_SMS_ENLACE = 'recordatorio_sms_enlace_v1';
export const GUION_LLAMADA_CONFIRMACION = 'llamada_confirmacion_v1';

export interface VariablesRecordatorio {
  nombre: string;
  servicio: string;
  /** Local Santiago date/time already formatted, e.g. '25-08-2026 10:30'. */
  fechaLocal: string;
}

/** Recordatorio informativo (EETT: 5-7 días antes), uno-a-muchos: no pide respuesta. */
export function textoWhatsAppInformativo(v: VariablesRecordatorio): string {
  return (
    `Estimado(a) ${v.nombre}: le recordamos que tiene una cita de ${v.servicio} ` +
    `agendada para el ${v.fechaLocal}. Este mensaje es solo informativo, no es ` +
    `necesario responder.`
  );
}

export function textoWhatsAppBotones(v: VariablesRecordatorio): string {
  return (
    `Estimado(a) ${v.nombre}: le recordamos su cita de ${v.servicio} ` +
    `el ${v.fechaLocal}. Por favor indíquenos su asistencia.\n` +
    `[Botones: ✅ Confirmo · ❌ Cancelo · 🔄 Necesito cambiar]`
  );
}

export function textoSmsEnlace(v: VariablesRecordatorio & { enlace: string }): string {
  return (
    `${v.nombre}: le recordamos su cita de ${v.servicio} el ${v.fechaLocal}. ` +
    `Confirme o cancele en un toque aquí: ${v.enlace}`
  );
}

/** TTS prompt for the IVR confirmation call (paso 'llamada'). DTMF capture (1/2/3) arrives with hito 4. */
export function textoLlamadaConfirmacion(v: VariablesRecordatorio): string {
  return (
    `Hola, le habla el Servicio de Salud Aysén. Le recordamos su cita de ${v.servicio} ` +
    `el ${v.fechaLocal}. Para confirmar, presione 1. Para cancelar, presione 2. ` +
    `Para hablar con un operador, presione 3.`
  );
}
