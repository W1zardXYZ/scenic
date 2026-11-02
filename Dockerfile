# syntax=docker/dockerfile:1

# ---- build: install everything, bundle the web UI, then drop dev dependencies ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ---- runtime: server sources run directly (Node strips the types), no compile step ----
FROM node:24-slim
ENV NODE_ENV=production \
    SCENIC_DATA=/data \
    SCENIC_BROWSE_ROOT=/maps
WORKDIR /app

# /data is the writable library (database, thumbnails); /maps is mounted read-only.
RUN mkdir -p /data /maps && chown node:node /data

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 8420
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const p=process.env.SCENIC_PASSWORD;fetch('http://127.0.0.1:8420/api/status',{headers:p?{authorization:'Basic '+Buffer.from('scenic:'+p).toString('base64')}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/index.ts"]
