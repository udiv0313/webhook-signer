# Production image: one Node process serves the web app, the API and /health
# from a single origin. Build: docker build -t webhook-signer .
# See docs/deploy.md for running it.

# Pinned Node release (same as development). The backend needs node:sqlite,
# available without flags since Node 22.13.
ARG NODE_IMAGE=node:24.9.0-bookworm-slim

# --- Stage 1: build the web app ---------------------------------------------------
FROM ${NODE_IMAGE} AS frontend
WORKDIR /app/frontend

# Dependencies first (exact versions from the lockfile), so this layer stays
# cached until package-lock.json changes.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime ---------------------------------------------------------------
# The backend has no npm dependencies, so nothing is installed here.
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/webhook-signer.db \
    FRONTEND_DIST=/app/frontend/dist

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY --from=frontend /app/frontend/dist ./frontend/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown node:node /data

VOLUME ["/data"]
EXPOSE 3000

# The slim image has no curl, so the check uses Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# The entrypoint starts as root only to hand the mounted /data volume to the
# unprivileged "node" user, then drops root (setpriv) before the server runs.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
