# syntax=docker/dockerfile:1

# ─── Build stage ───────────────────────────────────────────────────────────
# Bun is used for install + build (bun.lock is the project lockfile).
FROM oven/bun:1 AS build

WORKDIR /app

# Copy manifests first so the install layer is cached across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# The Prisma client is generated code, output to src/generated/prisma (see the
# generator block in prisma/schema.prisma). It is gitignored, so it does NOT
# arrive with the source and must be generated here — src/server/db.ts imports
# from it, so the Vite build fails without this step.
#
# A placeholder DATABASE_URL is enough: `generate` only needs the schema, but
# prisma.config.ts resolves env("DATABASE_URL") eagerly. Nothing connects.
RUN DATABASE_URL="file:./data/build-placeholder.db" bunx prisma generate

RUN bun run build

# ─── Runtime stage ─────────────────────────────────────────────────────────
# Bun rather than a bare node image, because the container has to run schema
# migrations and the seed on startup — both of which need the Prisma CLI, the
# schema, the migration history and the seed script, not just the built server.
FROM oven/bun:1 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# The built server is self-contained, but the startup steps are not:
#   node_modules      — Prisma CLI + client + the libSQL driver adapter
#   prisma/           — schema.prisma, the migration history, seed.ts
#   src/              — seed.ts imports the password hasher and the account
#                       policy from src/, so they are deliberately not
#                       duplicated for the container
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/package.json /app/bun.lock /app/prisma.config.ts /app/tsconfig.json ./

COPY docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# DATABASE_URL points here. In Azure this path is an Azure Files mount, so the
# accounts, sessions and audit log survive a restart and a scale-to-zero.
# Created here as well so the image still runs with no volume attached — with
# the loss of persistence that implies, which the entrypoint states out loud.
RUN mkdir -p /app/data

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
