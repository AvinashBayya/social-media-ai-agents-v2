#!/bin/sh
# Container startup for Sentinel AI.
#
# The built server cannot bring up its own schema, so migrations and the seed
# run here, before the process that serves traffic. Both are fatal on failure:
# an application that starts with no schema, or with no account anyone can sign
# in to, is worse than one that visibly refuses to start — it looks healthy to
# the platform and fails at the login screen.
#
# Ordering matters. `migrate deploy` applies committed migrations only and never
# generates new ones, so it is safe to run unattended on every start. The seed
# is idempotent: it leaves an existing account untouched and never resets a
# password, so a restart cannot revert a password an analyst has changed.

set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

echo "[entrypoint] Sentinel AI starting."
echo "[entrypoint] NODE_ENV=${NODE_ENV:-unset} PORT=${PORT:-unset}"

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL is not set."
  echo "[entrypoint] Auth cannot start without it. Expected e.g. file:/app/data/sentinel.db"
  exit 1
fi

if [ -z "$SESSION_SECRET" ]; then
  echo "[entrypoint] FATAL: SESSION_SECRET is not set."
  echo "[entrypoint] Sessions are sealed with it; starting without one would be silently insecure."
  exit 1
fi

# A container filesystem is ephemeral. If the data directory is not a mount,
# every restart silently resets all accounts, sessions and the audit log — so
# say so rather than letting it be discovered later.
if mountpoint -q "$DATA_DIR" 2>/dev/null; then
  echo "[entrypoint] $DATA_DIR is a mounted volume — accounts and the audit log persist."
else
  echo "[entrypoint] WARNING: $DATA_DIR is NOT a mounted volume."
  echo "[entrypoint] The database lives on the container filesystem, so every restart"
  echo "[entrypoint] resets all accounts, sessions and the audit log. Attach persistent"
  echo "[entrypoint] storage before treating this deployment as real."
fi

echo "[entrypoint] Applying database migrations…"
bunx prisma migrate deploy

echo "[entrypoint] Seeding the administrator account (idempotent)…"
bun run prisma/seed.ts

echo "[entrypoint] Handing off to the server."
exec node .output/server/index.mjs
