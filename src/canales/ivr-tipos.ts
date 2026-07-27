/**
 * Voice channel abstraction (RF-3, paso 3: llamada de confirmación).
 *
 * Deliberately NOT the same shape as `CanalMensajeria`: a phone call is not
 * "send and forget" like WhatsApp/SMS. `llamar()` only places the call —
 * whether the patient answered, pressed a DTMF option, or never picked up
 * arrives later via the provider's status webhook (hito 4, not built yet).
 * Until then, a successful `llamar()` records the attempt as `enviado`
 * (call placed) the same way a sent WhatsApp message does before its
 * delivery/read receipt.
 */

export interface LlamadaSaliente {
  /** E.164 destination, e.g. '+56988776655'. */
  telefono: string;
  /** Script/TTS identifier (mirrors `plantilla` for messaging channels). */
  guion: string;
  /** Rendered script text (mock representation of the TTS prompt). */
  texto: string;
  /** Outbound caller id prefix (EETT: 600, normativa SUBTEL). */
  remitente: string;
}

export interface ResultadoLlamada {
  /** Provider call id, used for webhook dedup once hito 4 exists. */
  externalCallId: string;
}

export interface CanalLlamada {
  readonly canal: 'llamada';
  /** Places the call; throws if the provider could not even place it (callers handle retry). */
  llamar(llamada: LlamadaSaliente): Promise<ResultadoLlamada>;
}
