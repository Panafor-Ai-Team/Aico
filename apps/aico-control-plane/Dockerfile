# syntax=docker/dockerfile:1
# Dummy AUTH_SECRET / KEY_VAULTS_SECRET satisfy Next/env checks at build time
# only; they are not production secrets. BuildKit still flags the names.
# check=skip=SecretsUsedInArgOrEnv

# Panachat control-plane image (operator UI + Hono on :3020).
# Build from repo root:
#   docker build -f apps/aico-control-plane/Dockerfile -t panachat-control-plane .
#
# Runtime is self-contained. Do not bind-mount the git checkout over /app.

ARG NODEJS_VERSION="24"

## Workspace manifests only: `pnpm i` below stays cached across source-only
## commits, which keeps node_modules byte-identical so `docker pull` reuses
## that (large) layer on deploy.
FROM node:${NODEJS_VERSION}-bookworm-slim AS manifests

WORKDIR /src

COPY . .

RUN set -e; \
    mkdir -p /out; \
    find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out/ \;; \
    cp -a pnpm-workspace.yaml .npmrc patches /out/

FROM node:${NODEJS_VERSION}-bookworm-slim AS deps

# This repo sets lockfile=false. Do not use frozen-lockfile (headless install
# fails) or pnpm's allow-all-builds config (conflicts with
# onlyBuiltDependencies: neverBuiltDependencies + onlyBuiltDependencies).
# Empty CI so `pnpm run` does not re-install in GitHub Actions / Buildx.
# Add esbuild to the allowlist so Vite has a binary (postinstall is otherwise skipped).
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_OPTIONS=--max-old-space-size=8192 \
    APP_URL=http://app.com \
    DATABASE_DRIVER=node \
    DATABASE_URL=postgres://postgres:password@localhost:5432/postgres \
    KEY_VAULTS_SECRET=use-for-build \
    AUTH_SECRET=use-for-build \
    CI=

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g corepack@latest && corepack enable

COPY --from=manifests /out/ ./

# mtimes zeroed so an unchanged install yields an identical layer digest.
RUN set -e; \
    grep -qE '^[[:space:]]*-[[:space:]]*esbuild$' pnpm-workspace.yaml \
      || sed -i '/^onlyBuiltDependencies:/a\  - esbuild' pnpm-workspace.yaml; \
    corepack use "$(sed -n 's/.*"packageManager": "\(.*\)".*/\1/p' package.json)"; \
    pnpm i; \
    cp pnpm-workspace.yaml /tmp/pnpm-workspace.yaml; \
    find node_modules -exec touch -h -d @0 {} +

# The runtime image takes node_modules from `deps`, not from here, so caches the
# build writes into node_modules cannot change that layer.
FROM deps AS builder

COPY . .

# `COPY . .` restores the pristine pnpm-workspace.yaml; keep the esbuild allowlist.
RUN cp /tmp/pnpm-workspace.yaml pnpm-workspace.yaml

RUN pnpm run build:spa:control-plane \
    && pnpm --filter @aico/control-plane build \
    && test -f apps/aico-control-plane/dist/standalone.js \
    && test -f apps/aico-control-plane/web/spa/index.html

FROM node:${NODEJS_VERSION}-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    AICO_IS_CONTROL_PLANE=1 \
    AICO_CONTROL_PLANE_PORT=3020 \
    HONO_HOST=0.0.0.0 \
    NODE_PATH=/app/node_modules

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /app --no-create-home nextjs \
    && chown nextjs:nodejs /app

# --chown instead of `chown -R`, which would duplicate node_modules into a
# second multi-GB layer.
COPY --link --chown=1001:1001 --from=deps /app/node_modules ./node_modules
COPY --link --chown=1001:1001 --from=builder /app/apps/aico-control-plane/dist ./dist
COPY --link --chown=1001:1001 --from=builder /app/apps/aico-control-plane/web/spa ./web/spa
COPY --link --chown=1001:1001 --from=builder /app/apps/aico-control-plane/src/web ./src/web
COPY --link --chown=1001:1001 --from=builder /app/apps/aico-control-plane/package.json ./package.json

# --link layers may create parent dirs (/app/web, /app/src) as root; restore the
# previous ownership. Dirs only: a tiny layer.
RUN find /app -type d ! -user 1001 -exec chown nextjs:nodejs {} +

USER nextjs
EXPOSE 3020
CMD ["node", "dist/standalone.js"]
