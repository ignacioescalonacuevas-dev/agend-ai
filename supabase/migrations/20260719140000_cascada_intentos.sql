-- Fase 0 · Hito 3 — cascade bookkeeping on intentos_contacto (RF-2/RF-3).
--
-- ciclo/paso identify the position of each attempt inside the contact
-- cascade (2 cycles of WhatsApp → SMS → manual call). The unique index is a
-- hard idempotency guarantee: a given step of a given cycle can only ever
-- produce ONE attempt per appointment, no matter how many times the job
-- runs ('una cita nunca entra dos veces a la cascada').

-- 'pendiente' backs two situations: a send in progress inside its
-- transaction, and the manual-call task queue of paso 3 (the operator
-- resolves it from the dashboard in a later hito).
alter type resultado_intento add value if not exists 'pendiente';

alter table intentos_contacto
  add column ciclo smallint not null default 1
    constraint intentos_contacto_ciclo check (ciclo in (1, 2)),
  add column paso smallint not null default 1
    constraint intentos_contacto_paso check (paso in (1, 2, 3));

create unique index intentos_contacto_cita_ciclo_paso_key
  on intentos_contacto (cita_id, ciclo, paso);
