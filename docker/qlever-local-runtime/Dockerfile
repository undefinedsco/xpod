# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG XPOD_QLEVER_PRIOR_SDK_IMAGE
ARG XPOD_QLEVER_RUNTIME_BASE_IMAGE=debian:trixie-20260803-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258
FROM ${XPOD_QLEVER_PRIOR_SDK_IMAGE} AS build

ARG XPOD_QLEVER_PRIOR_SDK_IMAGE
ARG XPOD_QLEVER_BUILD_JOBS=4
ENV DEBIAN_FRONTEND=noninteractive \
    XPOD_QLEVER_SOURCE_DIR=/opt/qlever-sdk/source \
    XPOD_QLEVER_BUILD_DIR=/opt/qlever-sdk/build \
    XPOD_QLEVER_LOCAL_BUILD_DIR=/opt/xpod-qlever-local-runtime/build \
    XPOD_QLEVER_BUILD_OUTPUT_DIR=/opt/xpod \
    XPOD_QLEVER_LOCAL_ARTIFACT_DIR=/opt/xpod/qlever \
    XPOD_QLEVER_WORKSPACE_ROOT=/workspace/xpod

RUN printf '%s' "${XPOD_QLEVER_PRIOR_SDK_IMAGE}" \
    | grep -Eq '^.+@sha256:[0-9a-f]{64}$' \
 || { echo "XPOD_QLEVER_PRIOR_SDK_IMAGE must be an immutable digest reference" >&2; exit 64; }

RUN apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*

COPY qlever/cmake /workspace/xpod/qlever/cmake
COPY qlever/include /workspace/xpod/qlever/include
COPY qlever/qlever.lock.json /workspace/xpod/qlever/qlever.lock.json
COPY qlever/patches /workspace/xpod/qlever/patches
COPY qlever/qlever_adapter /workspace/xpod/qlever/qlever_adapter
COPY qlever/qlever_local_runtime /workspace/xpod/qlever/qlever_local_runtime
COPY qlever/rdf_protocol /workspace/xpod/qlever/rdf_protocol
COPY qlever/rdf_sqlite_backend /workspace/xpod/qlever/rdf_sqlite_backend
COPY qlever/scripts /workspace/xpod/qlever/scripts

RUN bash /workspace/xpod/qlever/scripts/run-focused-native-build.sh \
 && test -f /opt/xpod/qlever/manifest.json \
 && echo XPOD_FOCUSED_BUILD_CACHE_PROBE

FROM ${XPOD_QLEVER_RUNTIME_BASE_IMAGE} AS runtime-base

ARG XPOD_QLEVER_RUNTIME_BASE_IMAGE

RUN printf '%s' "${XPOD_QLEVER_RUNTIME_BASE_IMAGE}" \
    | grep -Eq '^.+@sha256:[0-9a-f]{64}$' \
 || { echo "XPOD_QLEVER_RUNTIME_BASE_IMAGE must be an immutable digest reference" >&2; exit 64; }

RUN apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends \
      libboost-container1.83.0 \
      libboost-iostreams1.83.0 \
      libboost-program-options1.83.0 \
      libboost-url1.83.0 \
      libbz2-1.0 \
      libicu76 \
      liblzma5 \
      libsqlite3-0 \
      libssl3t64 \
      libstdc++6 \
      libzstd1 \
      zlib1g \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/xpod/qlever /opt/xpod/qlever

RUN test -x /opt/xpod/qlever/bin/xpod_qlever_local_runtime \
 && test ! -e /opt/xpod/qlever/lib/libxpod_qlever_adapter.so \
 && test ! -e /opt/xpod/qlever/lib/libxpod_rdf_sqlite_backend.so \
 && ldd /opt/xpod/qlever/bin/xpod_qlever_local_runtime > /tmp/xpod-qlever-ldd.log \
 && if grep -q 'not found' /tmp/xpod-qlever-ldd.log; then \
      cat /tmp/xpod-qlever-ldd.log >&2; \
      exit 64; \
    fi \
 && rm /tmp/xpod-qlever-ldd.log

FROM runtime-base AS runtime-smoke

COPY --from=build /opt/xpod/runtime-smoke.sqlite /tmp/xpod-qlever-runtime-smoke.sqlite

RUN <<'SH'
set -eu
mkfifo /tmp/xpod-qlever-runtime-smoke.in
/opt/xpod/qlever/bin/xpod_qlever_local_runtime \
  --sqlite-path /tmp/xpod-qlever-runtime-smoke.sqlite \
  < /tmp/xpod-qlever-runtime-smoke.in \
  > /tmp/xpod-qlever-runtime-smoke.out \
  2> /tmp/xpod-qlever-runtime-smoke.err &
runtime_pid="$!"
exec 3> /tmp/xpod-qlever-runtime-smoke.in

wait_for_output() {
  pattern="$1"
  for attempt in $(seq 1 50); do
    grep -q "${pattern}" /tmp/xpod-qlever-runtime-smoke.out && return 0
    sleep 0.1
  done
  cat /tmp/xpod-qlever-runtime-smoke.out >&2
  cat /tmp/xpod-qlever-runtime-smoke.err >&2
  return 64
}

wait_for_output '"type":"ready"'
printf '%s\n' '{"id":"fts","type":"query","sparql":"SELECT ?text WHERE { ?text ql:contains-word \"alpha\" }"}' >&3
wait_for_output '"id":"fts"'
grep -q '"status":"ok"' /tmp/xpod-qlever-runtime-smoke.out
grep -q 'alpha card' /tmp/xpod-qlever-runtime-smoke.out
printf '%s\n' '{"id":"vector","type":"query","sparql":"SELECT ?retrieval WHERE { }","options":{"vectorQuery":{"embedding":[1.0,0.0],"provider":"xpod","model":"smoke-model","modelVersion":"2026-08-12","inputKind":"entity-card","projectionPolicyVersion":"policy-v1","metric":"cosine","limit":1,"retrievalPointVariable":"?retrieval"}}}' >&3
wait_for_output '"id":"vector"'
grep -q '"status":"ok"' /tmp/xpod-qlever-runtime-smoke.out
grep -q 'alpha card' /tmp/xpod-qlever-runtime-smoke.out
printf '%s\n' '{"type":"shutdown"}' >&3
exec 3>&-
wait "${runtime_pid}"
SH

FROM runtime-base AS runtime

COPY --from=runtime-smoke /opt/xpod/qlever/manifest.json /opt/xpod/qlever/manifest.json

LABEL org.opencontainers.image.title="Xpod QLever local runtime" \
      org.opencontainers.image.description="Minimal Debian runtime for QLever over the Xpod SQLite physical backend"

WORKDIR /opt/xpod/qlever

ENTRYPOINT ["/opt/xpod/qlever/bin/xpod_qlever_local_runtime"]
