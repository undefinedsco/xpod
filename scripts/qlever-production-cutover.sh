#!/usr/bin/env bash
set -euo pipefail

readonly MODE="${1:-preflight}"
readonly NAMESPACE="${SEALOS_NAMESPACE:?SEALOS_NAMESPACE is required}"
readonly POSTGRES_IMAGE="${XPOD_POSTGRES_IMAGE:?XPOD_POSTGRES_IMAGE is required}"
readonly XPOD_IMAGE="${XPOD_IMAGE:?XPOD_IMAGE is required}"
readonly OLD_POSTGRES_STS="${XPOD_OLD_POSTGRES_STS:-postgres}"
readonly OLD_POSTGRES_SERVICE="${XPOD_OLD_POSTGRES_SERVICE:-postgres}"
readonly NEW_POSTGRES_STS="${XPOD_NEW_POSTGRES_STS:-xpod-rdf-postgres}"
readonly NEW_POSTGRES_SERVICE="${XPOD_NEW_POSTGRES_SERVICE:-xpod-rdf-postgres}"
readonly XPOD_DEPLOYMENTS=(xpod-cloud xpod-rc)
readonly WRITER_DEPLOYMENTS=(xpod-cloud xpod-rc xpod-inngest)
readonly XPOD_SECRETS=(xpod-cloud-secret xpod-rc-secret)

if [[ "$MODE" != preflight && "$MODE" != cutover ]]; then
  echo "Usage: $0 <preflight|cutover>" >&2
  exit 64
fi
if [[ ! "$POSTGRES_IMAGE" =~ ^ghcr\.io/undefinedsco/xpod-rdf-postgres@sha256:[0-9a-f]{64}$ ]]; then
  echo 'XPOD_POSTGRES_IMAGE must be an immutable digest reference' >&2
  exit 64
fi
if [[ ! "$XPOD_IMAGE" =~ ^ghcr\.io/undefinedsco/xpod@sha256:[0-9a-f]{64}$ ]]; then
  echo 'XPOD_IMAGE must be an immutable digest reference resolved from a sha-[0-9a-f] tag' >&2
  exit 64
fi

k() {
  kubectl -n "$NAMESPACE" "$@"
}

postgres_exec() {
  local pod="$1"
  shift
  k exec -i "$pod" -- bash -euo pipefail -c \
    'export PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB" PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"' bash "$@"
}

secret_url() {
  local secret="$1"
  local key="$2"
  local encoded
  encoded="$(k get secret "$secret" -o "jsonpath={.data.${key}}")"
  [[ -n "$encoded" ]] || return 1
  printf '%s' "$encoded" | base64 --decode
}

url_authority() {
  DATABASE_URL="$1" node - <<'NODE'
const url = new URL(process.env.DATABASE_URL);
process.stdout.write(`${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`);
NODE
}

url_database() {
  DATABASE_URL="$1" node - <<'NODE'
const url = new URL(process.env.DATABASE_URL);
const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!database || database.includes('/')) process.exit(64);
process.stdout.write(database);
NODE
}

rewrite_database_url() {
  DATABASE_URL="$1" DATABASE_HOST="$NEW_POSTGRES_SERVICE.$NAMESPACE.svc.cluster.local" node - <<'NODE'
const url = new URL(process.env.DATABASE_URL);
url.hostname = process.env.DATABASE_HOST;
url.port = '5432';
process.stdout.write(url.toString());
NODE
}

patch_secret_url() {
  local secret="$1"
  local key="$2"
  local current rewritten encoded
  current="$(secret_url "$secret" "$key" 2>/dev/null || true)"
  [[ -n "$current" ]] || return 1
  [[ "$(url_authority "$current")" == "$OLD_AUTHORITY" ]] || return 1
  rewritten="$(rewrite_database_url "$current")"
  encoded="$(printf '%s' "$rewritten" | base64 | tr -d '\n')"
  k patch secret "$secret" --type=json \
    -p "[{\"op\":\"replace\",\"path\":\"/data/$key\",\"value\":\"$encoded\"}]" >/dev/null
}

query_counts() {
  local pod="$1"
  local database="${2:-}"
  local -a args=(-At -F $'\t')
  if [[ -n "$database" ]]; then
    args+=(-d "$database")
  fi
  postgres_exec "$pod" psql "${args[@]}" <<'SQL'
SELECT name, CASE WHEN to_regclass('public.' || name) IS NULL THEN -1
                  ELSE (xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM %I', name), false, true, '')))[1]::text::bigint
             END
FROM unnest(ARRAY['rdf_terms','rdf_quads','rdf_sources']) AS name
ORDER BY name;
SQL
}

query_public_table_counts() {
  local pod="$1"
  local database="${2:-}"
  local -a args=(-At -F $'\t')
  if [[ -n "$database" ]]; then
    args+=(-d "$database")
  fi
  postgres_exec "$pod" psql "${args[@]}" <<'SQL'
SELECT table_name,
       (xpath('/row/count/text()', query_to_xml(
         format('SELECT count(*) AS count FROM public.%I', table_name), false, true, '')))[1]::text::bigint
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
SQL
}

for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k get deployment "$deployment" >/dev/null
done
k get statefulset "$OLD_POSTGRES_STS" >/dev/null
k get service "$OLD_POSTGRES_SERVICE" >/dev/null
k get pod "$OLD_POSTGRES_STS-0" >/dev/null

cloud_rdf_url="$(secret_url xpod-cloud-secret CSS_SPARQL_ENDPOINT)"
cloud_identity_url="$(secret_url xpod-cloud-secret CSS_IDENTITY_DB_URL)"
OLD_AUTHORITY="$(url_authority "$cloud_rdf_url")"
readonly OLD_AUTHORITY
TARGET_DATABASE="$(url_database "$cloud_rdf_url")"
readonly TARGET_DATABASE
if [[ "$TARGET_DATABASE" == postgres || "$TARGET_DATABASE" == template0 || "$TARGET_DATABASE" == template1 ]]; then
  echo 'The production authority must use a dedicated application database, not a PostgreSQL system database' >&2
  exit 1
fi
if [[ "$OLD_AUTHORITY" != "$(url_authority "$cloud_identity_url")" ]]; then
  echo 'The two authority URLs must refer to the same database' >&2
  exit 1
fi
for secret in "${XPOD_SECRETS[@]}"; do
  k get secret "$secret" >/dev/null
  rdf_url="$(secret_url "$secret" CSS_SPARQL_ENDPOINT)"
  identity_url="$(secret_url "$secret" CSS_IDENTITY_DB_URL)"
  if [[ "$(url_authority "$rdf_url")" != "$OLD_AUTHORITY" ||
        "$(url_authority "$identity_url")" != "$OLD_AUTHORITY" ]]; then
    echo "$secret does not use the expected RDF/identity authority database" >&2
    exit 1
  fi
done

old_version="$(postgres_exec "$OLD_POSTGRES_STS-0" psql -Atc 'SHOW server_version_num')"
if [[ "$TARGET_DATABASE" != "$(postgres_exec "$OLD_POSTGRES_STS-0" psql -Atc 'SELECT current_database()')" ]]; then
  echo 'The application URL database does not match the source dump database' >&2
  exit 1
fi
if (( old_version < 160000 || old_version >= 170000 )); then
  echo "Expected the rollback database to be PostgreSQL 16, got $old_version" >&2
  exit 1
fi
old_counts="$(query_counts "$OLD_POSTGRES_STS-0")"

if [[ "$MODE" == preflight ]]; then
  echo 'Preflight passed: both deployments share one PostgreSQL 16 authority and immutable images were supplied.'
  exit 0
fi

scratch="$(mktemp -d "${RUNNER_TEMP:-/tmp}/xpod-qlever-cutover.XXXXXX")"
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k get deployment "$deployment" -o json > "$scratch/$deployment.deployment.json"
  k get deployment "$deployment" -o jsonpath='{.spec.replicas}' > "$scratch/$deployment.replicas"
done
for secret in "${XPOD_SECRETS[@]}"; do
  k get secret "$secret" -o json > "$scratch/$secret.json"
done

restore_before_start=true
restore_frozen_state() {
  local exit_code=$?
  if (( exit_code == 0 )); then
    return
  fi
  if [[ "$restore_before_start" == true ]]; then
    for secret in "${XPOD_SECRETS[@]}"; do
      original_data="$(jq -c '{data:.data}' "$scratch/$secret.json")"
      k patch secret "$secret" --type=merge -p "$original_data" >/dev/null || true
    done
    for deployment in "${XPOD_DEPLOYMENTS[@]}"; do
      original_container="$(jq -r '.spec.template.spec.containers[0].name' "$scratch/$deployment.deployment.json")"
      original_image="$(jq -r '.spec.template.spec.containers[0].image' "$scratch/$deployment.deployment.json")"
      kubectl set image -n "$NAMESPACE" "deployment/$deployment" \
        "$original_container=$original_image" >/dev/null || true
    done
    for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
      k scale "deployment/$deployment" --replicas="$(cat "$scratch/$deployment.replicas")" >/dev/null || true
    done
  else
    echo 'Cutover validation failed after PG17 accepted writes; applications were frozen and automatic PG16 rollback was refused.' >&2
    for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
      k scale --replicas=0 "deployment/$deployment" >/dev/null || true
    done
  fi
  exit "$exit_code"
}
trap restore_frozen_state ERR

# Derive the PG17 resources from the live PG16 shape. Only identity, image and
# storage size change; the old StatefulSet and PVC remain untouched.
k get service "$OLD_POSTGRES_SERVICE" -o json |
  jq --arg name "$NEW_POSTGRES_SERVICE" '
    del(.metadata.annotations,.metadata.creationTimestamp,.metadata.resourceVersion,.metadata.uid,.metadata.managedFields,.status,
        .spec.clusterIP,.spec.clusterIPs,.spec.ipFamilies,.spec.ipFamilyPolicy,.spec.healthCheckNodePort) |
    .metadata.name=$name |
    .metadata.labels.app=$name |
    .spec.selector.app=$name
  ' | k apply -f - >/dev/null

k get statefulset "$OLD_POSTGRES_STS" -o json |
  jq --arg name "$NEW_POSTGRES_STS" --arg service "$NEW_POSTGRES_SERVICE" --arg image "$POSTGRES_IMAGE" '
    del(.metadata.annotations,.metadata.creationTimestamp,.metadata.generation,.metadata.resourceVersion,.metadata.uid,.metadata.managedFields,.status) |
    .metadata.name=$name |
    .metadata.labels.app=$name |
    .spec.serviceName=$service |
    .spec.selector.matchLabels.app=$name |
    .spec.template.metadata.labels.app=$name |
    .spec.template.spec.containers[0].image=$image |
    .spec.template.spec.containers[0].env=((.spec.template.spec.containers[0].env // []) |
      map(select(.name!="POSTGRES_DB")) + [{"name":"POSTGRES_DB","value":"xpod_bootstrap"}]) |
    .spec.volumeClaimTemplates[].spec.resources.requests.storage="20Gi"
  ' | k apply -f - >/dev/null
k rollout status "statefulset/$NEW_POSTGRES_STS" --timeout=900s

for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k scale --replicas=0 "deployment/$deployment"
done
for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  for attempt in $(seq 1 60); do
    replicas="$(k get deployment "$deployment" -o jsonpath='{.status.replicas}')"
    matching_pods="$(k get pods -l "app=$deployment" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "${replicas:-0}" == 0 && "$matching_pods" == 0 ]]; then
      break
    fi
    if (( attempt == 60 )); then
      echo "$deployment did not fully quiesce" >&2
      exit 1
    fi
    sleep 2
  done
done
for attempt in $(seq 1 60); do
  active_clients="$(postgres_exec "$OLD_POSTGRES_STS-0" psql -Atc \
    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")"
  if [[ "$active_clients" == 0 ]]; then
    break
  fi
  if (( attempt == 60 )); then
    echo "Source PostgreSQL still has $active_clients active client connections" >&2
    exit 1
  fi
  sleep 2
done

old_counts="$(query_counts "$OLD_POSTGRES_STS-0")"
old_public_counts="$(query_public_table_counts "$OLD_POSTGRES_STS-0")"

postgres_exec "$OLD_POSTGRES_STS-0" pg_dump \
  --format=custom --no-owner --no-privileges > "$scratch/xpod-cloud.dump"
target_exists="$(postgres_exec "$NEW_POSTGRES_STS-0" psql -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname = :'target'" --set="target=$TARGET_DATABASE")"
if [[ "$target_exists" != 0 ]]; then
  echo 'The PG17 target database must not exist before restore' >&2
  exit 1
fi
postgres_exec "$NEW_POSTGRES_STS-0" createdb --maintenance-db=postgres "$TARGET_DATABASE"
postgres_exec "$NEW_POSTGRES_STS-0" pg_restore -d "$TARGET_DATABASE" \
  --no-owner --no-privileges --exit-on-error < "$scratch/xpod-cloud.dump"
new_public_counts="$(query_public_table_counts "$NEW_POSTGRES_STS-0" "$TARGET_DATABASE")"
if [[ "$old_public_counts" != "$new_public_counts" ]]; then
  echo 'Public table inventory or row counts differ immediately after restore' >&2
  exit 1
fi

postgres_exec "$NEW_POSTGRES_STS-0" psql -d "$TARGET_DATABASE" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS xpod_rdf;
CREATE EXTENSION IF NOT EXISTS xpod_qlever;
SQL
for index_sql in \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS rdf_quads_spog_perm ON rdf_quads USING btree (subject_id, predicate_id, object_id, graph_id)' \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS rdf_quads_sopg_perm ON rdf_quads USING btree (subject_id, object_id, predicate_id, graph_id)' \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS rdf_quads_psog_perm ON rdf_quads USING btree (predicate_id, subject_id, object_id, graph_id)' \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS rdf_quads_posg_perm ON rdf_quads USING btree (predicate_id, object_id, subject_id, graph_id)' \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS rdf_quads_ospg_perm ON rdf_quads USING btree (object_id, subject_id, predicate_id, graph_id)' \
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS rdf_quads_opsg_perm ON rdf_quads USING btree (object_id, predicate_id, subject_id, graph_id)'; do
  postgres_exec "$NEW_POSTGRES_STS-0" psql -d "$TARGET_DATABASE" -v ON_ERROR_STOP=1 -c "$index_sql" >/dev/null
done
postgres_exec "$NEW_POSTGRES_STS-0" psql -d "$TARGET_DATABASE" -v ON_ERROR_STOP=1 <<'SQL'
SELECT xpod_qlever_refresh_statistics();
SELECT xpod_qlever_prepare_physical_schema();
SELECT xpod_rdf.validate_statistics();
SQL

new_version="$(postgres_exec "$NEW_POSTGRES_STS-0" psql -Atc 'SHOW server_version_num')"
if (( new_version < 170000 || new_version >= 180000 )); then
  echo "Expected PostgreSQL 17, got $new_version" >&2
  exit 1
fi
new_counts="$(query_counts "$NEW_POSTGRES_STS-0" "$TARGET_DATABASE")"
if [[ "$old_counts" != "$new_counts" ]]; then
  echo 'Critical RDF row counts differ after restore' >&2
  exit 1
fi

NEW_AUTHORITY="$(url_authority "$(rewrite_database_url "$cloud_rdf_url")")"
readonly NEW_AUTHORITY
for secret in "${XPOD_SECRETS[@]}"; do
  patched=0
  for key in CSS_SPARQL_ENDPOINT SPARQL_ENDPOINT CSS_IDENTITY_DB_URL DATABASE_URL; do
    if patch_secret_url "$secret" "$key"; then
      patched=$((patched + 1))
    fi
  done
  if (( patched < 2 )); then
    echo "$secret did not expose both RDF and identity database URLs" >&2
    exit 1
  fi
  patched_rdf_authority="$(url_authority "$(secret_url "$secret" CSS_SPARQL_ENDPOINT)")"
  patched_identity_authority="$(url_authority "$(secret_url "$secret" CSS_IDENTITY_DB_URL)")"
  if [[ "$patched_rdf_authority" != "$NEW_AUTHORITY" ||
        "$patched_identity_authority" != "$NEW_AUTHORITY" ]]; then
    echo "$secret mandatory database URLs did not move to PG17" >&2
    exit 1
  fi
done

for deployment in "${XPOD_DEPLOYMENTS[@]}"; do
  container="$(k get deployment "$deployment" -o jsonpath='{.spec.template.spec.containers[0].name}')"
  kubectl set image -n "$NAMESPACE" "deployment/$deployment" "$container=$XPOD_IMAGE" >/dev/null
done

# From this point the new authority may receive writes. Never automatically
# point the applications back at PG16 after a validation failure.
restore_before_start=false
for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k scale "deployment/$deployment" --replicas="$(cat "$scratch/$deployment.replicas")" >/dev/null
done
for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k rollout status "deployment/$deployment" --timeout=900s
done

for attempt in $(seq 1 24); do
  if payload="$(curl --fail --silent --show-error --max-time 10 https://id.undefineds.co/service/status)" &&
    jq -e 'length == 2 and ((map(.name) | sort) == ["api", "css"]) and all(.status == "running")' <<< "$payload" >/dev/null; then
    healthy=true
    break
  fi
  sleep 5
done
if [[ "${healthy:-false}" != true ]]; then
  echo 'Public Xpod service did not become healthy' >&2
  exit 1
fi

postgres_exec "$NEW_POSTGRES_STS-0" psql -d "$TARGET_DATABASE" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  capabilities jsonb;
  version_info jsonb;
  probe jsonb;
  rdf_extension_version text;
  qlever_extension_version text;
BEGIN
  SELECT extversion INTO rdf_extension_version FROM pg_extension WHERE extname = 'xpod_rdf';
  SELECT extversion INTO qlever_extension_version FROM pg_extension WHERE extname = 'xpod_qlever';
  IF rdf_extension_version IS DISTINCT FROM '0.2.0' OR
     qlever_extension_version IS DISTINCT FROM '0.4.0' THEN
    RAISE EXCEPTION 'Unexpected RDF extension versions: %, %', rdf_extension_version, qlever_extension_version;
  END IF;
  version_info := xpod_qlever_version();
  IF version_info->>'mode' IS DISTINCT FROM 'postgres-extension' OR
     version_info->>'qleverRuntime' IS DISTINCT FROM 'linked' OR
     version_info->>'physicalBackend' IS DISTINCT FROM 'postgres-internal' THEN
    RAISE EXCEPTION 'Unexpected QLever runtime metadata: %', version_info;
  END IF;
  capabilities := xpod_rdf.native_sparql_capabilities();
  IF (capabilities->>'abiVersion')::integer IS DISTINCT FROM 1 OR
     (capabilities->>'ready')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Native RDF runtime is not ready: %', capabilities;
  END IF;
  probe := xpod_rdf.native_sparql_query(
    'ASK WHERE {}',
    jsonb_build_object('principal', 'cutover-smoke', 'allowedGraphUrls', jsonb_build_array()));
  IF probe->>'status' IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'Native QLever smoke failed: %', probe;
  END IF;
END
$$;
SELECT xpod_rdf.validate_statistics();
DO $$
BEGIN
  IF to_regclass('public.derived_index_change_journal') IS NULL OR
     to_regclass('public.rdf_text_fts_pg') IS NULL OR
     to_regclass('public.rdf_vector_chunks') IS NULL THEN
    RAISE EXCEPTION 'FTS/VEC durable synchronization tables are incomplete';
  END IF;
END
$$;
SQL

trap - ERR
echo 'QLever production cutover passed; PostgreSQL 16 and its PVC remain disconnected and available as a rollback point.'
