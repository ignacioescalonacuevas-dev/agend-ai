/**
 * Messaging channel abstraction (RF-3). Real adapters (WhatsApp Cloud API,
 * Twilio SMS) implement this same interface in a later hito; hito 3 ships
 * mock adapters so the whole cascade runs without Meta/Twilio credentials.
 */

export type TipoCanal = 'whatsapp' | 'sms';

export interface MensajeSaliente {
  /** E.164 destination, e.g. '+56988776655'. */
  telefono: string;
  /** Template identifier (mirrors the approved Meta template name). */
  plantilla: string;
  /** Rendered message body (mock representation of the template). */
  texto: string;
}

export interface ResultadoEnvio {
  /** Provider message id, used for webhook dedup (RF-4). */
  externalMessageId: string;
}

export interface CanalMensajeria {
  readonly canal: TipoCanal;
  /** Sends the message; throws on delivery failure (callers handle retry). */
  enviar(mensaje: MensajeSaliente): Promise<ResultadoEnvio>;
}
