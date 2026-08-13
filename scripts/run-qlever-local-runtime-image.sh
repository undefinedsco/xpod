#!/usr/bin/env bash
set -euo pipefail

image="${XPOD_QLEVER_SQLITE_RUNTIME_IMAGE:?XPOD_QLEVER_SQLITE_RUNTIME_IMAGE is required}"

if [[ "${1:-}" != "--sqlite-path" || -z "${2:-}" || "${3:-}" != "" ]]; then
  echo 'usage: run-qlever-local-runtime-image.sh --sqlite-path PATH' >&2
  exit 64
fi

database_path="$(cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")"
test -f "${database_path}"

exec docker run --rm -i \
  --mount "type=bind,src=${database_path},dst=/data/runtime.sqlite" \
  "${image}" \
  --sqlite-path /data/runtime.sqlite
