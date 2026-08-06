# Authentication

Local, session-based authentication for Sentinel AI. No OAuth, no JWT, no
external identity provider — the system is designed to run on an offline or
intranet network with no outbound dependency.

## Setup

```sh
cp .env.example .env          # then fill in SESSION_SECRET
bun run auth:setup            # migrate + generate + seed
bun run dev
```

`auth:setup` is the three steps below, in order:

| Command | What it does |
|---|---|
| `bun run db:migrate` | Applies `prisma/migrations` to the SQLite file |
| `bun run db:generate` | Regenerates the Prisma client into `src/generated/prisma` |
| `bun run db:seed` | Creates the first administrator (idempotent) |

Generate a session secret with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The seeded account is `admin` / `Admin@123`. It is created with
`mustChangePassword`, so every route except the change-password screen rejects
it until a new password is set — the documented default cannot survive first
sign-in. Re-running the seed never resets an existing account's password.

Also useful: `bun run db:studio` (browse the database), `bun run db:reset`
(**destroys all data** and re-migrates).

## Architecture

```
Browser                          Server
───────                          ──────
login form
  │ login({data})                 ┌─ rate limit  (LoginAttempt table)
  ├────────────── server fn ─────▶├─ verify      (Argon2id, hash-wasm)
  │                               ├─ status      (isActive)
  │                               ├─ new session (Session table)
  │◀── Set-Cookie: sentinel_sid ──┘   + audit    (AuditLog table)
  │    HttpOnly SameSite=Strict
  │
  │ every later request
  ├────────────── cookie ────────▶ unseal → session id → DB lookup → user
  │                                (a missing row = signed out, immediately)
```

The cookie is an AES-256 sealed envelope (h3, via
`@tanstack/react-start/server`) that carries **only an opaque token**. The
`Session` table is the authority on whether that token is still good.

That split is the point: a self-contained signed cookie cannot be revoked
before it expires. Because the database is consulted on every request,
disabling an account or changing a password logs the holder out on their next
action.

The token itself is never stored — the primary key is its SHA-256, so a dump of
the `Session` table yields no usable credentials.

## Layout

| Path | Role |
|---|---|
| `prisma/schema.prisma` | `User`, `Session`, `AuditLog`, `LoginAttempt` |
| `src/lib/roles.ts` | Roles, ranking, capability table |
| `src/lib/auth-schemas.ts` | Every zod schema (shared by form and server) |
| `src/lib/auth-errors.ts` | Error codes, HTTP statuses, user-facing copy |
| `src/lib/auth-client.ts` | Session query, cache helpers, redirect sanitiser |
| `src/server/auth/password.ts` | Argon2id hash / verify / rehash |
| `src/server/auth/sessions.ts` | Create, resolve, revoke, prune |
| `src/server/auth/login.ts` | Login, logout, change password |
| `src/server/auth/users.ts` | User CRUD, search, pagination |
| `src/server/auth/guards.ts` | `requireAuth` / `requireRole` / `requireAdmin` |
| `src/server/auth/functions.ts` | The server functions the browser calls |
| `src/routes/login.tsx` | Sign-in screen |
| `src/routes/change-password.tsx` | Forced and voluntary password change |

Business logic lives in plain exported functions that take a database as their
first argument. `createServerFn` wrappers add transport and nothing else. This
matches the existing convention in `src/utils/llm.ts` and is what makes the
logic testable — a server function cannot run outside the Start runtime, but
`authenticate(db, …)` runs anywhere, including against an in-memory database.

## Roles

Ordered, each subsuming the one below. `requireRole("Manager")` admits Managers
and Admins.

| Role | Adds |
|---|---|
| Guest | *(nothing — can sign in and change their own password)* |
| Employee | `intel:read`, `intel:analyse`, `intel:write` |
| Manager | `report:generate`, `audit:read` |
| Admin | `credentials:manage`, `users:manage` |

Prefer `requirePermission("users:manage")` over comparing role names, so a
capability can be moved between roles by editing one table.

SQLite has no enum type, so `User.role` is a `String` validated by zod on write
and by `parseRole()` on read. `parseRole` throws on an unrecognised value
rather than defaulting — a row the code cannot interpret fails closed instead
of being silently downgraded or promoted.

## API

Server functions, not HTTP routes. `src/start.ts` registers
`createCsrfMiddleware` filtered to `handlerType === "serverFn"`, so server
functions are CSRF-protected automatically; a hand-rolled `/api` route would
not be.

| Function | Spec endpoint | Behaviour |
|---|---|---|
| `login` | `POST /login` | Returns `AuthResult` |
| `logout` | `POST /logout` | Revokes the session, clears the cookie |
| `fetchMe` | `GET /me` | Throws `UNAUTHENTICATED` when signed out |
| `fetchSession` | `GET /session` | Returns the signed-out state instead of throwing |
| `changePassword` | — | Requires the current password |

### Failures are returned, not thrown

```ts
type AuthResult =
  | { ok: true; state: AuthState }
  | { ok: false; code: AuthErrorCode; message: string; fieldErrors?: … }
```

This is not a style preference. Router-core serialises a thrown `Error` through
its `ShallowErrorPlugin`, which keeps **only** `message` and rebuilds a plain
`new Error(message)` on the client — custom properties are dropped. A thrown
`AuthError` therefore arrives with `code` and `fieldErrors` stripped, and the
login form cannot tell a validation failure from a rejected password. Verified
against a running server.

Genuine faults — a dead database, a bug — still throw and are handled by the
error middleware in `src/start.ts`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./data/sentinel.db` | Must be on persistent storage |
| `SESSION_SECRET` | — | **Required**, ≥32 chars. Rotating it logs everyone out |
| `SESSION_MAX_AGE` | `28800` | 8 hours. "Remember me" extends to 30 days |
| `ARGON2_MEMORY_KIB` | `19456` | Raising it raises both cost and login latency |
| `ARGON2_ITERATIONS` | `2` | |
| `ARGON2_PARALLELISM` | `1` | |
| `LOGIN_MAX_ATTEMPTS` | `5` | Per identifier; the per-IP allowance is 4× this |
| `LOGIN_WINDOW_SECONDS` | `900` | |
| `LOGIN_LOCKOUT_SECONDS` | `900` | |
| `SEED_ADMIN_USERNAME` | `admin` | |
| `SEED_ADMIN_EMAIL` | `admin@sentinel.local` | |
| `SEED_ADMIN_PASSWORD` | `Admin@123` | Seed refuses the default under `NODE_ENV=production` |

## Testing

```sh
bun test          # 426 tests across the whole suite
```

| File | Covers |
|---|---|
| `tests/auth-password.test.ts` | Argon2id hashing, verification, rehash detection |
| `tests/auth-roles.test.ts` | Hierarchy, inheritance, fail-closed `parseRole` |
| `tests/auth-schemas.test.ts` | Every validation rule and its rationale |
| `tests/db/login.test.ts` | Login flow, lockout, fixation, disabled accounts |
| `tests/db/sessions.test.ts` | Lifecycle, rolling expiry, revocation, pruning |
| `tests/db/users.test.ts` | CRUD, last-admin rule, session consequences |
| `tests/db/auth-flow.test.ts` | The paths end to end: sign in, act, change password, sign out |

Database tests run against an in-memory libSQL instance built by replaying the
actual migration SQL (`tests/db/helpers/test-db.ts`), so a migration that has
drifted from `schema.prisma` fails in a fast test rather than on a deployment.
Each test gets its own database, so they may run in any order.

Argon2 parameters are lowered to the validator's floor under test — the shipped
cost is deliberately slow, and hashing dozens of passwords at 19 MiB would make
the suite take minutes.

## Security properties

Verified end to end over HTTP against a running production build (18 assertions
covering credential handling, session lifecycle and SSR route protection), plus
426 unit and integration tests:

- **Password storage** — Argon2id, 19 MiB / t=2 / p=1 (OWASP baseline), via
  `hash-wasm`. Parameters are embedded in the PHC string, so raising them later
  transparently upgrades each hash on next successful sign-in.
- **No user enumeration** — a wrong password and a non-existent account return
  an identical code and message. The unknown-account branch spends a dummy
  Argon2 verification so response times match.
- **Order of checks** — rate limit, then password, then account status. A
  disabled account is only revealed to someone who already proved they know the
  password; otherwise the message is a free account-existence oracle.
- **Session fixation** — any cookie presented at sign-in has its session
  destroyed before a new token is minted.
- **Revocation** — disabling an account or changing a password deletes its
  session rows; a captured cookie stops working on the next request.
- **Cookie** — `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` in production.
  Sealed, so tampering fails to unseal and is treated as signed out.
- **Rate limiting** — 5 failures per identifier/IP in 15 minutes, then a
  15-minute lockout. Held in the database, not process memory, so it survives a
  restart and holds across replicas.
- **Audit** — 15 action types, append-only. `userId` is nulled rather than
  cascaded on user delete, so removing an account never erases what it did.
- **Logging** — structured JSON with recursive redaction of any field whose
  name looks like a secret. Passwords are never logged.
- **Open redirect** — `?redirect=` is rejected unless it is a same-site
  absolute path; `//host`, `/\host` and absolute URLs are discarded.

## Why not express-session / helmet / bcrypt

This is not an Express app — it is TanStack Start on Nitro 3 and h3 v2, with no
`app.use()` to mount Express middleware on. The equivalents used instead:

| Asked for | Used | Why |
|---|---|---|
| `express-session` + SQLite store | h3 sealed cookie + `Session` table | Same guarantee (server-side, revocable, SQLite-backed) with no Express |
| `argon2` (native) | `hash-wasm` (WASM) | The runtime image ships `.output` without `node_modules` and runs Alpine/musl; a node-gyp addon will not load |
| `express-rate-limit` | `LoginAttempt` table | In-memory counters reset on restart and do not exist across replicas |
| `helmet` | *(not yet — see below)* | Would be a middleware in `src/start.ts` |

`better-sqlite3` is a devDependency only, for the Prisma CLI. The application
driver is **libSQL**: Bun cannot load `better-sqlite3` at all — it panics with
a fatal NAPI error — and `bun run dev` executes this code inside Bun. libSQL is
a napi module that loads under both Bun and Node, and reads the same SQLite
file format, so the schema and migrations are unaffected.

## Not yet done

Honest list of what the specification asks for that is not built:

- **Admin user-management UI.** The service layer is complete and tested
  (`src/server/auth/users.ts` — create, update, delete, enable/disable, reset
  password, assign role, search, pagination) but has no screen and no server
  functions wired to it.
- **Audit log viewer.** `listAudit` exists; nothing renders it.
- **Role-filtered navigation.** `NAV_GROUPS` in `app-shell.tsx` is not yet
  filtered by capability, so every signed-in user sees every link. The routes
  behind them are still gated server-side.
- **The other 30 server functions are still unauthenticated.** Adding auth did
  not retroactively protect `fetchNews`, `saveCredentials` and the rest — each
  needs a `requireAuth()` / `requirePermission()` call. `saveCredentials` in
  `src/routes/settings.tsx` is the most urgent: it writes third-party API keys
  to disk and anyone who can reach the server can still call it.
- **Security headers.** No CSP / HSTS / X-Frame-Options middleware yet.
- **localStorage is not user-scoped.** All 12 keys (investigations, watchlists,
  evidence…) are shared per browser, so on a shared workstation the next person
  to sign in sees the previous analyst's work until they overwrite it. This is
  a real disclosure issue and the first thing to fix next.
- **i18n.** The auth screens are English-only. The DOM translation layer leaves
  unknown phrases untouched, so nothing breaks; adding them means ~30 entries
  in each of the 15 files under `src/i18n/locales/`.

## Operational notes

- **The SQLite file must live on persistent storage.** `DATABASE_URL` defaults
  to `file:./data/sentinel.db`. On an ephemeral container filesystem every
  restart silently resets all accounts.
- **`vite dev` loads `.env`; the built server does not.** `bun run start`
  passes `--env-file-if-exists=.env` to close that gap. If the variables are
  missing, the server logs a boxed warning on the first request rather than
  failing silently at sign-in.
- **Rotating `SESSION_SECRET` invalidates every live session.** That is the
  intended way to force a global logout.
