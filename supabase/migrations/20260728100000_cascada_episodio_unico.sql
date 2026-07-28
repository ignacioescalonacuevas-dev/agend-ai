-- Fase 1 · D-029/D-031 — reemplaza el modelo "2 ciclos x 3 pasos" por un
-- episodio único de contacto con los pasos y anclajes exactos del EETT:
-- informativo (5-7 días antes, uno-a-muchos) -> interactivo_1 (WhatsApp,
-- ventana +24h/+48h ya existente) -> interactivo_2 (SMS, +120 min) ->
-- llamada (IVR, anclada a T-24h). No hay datos de producción todavía
-- (Fase 1 en curso), así que esta migración reescribe el esquema en vez de
-- preservar filas existentes — mismo criterio que D-025.

drop index intentos_contacto_cita_ciclo_paso_key;

alter table intentos_contacto
  drop constraint intentos_contacto_paso,
  drop column ciclo,
  drop column paso;

create type paso_cascada as enum ('informativo', 'interactivo_1', 'interactivo_2', 'llamada');

alter table intentos_contacto
  add column paso paso_cascada not null default 'interactivo_1';

alter table intentos_contacto
  alter column paso drop default;

create unique index intentos_contacto_cita_paso_key
  on intentos_contacto (cita_id, paso);
