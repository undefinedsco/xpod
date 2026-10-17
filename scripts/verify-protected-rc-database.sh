#!/bin/sh
# Runs inside the existing PostgreSQL pod. Only read-only catalog queries;
# no reset, extension creation/upgrade, ownership or ACL mutation.
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGOPTIONS='-c default_transaction_read_only=on'
version=$(psql -X -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -Atc 'SHOW server_version_num')
case "$version" in
  17????) ;;
  *) echo 'Protected RC database requires separately verified PG17 migration; source retained' >&2; exit 1 ;;
esac
ready=$(psql -X -U "$POSTGRES_USER" -d xpod_rc -v ON_ERROR_STOP=1 -At <<'SQL'
BEGIN READ ONLY;
SELECT CASE WHEN
  current_database() = 'xpod_rc'
  AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = 'xpod_rc'
  AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector' AND extversion <> '')
  AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'xpod_rdf' AND extversion = '0.2.0')
  AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'xpod_qlever' AND extversion = '0.4.0')
  THEN 'protected-rc-ready' ELSE 'protected-rc-migration-required' END;
ROLLBACK;
SQL
)
# psql command tags are intentionally retained; only this exact transaction
# result admits deployment, and missing database/query errors fail closed.
test "$ready" = "BEGIN
protected-rc-ready
ROLLBACK" || {
  echo 'Protected RC database is not ready; verified backup/restore required, no database changes performed' >&2
  exit 1
}
echo 'Protected RC database read-only readiness passed; this is not migration acceptance'
