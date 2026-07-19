-- Fase 0 · Hito 1 — make eventos_auditoria append-only (PRD RF-8).
--
-- Two layers:
--   1. GRANTs: no application role keeps UPDATE / DELETE / TRUNCATE.
--      (On Supabase, default privileges grant ALL on new tables to anon,
--      authenticated and service_role, so the revokes below are required.)
--   2. Trigger guard: even the table owner cannot mutate rows through
--      normal SQL. A superuser could still drop the trigger, but that is
--      outside the application threat model and would itself be visible
--      in the migration history.

revoke update, delete, truncate on table eventos_auditoria from public;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format(
        'revoke update, delete, truncate on table eventos_auditoria from %I', r);
      -- Keep the rights an append-only log actually needs.
      execute format(
        'grant select, insert on table eventos_auditoria to %I', r);
      -- The identity column draws from a sequence; INSERT needs USAGE on it.
      execute format(
        'grant usage, select on sequence %s to %I',
        pg_get_serial_sequence('eventos_auditoria', 'id'), r);
    end if;
  end loop;
end $$;

create function eventos_auditoria_bloquear_mutacion()
returns trigger
language plpgsql
as $$
begin
  raise exception 'eventos_auditoria is append-only: % is not allowed', tg_op;
end;
$$;

create trigger eventos_auditoria_append_only
  before update or delete on eventos_auditoria
  for each row
  execute function eventos_auditoria_bloquear_mutacion();

create trigger eventos_auditoria_no_truncate
  before truncate on eventos_auditoria
  for each statement
  execute function eventos_auditoria_bloquear_mutacion();
