# Xpod Docker Image
#
# 通过环境变量控制运行模式:
#   CSS_EDITION=cloud|local
#   CSS_PORT=6300 (cloud) / 5737 (local)
#   API_PORT=6301 (cloud) / 5738 (local)
#

FROM node:22-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-engines

COPY . .
RUN yarn build:ts && yarn build:components

# Runtime
FROM node:22-alpine

RUN apk add --no-cache curl
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/config ./config
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/static ./static
COPY --from=build /app/templates ./templates

RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production
ENV CSS_EDITION=local
ENV CSS_PORT=5737
ENV API_PORT=5738

EXPOSE 5737 5738 6300 6301

CMD ["sh", "-c", "node dist/main.js -c config/${CSS_EDITION}.json -p ${CSS_PORT}"]
