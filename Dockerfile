# Xpod Docker Image
#
# 通过环境变量控制运行模式:
#   XPOD_EDITION=cloud|local
#   CSS_PORT=6300 (cloud) / 5737 (local)
#   API_PORT=6301 (cloud) / 5738 (local)
#

FROM oven/bun:1.3.13 AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ cmake \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=development

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY ui/package.json ./ui/package.json
COPY packages ./packages
COPY scripts/patch-jose.js ./scripts/patch-jose.js
# Workaround: 禁用 SSL 验证以绕过代理 HTTPS 握手问题
# 详见: docs/docker-build-troubleshooting.md
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 bun install --frozen-lockfile

COPY . .
RUN bun run build:ts && bun run build:components && node scripts/check-components-runtime-metadata.cjs && bun run build:packages && bun run build:ui

# Runtime
FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/undefinedsco/xpod"
LABEL org.opencontainers.image.description="Xpod - Solid Pod Server"
LABEL org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache curl bubblewrap
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/config ./config
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/static ./static
COPY --from=build /app/templates ./templates

RUN mkdir -p /app/data /app/logs \
 && mkdir -p /app/node_modules/@undefineds.co \
 && ln -s /app /app/node_modules/@undefineds.co/xpod

ENV NODE_ENV=production
ENV XPOD_EDITION=local
ENV CSS_PORT=5737
ENV API_PORT=5738

EXPOSE 5737 5738 6300 6301

CMD ["sh", "-c", "node dist/main.js -c config/${XPOD_EDITION}.json -p ${CSS_PORT}"]
