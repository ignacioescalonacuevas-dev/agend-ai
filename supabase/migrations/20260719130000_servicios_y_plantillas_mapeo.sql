-- Fase 0 · Hito 2 — service catalog and saved column-mapping templates (RF-1).
--
-- RF-1 requires validating "servicio existente" on upload; a catalog table
-- resolves DECISIONS.md D-006. The FK constraints make the rule hold at the
-- schema level too, not only in ingestion code.

create table servicios (
  id        text primary key,          -- slug used in files and URLs, e.g. 'dermatologia'
  nombre    text not null,             -- display name, e.g. 'Dermatología'
  activo    boolean not null default true,
  creado_at timestamptz not null default now()
);

alter table citas
  add constraint citas_servicio_fk foreign key (servicio) references servicios (id);

alter table lista_espera
  add constraint lista_espera_servicio_fk foreign key (servicio) references servicios (id);

-- RF-1: configurable column mapping with a saved template per upload source.
create table plantillas_mapeo (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null unique,
  -- {campo_destino: "Encabezado en el archivo"} — see src/domain/ingesta.ts
  mapeo          jsonb not null,
  creado_at      timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);
