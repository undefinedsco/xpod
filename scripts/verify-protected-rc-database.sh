#!/bin/sh
# Runs inside the RC-only PostgreSQL pod. Read-only catalog queries only; the
# bootstrap Job owns role/database/extension creation.
#
# The shared production instance is never contacted: this script is invoked
# with `kubectl exec statefulset/xpod-rc-rdf-postgres`, so PGHOST is the local
# socket of the RC server.
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGOPTIONS='-c default_transaction_read_only=on'
export PGHOST=/var/run/postgresql
version=$(psql -X -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -Atc 'SHOW server_version_num')
case "$version" in
  17????) ;;
  *) echo 'RC-only PostgreSQL is not PG17; refusing deployment' >&2; exit 1 ;;
esac
ready=$(psql -X -U "$POSTGRES_USER" -d xpod_rc -v ON_ERROR_STOP=1 -At <<'SQL'
BEGIN READ ONLY;
SELECT CASE WHEN
  current_database() = 'xpod_rc'
  AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = 'xpod_rc'
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xpod_rc' AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb)
  AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector' AND extversion <> '')
  AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'xpod_rdf' AND extversion = '0.2.0')
  AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'xpod_qlever' AND extversion = '0.4.0')
  THEN 'rc-only-pg-ready' ELSE 'rc-only-pg-bootstrap-required' END;
ROLLBACK;
SQL
)
test "$ready" = "BEGIN
rc-only-pg-ready
ROLLBACK" || {
  echo 'RC-only PostgreSQL is not ready; the bootstrap Job must own role/database/extension provisioning' >&2
  exit 1
}
echo 'RC-only PostgreSQL read-only readiness passed; production instance untouched'
