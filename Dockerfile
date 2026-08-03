# syntax=docker/dockerfile:1

# ─── Build stage ───────────────────────────────────────────────────────────
# Bun is used for install + build (bun.lock is the project lockfile).
FROM oven/bun:1 AS build

WORKDIR /app

# Copy manifests first so the install layer is cached across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ─── Runtime stage ─────────────────────────────────────────────────────────
# The built output is a self-contained Node server (nitro preset "node-server"),
# so the runtime image needs neither Bun nor node_modules.
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/.output ./.output

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
