-- Fase 1 · Base de auth/roles — solo modelo de datos (D-035).
--
-- D-023 dejó pendiente para "hito 6": políticas RLS de INSERT/UPDATE por
-- rol, y el wiring real de claims JWT de Supabase Auth. Esta migración
-- resuelve la primera parte (el modelo de roles + las políticas de
-- escritura); el wiring de Supabase Auth queda para cuando exista un
-- proyecto real conectado (hoy no hay .env.local ni supabase-js).
--
-- Roles: solo los 4 que nombra el EETT §4 (admision, encargado_servicio,
-- jefatura per-establecimiento; coordinador_red red completa). No se
-- inventa un rol "admin" de plataforma sin respaldo en el EETT.

create type rol_perfil as enum ('admision', 'encargado_servicio', 'jefatura', 'coordinador_red');

create table perfiles (
  -- Sin FK a auth.users: esa tabla la crea el servicio GoTrue de un
  -- proyecto Supabase real, no esta migración — no hay uno conectado en
  -- dev/test todavía. Agregar la FK cuando exista.
  user_id            uuid primary key,
  rol                rol_perfil not null,
  establecimiento_id text references establecimientos (id),
  nombre             text,
  creado_at          timestamptz not null default now(),
  constraint perfiles_establecimiento_requerido
    check (rol = 'coordinador_red' or establecimiento_id is not null)
);

-- Sin RLS ni GRANT a `authenticated` sobre `perfiles`: gestionar perfiles
-- es server-side (service_role) por ahora, igual que la ingesta y la mesa
-- de ayuda — no hay UI de administración de usuarios todavía.

-- ── RLS de escritura ─────────────────────────────────────────────────────
-- app_establecimiento_visible() (lectura, ya existente) deja ver
-- coordinador_red de forma agregada. La escritura es más estricta:
-- coordinador_red es una vista agregada de solo lectura, no un rol
-- operativo que edita datos de otros establecimientos.

create or replace function app_establecimiento_propio(id_fila text)
returns boolean
language sql
stable
as $$
  select id_fila = current_setting('app.establecimiento_id', true);
$$;

-- Solo las tablas operativas que reciben escritura de un usuario real
-- (no servicios/plantillas_mapeo, que siguen siendo config server-side).
grant insert, update on citas, lista_espera, tickets to authenticated;

create policy establecimiento_escritura_insert on citas
  for insert with check (app_establecimiento_propio(establecimiento_id));
create policy establecimiento_escritura_update on citas
  for update using (app_establecimiento_propio(establecimiento_id))
  with check (app_establecimiento_propio(establecimiento_id));

create policy establecimiento_escritura_insert on lista_espera
  for insert with check (app_establecimiento_propio(establecimiento_id));
create policy establecimiento_escritura_update on lista_espera
  for update using (app_establecimiento_propio(establecimiento_id))
  with check (app_establecimiento_propio(establecimiento_id));

create policy establecimiento_escritura_insert on tickets
  for insert with check (app_establecimiento_propio(establecimiento_id));
create policy establecimiento_escritura_update on tickets
  for update using (app_establecimiento_propio(establecimiento_id))
  with check (app_establecimiento_propio(establecimiento_id));

-- Nota: los 3 roles locales (admision/encargado_servicio/jefatura)
-- comparten el mismo alcance de escritura (su propio establecimiento) — el
-- EETT no da una matriz de permisos exacta por rol dentro de un
-- establecimiento; diferenciar queda pendiente de un requisito más preciso.
