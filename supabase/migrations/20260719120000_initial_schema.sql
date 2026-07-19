-- Fase 0 · Hito 1 — initial schema for the appointment-confirmation and
-- slot-recovery system (PRD_recupero_cupos.md §6).
--
-- Conventions:
--   * Every timestamp is timestamptz (stored in UTC); presentation and
--     time-window logic localize to America/Santiago.
--   * Domain vocabulary (table/column/enum names) stays in Spanish to match
--     the PRD; comments are in English.
--   * No real patient data ever reaches this schema in dev environments.

-- ── Enums ────────────────────────────────────────────────────────────────

-- RF-5: appointment lifecycle. Silence NEVER frees a slot — only an explicit
-- 'cancelada' (or 'reagendar') triggers recovery.
create type estado_cita as enum (
  'pendiente',
  'en_contacto',
  'confirmada',
  'cancelada',
  'reagendar',
  'incontactable'
);

create type origen_cita as enum ('agenda', 'recupero');

create type canal_contacto as enum ('whatsapp', 'sms', 'llamada');

create type resultado_intento as enum ('enviado', 'entregado', 'fallido', 'respondido');

-- RF-6: lifecycle of a freed slot ("cupo"). NULL means the appointment's slot
-- has not been freed. 'en_oferta' is part of the pessimistic-locking scheme
-- that prevents double assignment.
create type estado_cupo as enum (
  'liberado',
  'en_oferta',
  'reasignado',
  'recuperable_no_tomado'
);

create type resultado_oferta as enum ('pendiente', 'aceptada', 'rechazada', 'expirada');

-- ── Tables ───────────────────────────────────────────────────────────────

create table pacientes (
  run                         text primary key,
  nombre                      text not null,
  -- E.164 numbers (+56...), first element is the preferred callback number.
  telefonos                   text[] not null default '{}',
  canal_preferido             canal_contacto not null default 'whatsapp',
  consentimiento_contacto     boolean not null default false,
  consentimiento_aviso_corto  boolean not null default false,
  creado_at                   timestamptz not null default now(),
  actualizado_at              timestamptz not null default now(),
  -- Normalized RUN: digits without dots, dash, verifier digit (0-9 or K).
  -- Verifier-digit (mod 11) validation happens at ingestion (RF-1).
  constraint pacientes_run_formato check (run ~ '^[1-9][0-9]{6,7}-[0-9K]$')
);

create table citas (
  id            uuid primary key default gen_random_uuid(),
  run_paciente  text not null references pacientes (run),
  servicio      text not null,
  profesional   text,
  fecha_hora    timestamptz not null,
  estado        estado_cita not null default 'pendiente',
  origen        origen_cita not null default 'agenda',
  -- NULL until the slot is freed by a 'cancelada'/'reagendar' transition.
  estado_cupo   estado_cupo,
  creado_at     timestamptz not null default now(),
  actualizado_at timestamptz not null default now(),
  -- RF-1 dedup: re-uploading the same agenda updates instead of duplicating.
  constraint citas_clave_natural unique (run_paciente, servicio, fecha_hora)
);

-- RF-2: hourly scheduler scans for 'pendiente' appointments in the +24h/+48h window.
create index citas_scheduler_idx on citas (estado, fecha_hora);
-- RF-7: per-service dashboard views.
create index citas_servicio_fecha_idx on citas (servicio, fecha_hora);

create table intentos_contacto (
  id                  uuid primary key default gen_random_uuid(),
  cita_id             uuid not null references citas (id),
  canal               canal_contacto not null,
  plantilla           text,
  enviado_at          timestamptz not null default now(),
  resultado           resultado_intento not null default 'enviado',
  external_message_id text,
  creado_at           timestamptz not null default now()
);

create index intentos_contacto_cita_idx on intentos_contacto (cita_id, enviado_at);
-- Webhook idempotency (RF-4): provider message ids must be unique so status
-- callbacks can be deduplicated before processing.
create unique index intentos_contacto_external_message_id_key
  on intentos_contacto (external_message_id)
  where external_message_id is not null;

create table lista_espera (
  id             uuid primary key default gen_random_uuid(),
  run_paciente   text not null references pacientes (run),
  servicio       text not null,
  -- Lower value = higher priority; ties broken by fecha_ingreso (FIFO).
  prioridad      integer not null default 100,
  pre_consentido boolean not null default false,
  fecha_ingreso  timestamptz not null default now(),
  creado_at      timestamptz not null default now(),
  constraint lista_espera_unica unique (run_paciente, servicio)
);

-- RF-6 candidate selection: same service, pre-consented, ordered by
-- priority then seniority.
create index lista_espera_seleccion_idx
  on lista_espera (servicio, prioridad, fecha_ingreso)
  where pre_consentido;

create table ofertas_recupero (
  id           uuid primary key default gen_random_uuid(),
  cupo_cita_id uuid not null references citas (id),
  run_paciente text not null references pacientes (run),
  enviada_at   timestamptz not null default now(),
  -- RF-6: 2-hour offer timeout, enforced by the orchestrator.
  expira_at    timestamptz not null,
  resultado    resultado_oferta not null default 'pendiente',
  creado_at    timestamptz not null default now(),
  constraint ofertas_recupero_expira check (expira_at > enviada_at)
);

-- RF-6 hard guarantee at the schema level: a slot can never have two live
-- offers at the same time (offers are strictly sequential).
create unique index ofertas_recupero_una_activa_por_cupo
  on ofertas_recupero (cupo_cita_id)
  where resultado = 'pendiente';

create index ofertas_recupero_paciente_idx on ofertas_recupero (run_paciente);

-- RF-8: append-only audit trail (mutation rights are revoked in the next
-- migration). Every state transition, offer, upload and user action lands here.
create table eventos_auditoria (
  id         bigint generated always as identity primary key,
  entidad    text not null,
  entidad_id text not null,
  accion     text not null,
  actor      text not null,
  detalle    jsonb not null default '{}'::jsonb,
  creado_at  timestamptz not null default now()
);

create index eventos_auditoria_entidad_idx
  on eventos_auditoria (entidad, entidad_id, creado_at);
create index eventos_auditoria_creado_idx on eventos_auditoria (creado_at);
