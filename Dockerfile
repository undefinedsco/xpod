# syntax=docker/dockerfile:1.7

# Xpod Docker Image
#
# 通过环境变量控制运行模式:
#   XPOD_EDITION=cloud|local
#   CSS_PORT=6300 (cloud) / 5737 (local)
#   API_PORT=6301 (cloud) / 5738 (local)
#

ARG XPOD_QLEVER_LOCAL_RUNTIME_IMAGE
FROM ${XPOD_QLEVER_LOCAL_RUNTIME_IMAGE} AS qlever-local-runtime
ARG XPOD_QLEVER_LOCAL_RUNTIME_IMAGE
RUN printf '%s' "${XPOD_QLEVER_LOCAL_RUNTIME_IMAGE}" \
    | grep -Eq '^.+@sha256:[0-9a-f]{64}$' \
 || { echo "XPOD_QLEVER_LOCAL_RUNTIME_IMAGE must be an immutable @sha256 image reference" >&2; exit 64; } \
 && test -x /opt/xpod/qlever/bin/xpod_qlever_local_runtime

FROM oven/bun:1.4.2 AS bun

FROM node:22-bookworm AS build

# The Xpod application image is TypeScript/Bun. PostgreSQL-native search
# acceleration, including pgvector or xpod_rdf/QLever-style extensions, is
# provided by the database/runtime image and consumed here only through SQL.
# Do not install CMake or QLever build tooling in the main service image for
# those. This build base currently supplies node-gyp prerequisites for the
# optional terminal dependency node-pty, which has no linux-arm64 prebuild; the
# runtime stage below is Bun-based and does not contain this build toolchain.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx
ENV NODE_ENV=development

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY ui/package.json ./ui/package.json
COPY desktop/package.json ./desktop/package.json
COPY packages ./packages
COPY scripts/patch-jose.js ./scripts/patch-jose.js
COPY scripts/patch-inrupt-authn-refresh.js ./scripts/patch-inrupt-authn-refresh.js
COPY scripts/patch-inrupt-authn-transport.js ./scripts/patch-inrupt-authn-transport.js
COPY scripts/patch-inrupt-authn-operation-cleanup.js ./scripts/patch-inrupt-authn-operation-cleanup.js
# Workaround: 禁用 SSL 验证以绕过代理 HTTPS 握手问题
# 详见: docs/docker-build-troubleshooting.md
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 bun install --frozen-lockfile

COPY . .
ARG XPOD_SOURCE_SHA
RUN if [ -z "${XPOD_SOURCE_SHA}" ]; then bun run build:packages && bun run build:ts && bun run build:components && bun scripts/check-components-runtime-metadata.cjs && bun run build:ui; fi
# Explicit provenance builds use the bounded parent. Local builds keep the
# existing pack recipe and do not claim retained pack provenance.
RUN if [ -n "${XPOD_SOURCE_SHA}" ]; then \
      python3 scripts/service-pack-parent.py --source-sha "${XPOD_SOURCE_SHA}" --include-build; \
    else \
      node scripts/run-npm-pack.cjs .test-data/service-pack .test-data/service-pack-cache service; \
    fi \
 && mkdir /service \
 && tar -xzf .test-data/service-pack/*.tgz -C /service --strip-components=1 \
 && cd /service && bun install --production --ignore-scripts \
 && node -e "for (const name of ['refresh','transport','operation-cleanup']) require('/app/scripts/patch-inrupt-authn-' + name + '.js').patchInstalledPackage('/service', {runtimeOnly:true}); require('/app/scripts/patch-jose.js').patchInstalledPackages('/service')" \
 && bun /app/scripts/check-dependency-state.ts --dependency-root /service --runtime-only \
 && if [ -n "${XPOD_SOURCE_SHA}" ]; then \
      mkdir -p /service/provenance \
      && cp -a /app/.test-data/service-pack-originals /app/.test-data/service-pack-bodies /app/.test-data/service-pack-phase /service/provenance/; \
    fi \
 && rm -rf /service/runtime-packages

FROM node:22-bookworm-slim AS node-runtime

# Runtime. Use the immutable QLever runtime image as the native ABI authority;
# Node and Bun are copied in without replacing its native dependency set.
FROM qlever-local-runtime AS runtime

COPY --from=node-runtime /usr/local /usr/local
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx

LABEL org.opencontainers.image.source="https://github.com/undefinedsco/xpod"
LABEL org.opencontainers.image.description="Xpod - Solid Pod Server"
LABEL org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl bubblewrap procps \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=build /service ./

RUN mkdir -p /app/data /app/logs \
 && mkdir -p /app/node_modules/@undefineds.co \
 && ln -s /app /app/node_modules/@undefineds.co/xpod \
 && test -x /opt/xpod/qlever/bin/xpod_qlever_local_runtime

ENV NODE_ENV=production
ENV XPOD_EDITION=local
ENV CSS_PORT=5737
ENV API_PORT=5738
ENV XPOD_QLEVER_LOCAL_RUNTIME_COMMAND=/opt/xpod/qlever/bin/xpod_qlever_local_runtime

EXPOSE 5737 5738 6300 6301

ENTRYPOINT []
CMD ["sh", "-c", "bun --no-env-file dist/runtime/service-entry.js start --mode ${XPOD_EDITION} --port ${CSS_PORT} --host 0.0.0.0"]
