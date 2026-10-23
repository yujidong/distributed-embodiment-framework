# syntax=docker/dockerfile:1
#
# Embodied Agent Framework — all-in-one production image (P3c)
#
#   docker compose up --build            # → http://localhost:8100
#   # or bare docker:
#   docker build -t eaf . && docker run -p 8100:8100 -v eaf-data:/data eaf
#
# One container runs API + WebSocket + the built web console (served at `/`
# via @fastify/static). All state lives in the /data volume.
#
# Stages:
#   1. build      full deps (incl. dev) + `npm run build:all`
#   2. prod-deps  production-only node_modules (`npm ci --omit=dev`)
#   3. runtime    slim image: prod deps + built dists + seed scenarios,
#                 non-root user, /data volume, PORT 8100

# ---------------------------------------------------------------------------
# Stage 1: full install + compile packages, server, web
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
# better-sqlite3 ships prebuilt binaries for glibc AND musl (alpine); this
# toolchain is only a fallback for platforms without a matching prebuild.
RUN apk add --no-cache python3 make g++
WORKDIR /app
# Manifests first for layer caching — npm ci needs every workspace's
# package.json present to resolve the workspace graph.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/simulation/package.json packages/simulation/package.json
COPY packages/llm-integration/package.json packages/llm-integration/package.json
RUN npm ci
COPY . .
RUN npm run build:all

# ---------------------------------------------------------------------------
# Stage 2: production-only node_modules
# ---------------------------------------------------------------------------
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/simulation/package.json packages/simulation/package.json
COPY packages/llm-integration/package.json packages/llm-integration/package.json
# Workspace symlinks under node_modules/@active-collaboration point at
# /app/packages/* — the runtime stage copies those dists at the same paths.
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 3: slim runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8100 \
    EAF_DB_PATH=/data/eaf.db \
    EAF_TRAJECTORY_DIR=/data/trajectories \
    SCENARIO_USER_DIR=/data/scenarios \
    WEB_DIST=/app/apps/web/dist
WORKDIR /app
RUN addgroup -S eaf && adduser -S eaf -G eaf \
    && mkdir -p /data && chown -R eaf:eaf /data

# Production dependencies (workspace symlinks → /app/packages/*).
COPY --from=prod-deps /app/node_modules ./node_modules
# API server: compiled output + hand-maintained OpenAPI contract
# (/api/docs and /api/openapi.yaml read it at runtime).
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/openapi.yaml ./apps/server/openapi.yaml
# Web console bundle (served at `/` via WEB_DIST).
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Engine workspaces: manifests + compiled dists only.
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/simulation/package.json ./packages/simulation/package.json
COPY --from=build /app/packages/simulation/dist ./packages/simulation/dist
COPY --from=build /app/packages/llm-integration/package.json ./packages/llm-integration/package.json
COPY --from=build /app/packages/llm-integration/dist ./packages/llm-integration/dist
# Bundled seed scenarios (read-only). User data lives in the /data volume.
COPY config ./config

USER eaf
VOLUME /data
EXPOSE 8100
# R32-C: container-native liveness — the enriched /api/health (SQLite probe
# included) is the same truth orchestrators read; wget exists in alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1
CMD ["node", "apps/server/dist/index.js"]
