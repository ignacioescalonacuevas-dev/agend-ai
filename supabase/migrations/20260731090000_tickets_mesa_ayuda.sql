-- Fase 1 · Mesa de ayuda (EETT §6) — hito 1: esquema + RLS, sin UI todavía.
--
-- Ticket único con los 12 campos mínimos del EETT (fecha apertura, canal,
-- solicitante, establecimiento, categoría, criticidad, profesional asignado,
-- primera respuesta, resolución, acciones, causa raíz, estado). Reutiliza
-- el multi-tenant + RLS ya construido en
-- 20260727090000_establecimientos_multi_tenant.sql (misma función
-- app_establecimiento_visible(), no se redefine).

create type criticidad_ticket as enum ('alta', 'media', 'baja');

-- Lineal, sin reapertura en v1 (ver DECISIONS.md D-034).
create type estado_ticket as enum ('abierto', 'en_atencion', 'resuelto', 'cerrado');

create type canal_ticket as enum ('telefono', 'correo', 'whatsapp', 'portal', 'presencial');

create table tickets (
  id                        uuid primary key default gen_random_uuid(),
  numero                    bigint generated always as identity,
  establecimiento_id        text not null references establecimientos (id),
  canal                     canal_ticket not null,
  solicitante_nombre        text not null,
  solicitante_contacto      text,
  -- Texto plano por ahora, no tenemos el listado exacto de categorías del
  -- EETT — mismo criterio que D-006 para `citas.servicio`.
  categoria                 text not null,
  criticidad                criticidad_ticket not null,
  -- EETT: cualquier incidente que interrumpa el envío de mensajes es
  -- criticidad alta, no discrecional. Flag explícito en vez de matchear
  -- contra `categoria` — ver DECISIONS.md D-034.
  interrumpe_envio_mensajes boolean not null default false,
  profesional_asignado      text,
  estado                    estado_ticket not null default 'abierto',
  fecha_apertura            timestamptz not null default now(),
  primera_respuesta_at      timestamptz,
  primera_respuesta_limite  timestamptz not null,
  resolucion_at             timestamptz,
  resolucion_limite         timestamptz not null,
  -- Log narrativo append-only a nivel de aplicación (transicionarTicket
  -- concatena, no reescribe).
  acciones                  text,
  -- Obligatorio al transicionar a 'resuelto' (ver estado-ticket.ts).
  causa_raiz                text,
  creado_at                 timestamptz not null default now(),
  actualizado_at            timestamptz not null default now()
);

create index tickets_establecimiento_idx on tickets (establecimiento_id);
create index tickets_estado_idx on tickets (estado, fecha_apertura);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on tickets to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on tickets to service_role;
  end if;
end $$;

alter table tickets enable row level security;

create policy establecimiento_scope on tickets
  for select using (app_establecimiento_visible(establecimiento_id));
