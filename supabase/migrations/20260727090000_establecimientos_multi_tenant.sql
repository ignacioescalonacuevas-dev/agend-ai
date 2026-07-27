-- Fase 1 · multi-tenant — one platform, ten establecimientos (EETT
-- "DETALLE DE SERVICIOS REQUERIDOS" / facturación §"FACTURACIÓN Y PAGO").
--
-- Each establecimiento is its own contract (own RUT, own budget line, own
-- purchase order) sharing one platform. This migration:
--   1. introduces `establecimientos` as first-class reference data;
--   2. scopes `servicios`, `citas`, `lista_espera`, `plantillas_mapeo` by
--      establecimiento_id (composite keys where the old PK/unique
--      constraint assumed a single tenant);
--   3. turns on RLS for those tables with a session-GUC-based policy
--      (`app.establecimiento_id`, `app.coordinador_red`) as the foundation
--      dashboards (hito 6) will wire real Supabase Auth claims into.
--
-- `pacientes` and `eventos_auditoria` intentionally stay OUT of this
-- migration — see DECISIONS.md D-00* for why, and what is still open.

-- ── Reference data: the ten establecimientos of the licitación ─────────────

create table establecimientos (
  id                text primary key,     -- slug, stable across environments
  nombre            text not null,
  -- Normalized like pacientes.run (no dots); null where the EETT's billing
  -- section does not state one explicitly (see comment below).
  rut               text,
  comuna            text not null,
  direccion         text,
  -- "VALOR TOTAL DISPONIBLE" from the EETT, informational (drives no logic
  -- yet; feeds the monthly-report/billing module of Fase 7).
  monto_disponible_clp bigint,
  activo            boolean not null default true,
  creado_at         timestamptz not null default now(),
  constraint establecimientos_rut_formato check (rut is null or rut ~ '^[1-9][0-9]{6,7}-[0-9K]$')
);

insert into establecimientos (id, nombre, rut, comuna, direccion, monto_disponible_clp) values
  ('consultorio-alejandro-gutierrez', 'Consultorio Alejandro Gutiérrez', '61974500-0', 'Coyhaique', 'Bilbao esquina Mackenna S/n', 107214852),
  ('consultorio-victor-domingo-silva', 'Consultorio Víctor Domingo Silva', '61974700-3', 'Coyhaique', 'Alejandro Gutiérrez N° 870', 81981048),
  ('cesfam-puerto-aysen', 'Cesfam Puerto Aysén', '62000940-7', 'Puerto Aysén', 'Eleuterio Ramírez N° 1035', 90978108),
  ('cosam-coyhaique', 'Cosam Coyhaique', '61607800-3', 'Coyhaique', 'Ramón Freire N° 1435', 23584908),
  -- No separate RUT stated in the EETT for this line item; it is billed
  -- under Dirección de Salud Rural administratively. Confirm before go-live.
  ('direccion-salud-rural-la-junta', 'Dirección de Salud Rural (Cesfam La Junta)', null, 'La Junta', null, 17396124),
  ('hospital-puerto-aysen', 'Hospital Puerto Aysén', '61602279-2', 'Puerto Aysén', 'Yusseff Laibe N° 180', 78576132),
  ('hospital-puerto-cisnes', 'Hospital Puerto Cisnes (Jorge Ibar Bruce)', '61602293-8', 'Puerto Cisnes', 'Rafael Sotomayor N° 869', 57213708),
  ('hospital-cochrane', 'Hospital Cochrane', '61602292-K', 'Cochrane', 'Doctor Steffens N° 730', 56933016),
  ('hospital-chile-chico', 'Hospital Chile Chico (Dr. Leopoldo Ortega Rodríguez)', '61602281-4', 'Chile Chico', 'Lautaro N° 275', 48871308),
  ('direccion-salud-rural', 'Dirección de Salud Rural', '61974600-7', 'Coyhaique', 'Simón Bolívar N° 26', 56933016);

-- ── servicios: catalog becomes per-establecimiento ──────────────────────────
-- Each site manages its own service catalog (RF "gestión local de
-- campañas"); the same slug ('dermatologia') can exist at two sites as two
-- distinct rows.

alter table citas drop constraint citas_servicio_fk;
alter table lista_espera drop constraint lista_espera_servicio_fk;

alter table servicios
  add column establecimiento_id text references establecimientos (id),
  drop constraint servicios_pkey;

update servicios set establecimiento_id = 'hospital-puerto-aysen' where establecimiento_id is null;
-- Pre-multi-tenant rows (Fase 0 seed/tests) land on one site as a migration
-- default; see DECISIONS.md — Fase 0 never had real production data.

alter table servicios
  alter column establecimiento_id set not null,
  add constraint servicios_pkey primary key (establecimiento_id, id);

-- ── citas: establecimiento_id + composite FK to servicios ──────────────────

alter table citas
  add column establecimiento_id text references establecimientos (id);

update citas set establecimiento_id = 'hospital-puerto-aysen' where establecimiento_id is null;

alter table citas
  alter column establecimiento_id set not null,
  add constraint citas_servicio_fk
    foreign key (establecimiento_id, servicio) references servicios (establecimiento_id, id);

alter table citas drop constraint citas_clave_natural;
alter table citas
  add constraint citas_clave_natural
    unique (establecimiento_id, run_paciente, servicio, fecha_hora);

drop index citas_servicio_fecha_idx;
create index citas_servicio_fecha_idx on citas (establecimiento_id, servicio, fecha_hora);
create index citas_establecimiento_idx on citas (establecimiento_id);
-- citas_scheduler_idx (estado, fecha_hora) stays global on purpose: the
-- scheduler is one background job for the whole platform, not one per site.

-- ── lista_espera: same treatment ────────────────────────────────────────────

alter table lista_espera
  add column establecimiento_id text references establecimientos (id);

update lista_espera set establecimiento_id = 'hospital-puerto-aysen' where establecimiento_id is null;

alter table lista_espera
  alter column establecimiento_id set not null,
  add constraint lista_espera_servicio_fk
    foreign key (establecimiento_id, servicio) references servicios (establecimiento_id, id);

alter table lista_espera drop constraint lista_espera_unica;
alter table lista_espera
  add constraint lista_espera_unica unique (establecimiento_id, run_paciente, servicio);

drop index lista_espera_seleccion_idx;
create index lista_espera_seleccion_idx
  on lista_espera (establecimiento_id, servicio, prioridad, fecha_ingreso)
  where pre_consentido;

-- ── plantillas_mapeo: saved ingestion mappings are per-establecimiento ─────
-- (each site's HIS/Excel export has its own column layout).

alter table plantillas_mapeo
  add column establecimiento_id text references establecimientos (id);

update plantillas_mapeo set establecimiento_id = 'hospital-puerto-aysen' where establecimiento_id is null;

alter table plantillas_mapeo
  alter column establecimiento_id set not null,
  drop constraint plantillas_mapeo_nombre_key,
  add constraint plantillas_mapeo_nombre_key unique (establecimiento_id, nombre);

-- ── Row-Level Security foundation ───────────────────────────────────────────
-- Policy shape: a session either carries app.establecimiento_id (scoped to
-- one site) or app.coordinador_red = 'true' (network-wide, per the EETT's
-- "Coordinador de la Red" role). Real values arrive via Supabase Auth JWT
-- claims in hito 6; until then the app sets these with `set_config` per
-- request. service_role (background jobs: scheduler, cascada, webhooks)
-- bypasses RLS entirely, same as Postgres/Supabase default.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    alter role service_role bypassrls;
  end if;
end $$;

-- Table-level GRANTs are a prerequisite to RLS (RLS filters rows, it does
-- not substitute for privilege checks). `authenticated` gets read access
-- for the future per-role dashboards; write policies stay server-side
-- (service_role) until hito 6 wires per-user sessions.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on servicios, citas, lista_espera, plantillas_mapeo to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete
      on servicios, citas, lista_espera, plantillas_mapeo to service_role;
  end if;
end $$;

create or replace function app_establecimiento_visible(id_fila text)
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.coordinador_red', true), 'false') = 'true'
      or id_fila = current_setting('app.establecimiento_id', true);
$$;

alter table servicios enable row level security;
alter table citas enable row level security;
alter table lista_espera enable row level security;
alter table plantillas_mapeo enable row level security;

create policy establecimiento_scope on servicios
  for select using (app_establecimiento_visible(establecimiento_id));
create policy establecimiento_scope on citas
  for select using (app_establecimiento_visible(establecimiento_id));
create policy establecimiento_scope on lista_espera
  for select using (app_establecimiento_visible(establecimiento_id));
create policy establecimiento_scope on plantillas_mapeo
  for select using (app_establecimiento_visible(establecimiento_id));

-- INSERT/UPDATE policies are deferred to hito 6: today every write goes
-- through server-side routes using service_role (which bypasses RLS), not
-- through a per-user Supabase session. Adding write policies now, before
-- any code authenticates as `authenticated`, would be untested surface.
