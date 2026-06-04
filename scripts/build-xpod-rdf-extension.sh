#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT/native/postgres/xpod_rdf"
IMAGE="${XPOD_RDF_EXTENSION_BUILD_IMAGE:-postgres:17-bookworm}"
HTTP_PROXY_VALUE="${XPOD_DOCKER_HTTP_PROXY:-${http_proxy:-}}"
HTTPS_PROXY_VALUE="${XPOD_DOCKER_HTTPS_PROXY:-${https_proxy:-$HTTP_PROXY_VALUE}}"

DOCKER_ENV=()
if [[ -n "$HTTP_PROXY_VALUE" ]]; then
  DOCKER_ENV+=(--env "http_proxy=$HTTP_PROXY_VALUE" --env "HTTP_PROXY=$HTTP_PROXY_VALUE")
fi
if [[ -n "$HTTPS_PROXY_VALUE" ]]; then
  DOCKER_ENV+=(--env "https_proxy=$HTTPS_PROXY_VALUE" --env "HTTPS_PROXY=$HTTPS_PROXY_VALUE")
fi

docker run --rm \
  ${DOCKER_ENV[@]+"${DOCKER_ENV[@]}"} \
  -v "$EXT_DIR:/workspace/xpod_rdf" \
  -w /workspace/xpod_rdf \
  --user root \
  "$IMAGE" \
  sh -lc '
    set -eu
    if command -v apt-get >/dev/null 2>&1; then
      PG_CONFIG_PATH="${PG_CONFIG:-pg_config}"
      INCLUDE_DIR="$("$PG_CONFIG_PATH" --includedir-server 2>/dev/null || true)"
      PGXS_PATH="$("$PG_CONFIG_PATH" --pgxs 2>/dev/null || true)"
      echo "[xpod_rdf] apt-get update"
      apt-get update
      if [ -f "$INCLUDE_DIR/postgres.h" ] && [ -n "$PGXS_PATH" ] && [ -f "$PGXS_PATH" ]; then
        echo "[xpod_rdf] install build tools"
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential
      else
        echo "[xpod_rdf] install PostgreSQL server headers and build tools"
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-server-dev-17 build-essential
      fi
    elif command -v apk >/dev/null 2>&1; then
      PG_CONFIG_PATH="${PG_CONFIG:-/usr/local/bin/pg_config}"
      INCLUDE_DIR="$("$PG_CONFIG_PATH" --includedir-server 2>/dev/null || true)"
      if [ -f "$INCLUDE_DIR/postgres.h" ]; then
        echo "[xpod_rdf] apk install build tools"
        apk add --no-cache build-base >/tmp/xpod-rdf-apk.log
      else
        echo "[xpod_rdf] apk install PostgreSQL server headers and build tools"
        apk add --no-cache postgresql17-dev build-base >/tmp/xpod-rdf-apk.log
        if [ ! -f "$INCLUDE_DIR/postgres.h" ] && [ -f /usr/include/postgresql/17/server/postgres.h ]; then
          PG_MAJOR=17
          export PG_MAJOR
        fi
        if [ ! -x "$PG_CONFIG_PATH" ] && command -v pg_config >/dev/null 2>&1; then
          PG_CONFIG_PATH="$(command -v pg_config)"
        fi
      fi
    else
      echo "Unsupported build image: missing apt-get and apk" >&2
      exit 1
    fi
    echo "[xpod_rdf] using PG_CONFIG=$PG_CONFIG_PATH"
    "$PG_CONFIG_PATH" --version
    "$PG_CONFIG_PATH" --includedir-server
    PGXS_PATH="$("$PG_CONFIG_PATH" --pgxs 2>/dev/null || true)"
    if [ -n "$PGXS_PATH" ] && [ -f "$PGXS_PATH" ]; then
      echo "[xpod_rdf] make clean"
      make PG_CONFIG="$PG_CONFIG_PATH" with_llvm=no clean || true
      echo "[xpod_rdf] make"
      make PG_CONFIG="$PG_CONFIG_PATH" with_llvm=no
    else
      echo "[xpod_rdf] PGXS not found; compiling shared object directly"
      INCLUDE_DIR="$("$PG_CONFIG_PATH" --includedir-server)"
      if [ -n "${PG_MAJOR:-}" ] && [ -f "/usr/include/postgresql/$PG_MAJOR/server/postgres.h" ]; then
        INCLUDE_DIR="/usr/include/postgresql/$PG_MAJOR/server"
      elif [ ! -f "$INCLUDE_DIR/postgres.h" ] && [ -f /usr/include/postgresql/17/server/postgres.h ]; then
        INCLUDE_DIR=/usr/include/postgresql/17/server
      fi
      echo "[xpod_rdf] using INCLUDE_DIR=$INCLUDE_DIR"
      rm -f xpod_rdf.o xpod_rdf.so
      cc -Wall -Wextra -fPIC -I"$INCLUDE_DIR" -c xpod_rdf.c -o xpod_rdf.o
      cc -shared -o xpod_rdf.so xpod_rdf.o
    fi
  '
