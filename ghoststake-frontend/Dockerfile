# syntax=docker/dockerfile:1

# Node 22 matches the local toolchain (v22.21.0).
ARG NODE_VERSION=22-alpine

# ---- deps: install node_modules from the lockfile only ----------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# corepack pins pnpm to the version in package.json's packageManager field.
RUN corepack enable

# pnpm-workspace.yaml carries install settings (ignoredBuiltDependencies),
# so it has to be present for the install to resolve the same way it does locally.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# node-linker=hoisted gives a flat, npm-style node_modules. pnpm's default
# symlinked layout breaks `output: "standalone"`: the file tracer copies the
# symlinks but not every .pnpm target behind them, and the container dies at
# startup on a missing transitive dep (@swc/helpers).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --config.node-linker=hoisted

# ---- builder: compile the app -----------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runner: minimal production image ---------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# standalone bundles server.js plus the traced dependencies. public/ and
# .next/static are not included by the trace and must be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000
ENV PORT=3000
# 0.0.0.0 so the server is reachable from outside the container.
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
