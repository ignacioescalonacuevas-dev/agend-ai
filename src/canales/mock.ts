/**
 * In-memory mock channel (RF-3): records every message, optionally logs to
 * console (dev worker) and can simulate failures (tests).
 */
import { randomUUID } from 'node:crypto';
import type {
  CanalMensajeria,
  MensajeSaliente,
  ResultadoEnvio,
  TipoCanal,
} from './tipos';

export interface MensajeRegistrado extends MensajeSaliente {
  externalMessageId: string;
  enviadoAt: Date;
}

export interface OpcionesCanalMock {
  /** Return true to make that send throw (simulated provider outage). */
  fallar?: (mensaje: MensajeSaliente) => boolean;
  log?: boolean;
}

export class CanalMock implements CanalMensajeria {
  readonly enviados: MensajeRegistrado[] = [];

  constructor(
    readonly canal: TipoCanal,
    private readonly opciones: OpcionesCanalMock = {},
  ) {}

  async enviar(mensaje: MensajeSaliente): Promise<ResultadoEnvio> {
    if (this.opciones.fallar?.(mensaje) === true) {
      throw new Error(`[mock ${this.canal}] simulated delivery failure to ${mensaje.telefono}`);
    }
    const externalMessageId = `mock-${this.canal}-${randomUUID()}`;
    this.enviados.push({ ...mensaje, externalMessageId, enviadoAt: new Date() });
    if (this.opciones.log === true) {
      console.log(
        `[mock ${this.canal}] -> ${mensaje.telefono} (${mensaje.plantilla}) ${externalMessageId}\n  ${mensaje.texto}`,
      );
    }
    return { externalMessageId };
  }
}
