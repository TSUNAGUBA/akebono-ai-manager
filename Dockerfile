# AI マネージャー 共通イメージ(chat-gateway / batch / dashboard / db-migrate)
# 起動コマンドを差し替えて全サービスで同一イメージを使う:
#   chat-gateway: node packages/chat-gateway/dist/index.js (既定)
#   batch:        node packages/batch/dist/index.js
#   dashboard:    node packages/dashboard/dist/index.js
#   db-migrate:   node packages/db/dist/migrate.js

FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/chat-gateway/package.json packages/chat-gateway/
COPY packages/batch/package.json packages/batch/
COPY packages/dashboard/package.json packages/dashboard/

FROM base AS build
RUN npm ci
COPY packages ./packages
RUN npm run build

FROM base AS prod-deps
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
# AWS RDS への SSL 接続用 CA バンドル(要件 6.3: SSL/TLS 必須)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      -o /etc/ssl/rds-global-bundle.pem \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DB_SSL_CA=/etc/ssl/rds-global-bundle.pem

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/chat-gateway/package.json ./packages/chat-gateway/package.json
COPY --from=build /app/packages/chat-gateway/dist ./packages/chat-gateway/dist
COPY --from=build /app/packages/batch/package.json ./packages/batch/package.json
COPY --from=build /app/packages/batch/dist ./packages/batch/dist
COPY --from=build /app/packages/dashboard/package.json ./packages/dashboard/package.json
COPY --from=build /app/packages/dashboard/dist ./packages/dashboard/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/db/etl ./packages/db/etl

USER node
EXPOSE 8080
CMD ["node", "packages/chat-gateway/dist/index.js"]
