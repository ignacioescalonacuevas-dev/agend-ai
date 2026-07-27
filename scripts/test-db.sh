#!/usr/bin/env bash
# Throwaway Postgres for integration tests.
#
#   scripts/test-db.sh start   # boot cluster + create roles + apply migrations
#   scripts/test-db.sh stop    # tear it down
#   scripts/test-db.sh run     # start -> vitest -> stop (exit code = vitest's)
#
# Prefers Docker (postgres:16). Falls back to a local initdb cluster when the
# Docker daemon is unavailable (CI sandboxes). Either way it exposes:
#   postgres://postgres@127.0.0.1:${TEST_PG_PORT:-54329}/recupero_test
set -euo pipefail

PORT="${TEST_PG_PORT:-54329}"
DB_NAME="recupero_test"
CONTAINER="recupero-cupos-test-pg"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
# When run as root the cluster runs as the unprivileged 'user' (initdb refuses
# root), so the data dir must live somewhere that user can traverse.
if [ "$(id -u)" = "0" ] && id -u user >/dev/null 2>&1; then
  DEFAULT_PG_DIR="$(getent passwd user | cut -d: -f6)/.recupero-cupos-testpg"
else
  DEFAULT_PG_DIR="$HOME/.recupero-cupos-testpg"
fi
DATA_ROOT="${TEST_PG_DIR:-$DEFAULT_PG_DIR}"
export DATABASE_URL="postgres://postgres@127.0.0.1:${PORT}/${DB_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

have_docker() { docker info >/dev/null 2>&1; }

# initdb refuses to run as root; delegate to an unprivileged user if needed.
run_unpriv() {
  if [ "$(id -u)" = "0" ] && id -u user >/dev/null 2>&1; then
    su user -s /bin/bash -c "$*"
  else
    bash -c "$*"
  fi
}

wait_ready() {
  for _ in $(seq 1 30); do
    if psql "postgres://postgres@127.0.0.1:${PORT}/postgres" -c 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Postgres did not become ready on port ${PORT}" >&2
  return 1
}

bootstrap() {
  local admin="postgres://postgres@127.0.0.1:${PORT}/postgres"
  psql "$admin" -qc "drop database if exists ${DB_NAME}"
  psql "$admin" -qc "create database ${DB_NAME}"
  # Emulate the Supabase application roles so the GRANT-level tests are real.
  psql "$admin" -qc "do \$\$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end \$\$;"
  psql "$DATABASE_URL" -qc "grant usage on schema public to anon, authenticated, service_role;"
  psql "$DATABASE_URL" -qc "grant select, insert, update, delete on all tables in schema public to authenticated, service_role;" 2>/dev/null || true
  node "${SCRIPT_DIR}/apply-migrations.mjs"
  # Minimal synthetic service catalog used across test suites, duplicated
  # across two establecimientos so multi-tenant isolation is exercisable.
  psql "$DATABASE_URL" -qc "insert into servicios (establecimiento_id, id, nombre) values
      ('hospital-puerto-aysen', 'dermatologia', 'Dermatología'),
      ('hospital-puerto-aysen', 'oftalmologia', 'Oftalmología'),
      ('hospital-puerto-aysen', 'traumatologia', 'Traumatología'),
      ('hospital-cochrane', 'dermatologia', 'Dermatología'),
      ('hospital-cochrane', 'medicina-interna', 'Medicina Interna')
    on conflict (establecimiento_id, id) do nothing;"
  echo "test database ready: ${DATABASE_URL}"
}

start() {
  if have_docker; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$CONTAINER" -e POSTGRES_HOST_AUTH_METHOD=trust \
      -p "${PORT}:5432" postgres:16 >/dev/null
  else
    [ -n "$PGBIN" ] || { echo "Neither Docker nor local Postgres binaries found" >&2; exit 1; }
    stop || true
    rm -rf "$DATA_ROOT"
    mkdir -p "$DATA_ROOT"
    if [ "$(id -u)" = "0" ] && id -u user >/dev/null 2>&1; then chown -R user "$DATA_ROOT"; fi
    run_unpriv "'$PGBIN/initdb' -D '$DATA_ROOT/data' -U postgres --auth=trust -E UTF8 >/dev/null"
    run_unpriv "'$PGBIN/pg_ctl' -D '$DATA_ROOT/data' -o '-p ${PORT} -k \"$DATA_ROOT\"' -l '$DATA_ROOT/log' start >/dev/null"
  fi
  wait_ready
  bootstrap
}

stop() {
  if have_docker; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  elif [ -d "$DATA_ROOT/data" ] && [ -n "$PGBIN" ]; then
    run_unpriv "'$PGBIN/pg_ctl' -D '$DATA_ROOT/data' stop -m fast >/dev/null 2>&1" || true
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  run)
    start
    set +e
    npx vitest run
    code=$?
    set -e
    stop
    exit $code
    ;;
  *) echo "usage: $0 {start|stop|run}" >&2; exit 1 ;;
esac
