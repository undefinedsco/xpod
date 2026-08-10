#!/usr/bin/env bash
set -euo pipefail

readonly MODE="${1:-preflight}"
readonly NAMESPACE="${SEALOS_NAMESPACE:?SEALOS_NAMESPACE is required}"
readonly POSTGRES_IMAGE="${XPOD_POSTGRES_IMAGE:?XPOD_POSTGRES_IMAGE is required}"
readonly XPOD_IMAGE="${XPOD_IMAGE:?XPOD_IMAGE is required}"
readonly IMAGE_PULL_SECRET="${XPOD_IMAGE_PULL_SECRET:?XPOD_IMAGE_PULL_SECRET is required}"
readonly SOURCE_POSTGRES_STS="${XPOD_SOURCE_POSTGRES_STS:-postgres}"
readonly SOURCE_POSTGRES_SERVICE="${XPOD_SOURCE_POSTGRES_SERVICE:-postgres}"
readonly TARGET_POSTGRES_STS="${XPOD_TARGET_POSTGRES_STS:-xpod-rdf-postgres}"
readonly TARGET_POSTGRES_SERVICE="${XPOD_TARGET_POSTGRES_SERVICE:-xpod-rdf-postgres}"
readonly XPOD_DEPLOYMENTS=(xpod-cloud xpod-rc)
readonly WRITER_DEPLOYMENTS=(xpod-cloud xpod-rc xpod-inngest)
readonly XPOD_SECRETS=(xpod-cloud-secret xpod-rc-secret)

if [[ "$MODE" != preflight && "$MODE" != cutover ]]; then
  echo "Usage: $0 <preflight|cutover>" >&2
  exit 64
fi
readonly IMMUTABLE_IMAGE_PATTERN='^[a-zA-Z0-9][a-zA-Z0-9._:-]*/[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}$'
for image in "$POSTGRES_IMAGE" "$XPOD_IMAGE"; do
  if [[ ! "$image" =~ $IMMUTABLE_IMAGE_PATTERN ]]; then
    echo "$image must be an immutable registry/repository@sha256 digest reference" >&2
    exit 64
  fi
done

k() {
  kubectl -n "$NAMESPACE" "$@"
}

postgres_exec() {
  local pod="$1"
  shift
  k exec "$pod" -- bash -euo pipefail -c \
    'export PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB" PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"' bash "$@"
}

postgres_exec_stdin() {
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

url_server() {
  DATABASE_URL="$1" node - <<'NODE'
const url = new URL(process.env.DATABASE_URL);
process.stdout.write(`${url.hostname.toLowerCase()}:${url.port || '5432'}`);
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
  DATABASE_URL="$1" DATABASE_HOST="$TARGET_POSTGRES_SERVICE.$NAMESPACE.svc.cluster.local" node - <<'NODE'
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
  [[ "$(url_server "$current")" == "$SOURCE_SERVER" ]] || return 1
  rewritten="$(rewrite_database_url "$current")"
  encoded="$(printf '%s' "$rewritten" | base64 | tr -d '\n')"
  k patch secret "$secret" --type=json \
    -p "[{\"op\":\"replace\",\"path\":\"/data/$key\",\"value\":\"$encoded\"}]" >/dev/null
}

for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k get deployment "$deployment" >/dev/null
done
k get statefulset "$SOURCE_POSTGRES_STS" >/dev/null
k get service "$SOURCE_POSTGRES_SERVICE" >/dev/null
k get secret "$IMAGE_PULL_SECRET" >/dev/null

cloud_rdf_url="$(secret_url xpod-cloud-secret CSS_SPARQL_ENDPOINT)"
cloud_identity_url="$(secret_url xpod-cloud-secret CSS_IDENTITY_DB_URL)"
SOURCE_SERVER="$(url_server "$cloud_rdf_url")"
readonly SOURCE_SERVER
REQUIRED_DATABASES=("$(url_database "$cloud_rdf_url")")
for secret in "${XPOD_SECRETS[@]}"; do
  k get secret "$secret" >/dev/null
  rdf_url="$(secret_url "$secret" CSS_SPARQL_ENDPOINT)"
  identity_url="$(secret_url "$secret" CSS_IDENTITY_DB_URL)"
  rdf_database="$(url_database "$rdf_url")"
  identity_database="$(url_database "$identity_url")"
  if [[ "$(url_server "$rdf_url")" != "$SOURCE_SERVER" ||
        "$(url_server "$identity_url")" != "$SOURCE_SERVER" ]]; then
    echo "$secret does not use the expected PostgreSQL server" >&2
    exit 1
  fi
  if [[ "$rdf_database" != "$identity_database" ]]; then
    echo "$secret RDF and identity URLs must use the same database" >&2
    exit 1
  fi
  if [[ "$rdf_database" == postgres || "$rdf_database" == template0 ||
        "$rdf_database" == template1 ]]; then
    echo "$secret must use a dedicated application database" >&2
    exit 1
  fi
  present=false
  for database in "${REQUIRED_DATABASES[@]}"; do
    [[ "$database" == "$rdf_database" ]] && present=true
  done
  [[ "$present" == true ]] || REQUIRED_DATABASES+=("$rdf_database")
done
if k get statefulset "$TARGET_POSTGRES_STS" >/dev/null 2>&1 ||
   k get service "$TARGET_POSTGRES_SERVICE" >/dev/null 2>&1; then
  echo 'The fresh PG17 target resources already exist' >&2
  exit 1
fi

if [[ "$MODE" == preflight ]]; then
  echo 'Preflight passed: production inputs are consistent and immutable images were supplied.'
  exit 0
fi

scratch="$(mktemp -d "${RUNNER_TEMP:-/tmp}/xpod-qlever-cutover.XXXXXX")"
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT
for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k get deployment "$deployment" -o jsonpath='{.spec.replicas}' > "$scratch/$deployment.replicas"
done

k get service "$SOURCE_POSTGRES_SERVICE" -o json |
  jq --arg name "$TARGET_POSTGRES_SERVICE" '
    del(.metadata.annotations,.metadata.creationTimestamp,.metadata.resourceVersion,.metadata.uid,.metadata.managedFields,.status,
        .spec.clusterIP,.spec.clusterIPs,.spec.ipFamilies,.spec.ipFamilyPolicy,.spec.healthCheckNodePort) |
    .metadata.name=$name |
    .metadata.labels.app=$name |
    .spec.selector.app=$name
  ' | k apply -f - >/dev/null

k get statefulset "$SOURCE_POSTGRES_STS" -o json |
  jq --arg name "$TARGET_POSTGRES_STS" --arg service "$TARGET_POSTGRES_SERVICE" \
     --arg image "$POSTGRES_IMAGE" --arg pullSecret "$IMAGE_PULL_SECRET" '
    del(.metadata.annotations,.metadata.creationTimestamp,.metadata.generation,.metadata.resourceVersion,.metadata.uid,.metadata.managedFields,.status) |
    .metadata.name=$name |
    .metadata.labels.app=$name |
    .spec.serviceName=$service |
    .spec.selector.matchLabels.app=$name |
    .spec.template.metadata.labels.app=$name |
    .spec.template.spec.containers[0].image=$image |
    .spec.template.spec.imagePullSecrets=[{"name":$pullSecret}] |
    .spec.volumeClaimTemplates[].spec.resources.requests.storage="20Gi"
  ' | k apply -f - >/dev/null
k rollout status "statefulset/$TARGET_POSTGRES_STS" --timeout=900s

target_version="$(postgres_exec "$TARGET_POSTGRES_STS-0" psql -d postgres -Atc 'SHOW server_version_num')"
if (( target_version < 170000 || target_version >= 180000 )); then
  echo "Expected PostgreSQL 17, got $target_version" >&2
  exit 1
fi
for database in "${REQUIRED_DATABASES[@]}"; do
  database_exists="$(printf '%s\n' "SELECT count(*) FROM pg_database WHERE datname = :'database';" |
    postgres_exec_stdin "$TARGET_POSTGRES_STS-0" psql -d postgres -At --set="database=$database")"
  if [[ "$database_exists" == 0 ]]; then
    postgres_exec "$TARGET_POSTGRES_STS-0" createdb --maintenance-db=postgres "$database"
  fi
  postgres_exec_stdin "$TARGET_POSTGRES_STS-0" psql -d "$database" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS xpod_rdf;
CREATE EXTENSION IF NOT EXISTS xpod_qlever;
SQL
done

for deployment in "${WRITER_DEPLOYMENTS[@]}"; do
  k scale "deployment/$deployment" --replicas=0
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
done
for deployment in "${XPOD_DEPLOYMENTS[@]}"; do
  container="$(k get deployment "$deployment" -o jsonpath='{.spec.template.spec.containers[0].name}')"
  k patch deployment "$deployment" --type=merge \
    -p "{\"spec\":{\"template\":{\"spec\":{\"imagePullSecrets\":[{\"name\":\"$IMAGE_PULL_SECRET\"}]}}}}" >/dev/null
  kubectl set image -n "$NAMESPACE" "deployment/$deployment" "$container=$XPOD_IMAGE" >/dev/null
done
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

for database in "${REQUIRED_DATABASES[@]}"; do
postgres_exec_stdin "$TARGET_POSTGRES_STS-0" psql -d "$database" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  capabilities jsonb;
  version_info jsonb;
  probe jsonb;
BEGIN
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
    jsonb_build_object(
      'graphPrefix', 'https://id.undefineds.co/',
      'authorizationModel', 'mixed',
      'principal', 'cutover-smoke',
      'accessScopeResolved', true,
      'allowedGraphUrls', jsonb_build_array()));
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
done

k delete statefulset "$SOURCE_POSTGRES_STS" --wait=true
k delete service "$SOURCE_POSTGRES_SERVICE" --wait=true
k delete pvc -l "app=$SOURCE_POSTGRES_STS" --wait=true
echo 'QLever production cutover passed; the superseded PostgreSQL service and data were removed.'
