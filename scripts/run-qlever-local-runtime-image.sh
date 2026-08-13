#!/usr/bin/env bash
set -euo pipefail

image="${XPOD_QLEVER_SQLITE_RUNTIME_IMAGE:?XPOD_QLEVER_SQLITE_RUNTIME_IMAGE is required}"

if [[ "${1:-}" != "--sqlite-path" || -z "${2:-}" || "${3:-}" != "" ]]; then
  echo 'usage: run-qlever-local-runtime-image.sh --sqlite-path PATH' >&2
  exit 64
fi

database_dir="$(cd -- "$(dirname -- "$2")" && pwd)"
database_name="$(basename -- "$2")"
database_path="${database_dir}/${database_name}"
test -f "${database_path}"

container_name="xpod-qlever-local-runtime-${$}-${RANDOM}"

cleanup() {
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

docker rm -f "${container_name}" >/dev/null 2>&1 || true
docker run -i \
  --name "${container_name}" \
  --mount "type=bind,src=${database_dir},dst=/data" \
  "${image}" \
  --sqlite-path "/data/${database_name}"
