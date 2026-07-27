/**
 * In-memory mock voice channel (RF-3): records every call placed,
 * optionally logs to console (dev worker) and can simulate provider
 * failures (tests) — same shape as `CanalMock` for messaging.
 */
import { randomUUID } from 'node:crypto';
import type { CanalLlamada, LlamadaSaliente, ResultadoLlamada } from './ivr-tipos';

export interface LlamadaRegistrada extends LlamadaSaliente {
  externalCallId: string;
  colocadaAt: Date;
}

export interface OpcionesCanalLlamadaMock {
  /** Return true to make that call throw (simulated carrier outage). */
  fallar?: (llamada: LlamadaSaliente) => boolean;
  log?: boolean;
}

export class CanalLlamadaMock implements CanalLlamada {
  readonly canal = 'llamada' as const;
  readonly colocadas: LlamadaRegistrada[] = [];

  constructor(private readonly opciones: OpcionesCanalLlamadaMock = {}) {}

  async llamar(llamada: LlamadaSaliente): Promise<ResultadoLlamada> {
    if (this.opciones.fallar?.(llamada) === true) {
      throw new Error(`[mock llamada] simulated carrier failure calling ${llamada.telefono}`);
    }
    const externalCallId = `mock-llamada-${randomUUID()}`;
    this.colocadas.push({ ...llamada, externalCallId, colocadaAt: new Date() });
    if (this.opciones.log === true) {
      console.log(
        `[mock llamada] ${llamada.remitente} -> ${llamada.telefono} (${llamada.guion}) ${externalCallId}\n  ${llamada.texto}`,
      );
    }
    return { externalCallId };
  }
}
