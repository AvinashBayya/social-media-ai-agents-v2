# Sentinel AI — Project Memory & Anti-Deletion System

> **Mandatory AI Protocol:** Every AI assistant (Claude / Antigravity / Cursor) interacting with this codebase **MUST** read this file at the start of every session, update the Active Task State upon progress, and observe the strict **Anti-Deletion Code Preservation Protocol**.

---

## 1. Active Task State & Progress Roadmap

### Current Focus

- **Task:** Browser-audit remediation complete. `ai-service/` (teammate's Python vision/forensics backend) merged in from `MERGE_PACKAGE/`; not yet wired to the frontend. OSINT collector framework (`docs/OSINT-INTEGRATION-PLAN.md`): **P1, P2-UI and P2-Reports all fully complete**; **P2-Production 2 of 6 done**; **P3 2 of 5 done, plus one extra item** — `/recon`'s "OSINT Investigation" panel covers investigation start, live progress, collector status, results, evidence inspection, manual collector selection, and now a free keyless full-text web-content collector (Jina Reader); `/graph` renders a real BFS-ring layout from a "View in Graph" hand-off and can export the full entity/relationship set to Maltego (CSV); `/reports` can include real OSINT evidence and relationships as citable, budget-aware sources; the OSINT job store is optionally SQLite-backed (`JOB_STORE_PATH`, in-memory unchanged by default) and `.env.example` documents every real env var. Browser-verified eight times, catching two real "built but never wired up" bugs, one real large-target scale issue, one real token-budget bug, one severe live regression, and one stale UI claim (see below and the milestone entries). Worker Dockerfile/docker-compose/Azure deployment/health checks/error monitoring remain unbuilt, deliberately — no Docker locally, no deployed theHarvester/SpiderFoot worker to containerize, and Azure changes touch real subscription resources not to be written blind. Nmap/full Shodan API/more social providers/continuous monitoring (P3) also unbuilt, each needing either authorization scaffolding, a real API key, or compliance research not yet done — see the 2026-08-17 tool-list research milestone for exactly what was checked and ruled out.
- **⚠️ Known-fixed regression, worth knowing the shape of:** the persistent-job-storage work (2026-08-14, previous session) statically imported `bun:sqlite` in a module client route components also import, which pulled it into the *browser* bundle and crashed every route ("This page didn't load") — undetected at the time because that session verified it only with `bun test`/`tsc`/direct `bun -e` checks, never an actual browser click-through. **That broken code was pushed to `origin/main`.** Found and fixed 2026-08-17 while browser-testing an unrelated feature (Maltego export) — first real browser launch since. Fixed by loading `SqliteJobStore` via a `typeof window`-guarded `require()` instead of a static import. See the milestone entry below for the exact mechanism. The lesson driving this note: **`bun test`/`tsc` passing is not evidence a route still loads in a browser** — this project's own established discipline, reconfirmed the hard way.
- **⚠️ Do not build against these, if suggested again:** Agent-Reach, OpenCLI, any "Facebook/Twitter/Reddit/Instagram/LinkedIn via browser adapter" tool — checked directly 2026-08-17, all use cookie-exported/logged-in-browser-session scraping, which is exactly the ToS violation this project already ruled out for Instagram/Facebook and never re-added for Twitter/X. `ArjunPrakash09/linkedin-scraper-mcp` specifically 404s — doesn't exist.
- **Phase:** PS-18 Pre-selection Demo Integrity & Multi-Source Intelligence
- **Last Verified:** 2026-08-17 — **895 unit tests passing** (`bun test`), **`tsc --noEmit` clean**, **151 core exports verified** (`bun scripts/check-exports.ts`), and eight live browser runs of `/recon`/`/graph`/`/reports` against real free APIs, including a 3,461-entity real-world stress case, an end-to-end manual-selection run, an end-to-end Graph hand-off run, an end-to-end Reports OSINT-inclusion run, an end-to-end Maltego-export run (also catching and confirming the fix for the client-bundle regression above), and an end-to-end Jina Reader run (real Wikipedia article investigated on `/recon`, real 21,907-character extraction confirmed both via direct `bun -e` and in-browser). `fabrication-check` fails at baseline with 81 pre-existing matches unrelated to any work this session (see `docs/OSINT-INTEGRATION-PLAN.md` §31 P0 Baseline note) — every file added this session is individually clean against it.

### Deployed state — 2026-08-13 ✅ LATEST

`sentinel-web` runs **`v26`** / revision **`sentinel-web--0000024`**
(`RunningAtMaxScale`, 1 replica), at
`sentinel-web.livelyfield-6aea41cd.centralindia.azurecontainerapps.io`.
**653 JS/TS unit tests passing**, **`tsc --noEmit` clean**, **151 core exports verified**.
GitHub `origin/main` is at `e83ffcf`.

> **Always run the check below before trusting this section** — the deploy that produced
> v26 was tagged from the live value, not from this file:
>
> ```sh
> az containerapp show -g rg-sentinel-demo -n sentinel-web >   --query "{image:properties.template.containers[0].image, rev:properties.latestReadyRevisionName}"
> ```

#### YouTube Feature Architecture (v23+, rewritten 2026-08-12) — CRITICAL FOR AI TO KNOW

- **Self-contained**: no FastAPI backend. All logic runs in TanStack Start **server functions**.
- **Primary source is YouTube's own InnerTube `player` endpoint**, not ytdl-core. Public, keyless,
  and — crucially — its URLs need **no deciphering**, so the player-signature arms race cannot
  break it. `YT_INNERTUBE_CLIENTS` is tried in order.
  - **ANDROID first** — the only client returning a **muxed** format (itag 18, 360p). The runtime
    has no ffmpeg, so adaptive-only clients give streams we cannot join.
  - **IOS second** — metadata and captions; 32 formats, none muxed.
  - **WEB is excluded from playback** — it answers `UNPLAYABLE — "Video unavailable"` for videos
    ANDROID serves fine. It is used _only_ for `microformat`, the sole source of an upload date.
- **ytdl-core is now a lazy-loaded fallback**, `await import()` inside the fallback branch. A static
  import took the whole module down under Bun (`http-cookie-agent` calls `this.compose` on a
  Dispatcher that lacks it).
- **Subtitles**: the signed `captionTracks[].baseUrl` from the player response. **The unsigned
  `api/timedtext?v=ID&lang=en` endpoint is DEAD** — it answers HTTP 200 with a zero-length body.
  **`&fmt=vtt` is silently ignored**; YouTube returns `<timedtext format="3">` XML regardless, so
  `parseTimedTextXml` is required and `parseSubtitleBody` sniffs the format from the bytes.
- **Supported URLs**: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`, `shorts.youtube.com/`.
- **Key files**: `src/utils/youtube-collector.ts` (logic + pure parsers), `src/routes/youtube.tsx` (UI).
- **Data honesty**: typed errors (`VideoUnavailable`, `SubsUnavailable`, `DownloadFailed`) — NEVER
  fake data. In particular: `available_subtitles` comes from real caption tracks (it was a hardcoded
  English entry), download failures quote YouTube's own `playabilityStatus.reason` (they asserted
  "may be age-restricted or region-locked" on every failure), and a caption track that downloads but
  will not parse is reported as **our** parser failing, never as the video having no subtitles.
- **Verified live 2026-08-12** on `b6g6rDDt9x8`: duration 734s, 4,309,691 views, upload date
  2020-11-10, 347 caption segments from 93,199 bytes, download HEAD 200 `video/mp4` 22,830,807 bytes.

#### Deployment Commands (run from `d:\social_media_research`)

```bash
# Build image
az acr build --registry sentinelacr4821 --image sentinel-web:vXX --no-logs .
# Deploy
az containerapp update -g rg-sentinel-demo -n sentinel-web --image sentinelacr4821.azurecr.io/sentinel-web:vXX
# Git push
git add -A && git commit -m "..." && git push origin main
```

### Live collection status — verified 2026-08-11

Re-verify with the `/crawlers` probe rather than trusting this table; it is a snapshot.

| Source            | State        | Note                                                                                                                 |
| ----------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Bluesky Jetstream | Working      | Browser-side WS; 5 posts in ~2s                                                                                      |
| Bluesky AppView   | Working      | `getProfile` / `getProfiles` / `getAuthorFeed`                                                                       |
| Mastodon          | Working      | Keyless hashtag timelines; per-instance, some return 422                                                             |
| Telegram          | Working      | `t.me/s/{channel}` previews & topic classification                                                                   |
| GPSJam ADS-B      | Working      | Navigation interference hex feed & regional classifier                                                               |
| Safecast Rad      | Working      | Open environmental radiation sensor network (µSv/h)                                                                  |
| CISA KEV          | Working      | Known Exploited Vulnerabilities cyber threat feed                                                                    |
| **Reddit**        | **Blocked**  | **All unauthenticated endpoints now 403. Needs `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` from a free script app.** |
| crt.sh            | Flaky        | Same URL gave 404 / timeout / 200-in-43s. Retries once; 50s budget                                                   |
| GDELT             | Rate limited | 429 at 1 req/5s, as documented                                                                                       |

### Completed Milestones

- [x] **Security hardening, phases 0–1 (2026-08-17)**: The analytical layer was mature; the
  security layer did not exist. No authentication, no rate limiting, and **52 server functions
  carrying 52 identity validators** — `.validator((d: { text: string }) => d)` is a TypeScript
  annotation, erased at build, so every handler received whatever JSON the caller posted.

  **P0-1 — unauthenticated credential dump.** `getCredentials` (`routes/settings.tsx`) was a GET
  server function with no validator that returned `readVault()` VERBATIM: every stored secret in
  cleartext to anyone who could reach the origin — Bluesky app password, Reddit client secret,
  YouTube API key, UCDP token, GitHub token, Mastodon access token, both LLM keys. Its sibling
  `listCredentials` had always redacted; this one never did. The route gate is the disclosed
  client-side demo session, and **CSRF middleware does not help — it stops a cross-site browser
  request, not `curl`.** Now redacts. `saveCredentials` (validator: `(data: any) => data`,
  replaced the WHOLE file) is schema-validated and gated. **No server function returns a stored
  secret any more; do not add one back.**

  **P0-2 — SSRF with credential forwarding.** `fetchMastodonTag` sanitised a caller-supplied
  instance with `.replace(/^https?:\/\//,"").replace(/\/.*$/,"")` — scheme and path only, so a
  port, `@` userinfo and query survived — and never checked the allowlist declared 60 lines
  above it. `instance: "169.254.169.254:80"` produced a server-side GET against Azure instance
  metadata with the body returned to the caller. Chained with P0-1 it was worse: write a
  `mastodon` entry whose identifier is your host, call `verifyCredential`, and the server
  delivers the stored **Bearer token** to you. Allowlisted in `resolveMastodonHost` **and** in
  `verifyProviderCredential` next to the fetch that carries the secret — `fetchMastodonTag` is
  exported, so a validator on the RPC wrapper alone is bypassable.
  `MASTODON_ALLOWED_HOSTS` is deliberately WIDER than `MASTODON_INSTANCES`: the former is what
  the guard permits, the latter what the UI offers. `infosec.exchange` 422s anonymous readers,
  and reporting that refusal *as a refusal* is a distinction this collector is built around.

  **Security headers**, applied in `server.ts` to every response including error pages: nosniff,
  `X-Frame-Options: DENY`, referrer policy, permissions policy, COOP/CORP, HSTS on HTTPS only
  (read from `x-forwarded-proto` — behind ACA ingress the container connection is plain HTTP, so
  `url.protocol` would suppress HSTS on every production response). **CSP ships `report-only`**;
  a policy tight enough to matter can white-screen the app and that shows up only in a browser.
  `CSP_MODE=enforce` flips it after a clean console check.

  **New pure modules**, all `bun test`-able with injected clocks and env: `validation.ts`
  (`validate()` wraps a schema as a plain function — a BARE zod schema hits TanStack's Standard
  Schema branch and throws `JSON.stringify(issues)` at the browser), `rate-limit.ts`,
  `client-ip.ts`, `rate-limit-tiers.ts`, `operational-error.ts`, `operator-auth.ts`,
  `security-headers.ts`.

  **883 tests passing** (+164), `tsc --noEmit` clean, 204 exports verified, `bun run build` green.

  **Two traps recorded for whoever continues this:**
  1. **`errorMiddleware` in `start.ts` is DEAD CODE for all 52 server functions.**
     `server-functions-handler.js` catches their throws itself and *returns* a 500 Response, so
     by the time `await next()` resolves there is nothing to catch. Worse, TanStack serialises
     the thrown error with seroval at full feature level — which copies **`stack`**, absolute
     container paths included, to the browser. Sanitising must happen in a global
     `functionMiddleware`, which is the only layer that sees the throw first.
  2. **`getRequestIP({ xForwardedFor: true })` must not be used for rate limiting.** Verified at
     `h3/dist/h3.mjs:651` it takes `split(",")[0]` — the LEFTMOST, entirely caller-supplied,
     entry. Keyed on that, an attacker rotates the header per request and also evicts real
     offenders from the bounded map. `client-ip.ts` counts hops from the RIGHT.

  **Still outstanding:** rate-limit middleware is written but NOT yet wired into `start.ts`;
  error sanitisation not yet wired; ~40 identity validators still to migrate.

- [x] **Six reported defects + a fresh fabrication sweep (2026-08-17)**: A user driving the UI
  reported six broken features. **Two of the six premises were factually wrong**, and a sweep
  with the three CLAUDE.md greps found **seven further live fabrications nobody had reported**
  — every one of which passed `bun test`, `tsc --noEmit`, the export audit and `smoke:controls`,
  because no unit test can see a number that is invented at render time.

  **The corrections.** `/live`'s bookmark button was *not* a dead control: it was wired and did
  persist, but wrote a bare URL array to `sentinel_bookmarks` that **no other file in the
  repository ever read** — a dead end, not a dead button, and one that discarded the publisher,
  date and body, so a bookmark could never become citable evidence. And Reddit / Bluesky /
  Mastodon / GitHub were **already** on `/settings` with vault entries, env overrides, live
  Verify probes and working collectors; the real problem was that nothing was configured, so
  every consuming module correctly reported a missing credential and the app read as broken.

  **The seven unreported fabrications.** `/subjects` generated its "Activity Scanner Pulse"
  series from the loop index — `threats: Math.max(2, Math.round(baseVal * 0.4 + ((idx * 2) % 5)))`
  and `scans: Math.round(150 + idx * 12 + ((idx * idx * 3) % 25))`, with a floor of 5 so the
  chart was never empty even with zero matches, and a second series counting an activity this
  system does not perform. Its own comment said "chart mock trend points". The same page showed
  a **"Growth Rate"** tile of `matches.length * 1.5` percent (or the literal `8`), and rendered
  `{riskScore}/100` unguarded, so an analyst-created watchlist displayed **`null/100`**.
  `watchlist-store.ts` seeded `riskScore: 78` and `42` in the same file where `createWatchlist`
  was changed to `null` because that score was invented, with `createdAt: new Date()` at module
  scope so both samples always claimed to be seconds old. `/agents` seeded five fictional
  entities into its picker with two **pre-selected** and fed to the model as the analysis
  target, with no sample-data banner. The dashboard badged every watchlist `MONITORING`,
  contradicting `/watchlists`' own statement that nothing is scheduled. `/osint` substituted
  `"GDELT"` and `"Google News"` — aggregators — for missing publishers, the same class of error
  `rss-source.ts` exists to fix.

  **What was built.** Five new pure modules, all tested: `evidence-store.ts` (single owner of
  `sentinel_evidence`, which had two writers with two independently-declared shapes),
  `bookmark-store.ts` (v1 URL array → v2 records, migrating **without back-filling a single
  field**), `live-filters.ts` (the "Any time" window plus a testable predicate),
  `graph-build.ts` (co-occurrence graph, deterministic Fruchterman–Reingold seeded on a circle
  — **no `Math.random()`**, no new dependency), and `bucketMatchesByHour` in `watchlist-store.ts`.
  `/graph` was rewritten from a fixed ten-node topology onto the live entity-extraction pipeline
  `/entities` already runs; `/network` now draws the CIB clusters it was already computing;
  `/osint`'s UCDP path was deleted and delegated to `collectConflict()`, which actually sends the
  token. **719 unit tests passing** (+66), **`tsc --noEmit` clean**, **200 core exports verified**
  (+49 — the new modules are now guarded), `bun run build` green.

  Full defect list and file:line references: [`ANTIGRAVITY_TASK.md`](file:///d:/social_media_research/ANTIGRAVITY_TASK.md).

  **Three gaps in that work, found and closed the same day.** All three were invisible to every
  gate, which is the blind spot the original fabrications exploited.

  1. **The watchlist fabrication survived on existing browsers.** Correcting
     `DEFAULT_WATCHLISTS` to `riskScore: null` was not enough: `getWatchlists()` writes the
     defaults to storage on first ever load and reads from storage forever after, and it had
     **no version key**. A fresh browser got `null`; every browser that had already opened the
     app — a demo machine included — kept the seeded 78 and 42 and went on rendering "78/100"
     on `/subjects` and `/watchlists`. Fixed with `sentinel_watchlists_version = "2"` and an
     exported `migrateWatchlists`, which **migrates rather than wipes** and nulls **any**
     non-null score, not just the two seeded ids — nothing has ever computed one, so every
     non-null value in storage is by definition invented. **If a fabricated figure is removed
     from a seed constant, check whether that seed was already persisted.**
  2. **`entityKey` briefly existed twice** — `graph-build.ts` and `entities.tsx`. It carries a
     load-bearing fix (the old class covered Devanagari–Sinhala only, so every Urdu name was
     stripped to an empty key and merged into one node), and `/graph` and `/entities` must key
     identically or one corpus yields two different merged sets. `entities.tsx` now imports it.
  3. **`layoutGraph` had no node cap.** O(n² × 300) synchronously inside a `useMemo`; at 400+
     entities the tab froze. `iterationsFor(n)` now holds the work product roughly constant
     (300 iterations for small graphs, floor of 60), and `buildEntityGraph` caps at
     `DEFAULT_MAX_NODES = 250`, highest-degree first. **The cap is reported on screen** —
     `EntityGraph` carries `totalNodes` and `truncated`, and `/graph` renders "top 250 of 613".
     A silently truncated graph reads as the whole picture, which is the same defect class in a
     new costume.


- [x] **OSINT collector framework — evaluated a user-supplied tool list; built Jina Reader, ruled out the rest with a reason on record (2026-08-17)**: Checked each tool directly rather than assuming. **Ruled out**: Agent-Reach, OpenCLI, a Facebook OpenCLI adapter, and Twitter CLI all use cookie-exported/logged-in-browser-session scraping for Twitter/Reddit/Facebook/Instagram/XiaoHongShu — confirmed by reading Agent-Reach's own docs (which self-disclose "using Cookie login... carries account suspension risk") and the Facebook adapter's doc directly (browser automation on a real logged-in session, no ToS warning given at all). Exactly the pattern this project already rejected for Instagram/Facebook and never re-added for Twitter/X. `ArjunPrakash09/linkedin-scraper-mcp` 404s — doesn't exist. GitHub CLI/API and feedparser are redundant (already integrated; `rss-source.ts`+`rss-parser` already covers RSS in TypeScript). yt-dlp would mean subprocessing a Python CLI, the same problem already avoided for theHarvester. Exa has a genuine free tier but needs an API key not available this session — deferred, not built. **Built**: `src/utils/collectors/external/jina-reader.ts` — free, genuinely keyless (`r.jina.ai`, 20 req/min unauthenticated), full-text extraction for `url`-type targets, filling a real gap (article bodies elsewhere in this app are whatever a feed snippet gives). Response shape verified against the LIVE endpoint before writing any parsing code — a real `curl` against a real page, a real 404 target, and a malformed URL. That surfaced a genuine correctness trap: **Jina Reader's own HTTP status is not the target page's status** — a target 404 still comes back as an outer HTTP 200, with the real status at `data.httpStatus`. Naively trusting the outer 200 would have silently presented fallback/cached content as the live page; `normalize()` checks `data.httpStatus` explicitly and warns instead. Produces an `article` entity, a `domain` entity from the hostname, and a `HOSTED_ON` relationship between them. 18 new tests using fixture bodies copied verbatim from the real `curl` responses, not invented shapes. **Verified three ways**: unit tests, a direct live network call (`bun -e` against a real Wikipedia article — real 21,907-character extraction, correct title/entities), and a full live browser run on `/recon` (real investigation of a URL target → `jina-reader` offered and runs → real entities rendered, zero console errors). The first browser-check attempt used the wrong input field (global nav search bar instead of `/recon`'s own target field) and silently investigated a stale target — caught because the collector correctly did NOT offer itself for that domain-type target, exactly right behavior; fixed the test script, re-verified correctly. **Also fixed a stale claim found along the way**: `recon-sources.ts`'s "what external recon does not do" panel still said a Maltego CSV export "is not built yet," false since the previous milestone shipped it — corrected while keeping the still-true explanation of why a *live* Maltego transform endpoint remains architecturally impossible here. Full suite 895/895 passing (18 new), `tsc --noEmit` clean, 151 exports unchanged, `fabrication-check` unchanged at 81, lint clean.
- [x] **OSINT collector framework — Maltego export (P3), and a severe live regression found and fixed (2026-08-17)**: New `src/utils/maltego-export.ts`, `toMaltegoCsv(entities, relationships)` — a pure function producing an edge-list CSV matching how Maltego's own "Import Graph from Table" wizard builds a graph (one row per relationship, source+target entity columns each side; any entity with zero relationships gets its own standalone row rather than being silently dropped). `MALTEGO_TYPE` maps Sentinel's 13 entity types to Maltego's stock palette — best-effort, explicitly caveated as not verified against a live Maltego install (same honest treatment as the theHarvester/SpiderFoot parsers), mitigated structurally by keeping the real Sentinel type in its own column so a wrong guess is always correctable during Maltego's import wizard, never a silent loss. 13 new tests. Wired into `/graph` as an "Export to Maltego" button exporting the full entity/relationship set, not just the on-screen-capped subset. **While browser-testing this, caught a severe regression already live on `origin/main`**: the previous session's persistent-job-storage work (`jobs.ts`) statically imported `bun:sqlite` in a module client route components also import; since TanStack Start only strips `.handler()` body code from the client bundle, not top-level module code, this pulled `bun:sqlite` into the *browser* bundle, and Vite's externalized stub for a native binding with no browser shim throws the moment the import binding evaluates — every route crashed with "This page didn't load," undetected at the time because that work was verified only with `bun test`/`tsc`/direct `bun -e` checks, never an actual browser launch. Fixed by guarding `createJobStore()` on `typeof window === "undefined"` first (this codebase's existing client/server split convention) and loading `SqliteJobStore` via `require()` instead of a static import — chosen over a guarded dynamic `import()` because a bundler can still discover and bundle a reachable `import()` call inside a dead branch, where `require()` never enters the client bundle's static import graph at all. Verified server-side (`bun -e` against the real singleton, both `JOB_STORE_PATH` states) and, the check that actually matters, a full live browser run: login → real investigation on `/recon` → "View in Graph" → `/graph` renders → "Export to Maltego" produces a real CSV download with real DNS data → zero console errors. Full suite 877/877 passing (13 new), `tsc --noEmit` clean, 151 exports unchanged, `fabrication-check` unchanged at 81, lint clean (one justified `eslint-disable` for the deliberate `require()`).
- [x] **OSINT collector framework — persistent job storage + `.env.example`, 2 of 6 P2-Production items (2026-08-14)**: `jobs.ts` used to define its job store as one concrete class with no swap point. Extracted with zero behavior change into `src/utils/osint/job-store.ts` (`JobStore` interface + `InMemoryJobStore`, byte-for-byte the original logic under a new name, re-exported from `jobs.ts` so nothing importing `@/utils/osint/jobs` needed to change — the only real call-site fix was `tests/osint-jobs.test.ts`'s 14 `new JobStore()` constructions becoming `new InMemoryJobStore()`). New `src/utils/osint/job-store-sqlite.ts`: `SqliteJobStore implements JobStore` using `bun:sqlite` (a Bun built-in, no new dependency) — three tables, every complex field JSON-encoded, `progress`/`error`/timestamps staying genuine SQL `NULL` and round-tripping as `null`, never defaulted. Wired in behind `JOB_STORE_PATH` exactly like `llm.ts`'s `LLM_BASE_URL` pattern: unset keeps in-memory behavior unchanged, set to a path switches the `jobStore` singleton to SQLite with no other code touched. **Verified two ways**: 16 new unit tests including the one that actually proves persistence (write with one `SqliteJobStore` instance, close it, read with a fresh instance at the same path — literally what "survives a scale-to-zero cold start" means); and a direct manual check against the real singleton (`JOB_STORE_PATH` unset → `jobStore.constructor.name === "InMemoryJobStore"`; set → `"SqliteJobStore"`, with a real investigation immediately visible via `hasInvestigation()`). Also built `.env.example` — did not exist anywhere despite several load-bearing env vars — from a real audit of every `process.env.*` read in `src/` (including `llm.ts`'s dynamic `${prefix}_BASE_URL` construction, which a literal grep alone would have missed) cross-checked against `credential-vault.ts`'s `CREDENTIAL_PROVIDERS` registry. Every value in the file is empty; it documents names only. Added a `!.env.example` negation to `.gitignore` (the existing `.env.*` rule would otherwise have swallowed it — confirmed fixed via `git check-ignore`) and a `data/jobs.sqlite*` entry for the new optional local store. **Deliberately not attempted in the same pass**: Worker Dockerfile, local docker-compose, Azure configuration (no Docker locally, no deployed theHarvester/SpiderFoot worker to containerize, and Azure changes touch real subscription resources) and health checks (ambiguous scope against the already-existing `collector-health.ts`). Full suite 864/864 passing (16 new), `tsc --noEmit` clean, 151 exports unchanged, `fabrication-check` unchanged at 81, lint clean with zero new findings on every touched/new file.
- [x] **OSINT collector framework — `/reports` gains OSINT sourcing, closing P2-Reports in full (2026-08-14)**: Two new functions in `src/utils/reports.ts` — `sourcesFromOsintEvidence()` and `sourcesFromOsintRelationships()` — convert the P0 `CollectorEvidence[]`/`CollectorRelationship[]` shapes into the report layer's own numbered, citable `SourceRef`s, closing all four P2-Reports checklist items at once ("Include external collector results"/"Include evidence" are the same function since theHarvester/SpiderFoot produce the identical shape as every other collector; "Include relationships" is the second function; "Include timeline" needed no new code since `EVENT_TIMELINE` already chronologically orders by `publishedAt`, and OSINT evidence's real `collectedAt` slots straight in). Both land under `"Module 2 · content analysis"` — the one `ContributingModule` value no existing source function had claimed. `/reports` gained an "Include OSINT investigation" button, deliberately separate from the page's automatic news/geo `collect()` since most report subjects here are open topics, not recon targets, and running live crt.sh/Shodan/theHarvester/SpiderFoot calls on every subject change would be slow and usually fruitless — an analyst working an actual domain/IP/email opts in explicitly. Sources are appended, not merged fresh, so existing inclusion/exclusion decisions survive. **Real bug caught by browser-testing before it shipped**: a domain with real infrastructure returns 30-100+ evidence/relationship items, comfortably past `DEFAULT_SOURCE_BUDGET` — reproducing the exact HTTP-413 failure this same file's comments already document as a prior real incident, just via a second code path. First live run showed `71 of 71 included` (no trim applied to the appended sources). Fixed by computing remaining budget from the analyst's prior selections before appending and pre-excluding only the overflow; re-verified live afterward showing the correct `12 of 82 included`. A second real fabrication-guard catch while writing this: the custom `sentinel/no-fabricated-fallback` ESLint rule flagged a defensive `catch` fallback returning the literal `"(unserializable value)"` — not in the rule's recognized absence-marker vocabulary — fixed by rewording to `"(not serializable)"`, matching its `not\s+\w+` pattern. 13 new tests. **Verified live** (`example.com`): real per-collector summary shown, real honestly-surfaced collector failures rendered on screen (crt.sh 502, GDELT 429, theHarvester/SpiderFoot unconfigured), budget trim correct across two runs, and Generate with no LLM configured showed the pre-existing honest "No LLM provider configured" message rather than hanging. Zero console errors. Full suite 848/848 passing, `tsc --noEmit` clean, `fabrication-check` unchanged at 81. This closes every item in P2 — Reports.
- [x] **OSINT collector framework — `/graph` rebuilt on real data, closing P2-UI in full (2026-08-14)**: `/graph` previously rendered ten hand-placed fictional nodes ("Vector-17", "Aster Motors") behind a `SampleDataBanner`. New pure/testable logic: `src/utils/graph-layout.ts` (`layoutRadial()` — deterministic BFS-ring layout by hop distance from one root entity, no physics sim, degree-based node radius, unreachable entities placed honestly in an outer ring rather than dropped; `shortestPath()` — real BFS traversal, replacing the fixture's hand-written path narration) and `src/utils/graph-store.ts` (versioned localStorage hand-off, same pattern as `investigations-store.ts`/`active-target.ts`, one snapshot at a time). `/recon`'s `InvestigationPanel` gained a "View in Graph" button (enabled once the poll returns ≥1 entity) that saves the snapshot and navigates over. `/graph` shows an honest empty state (`EmptyState`, link back to Recon) when nothing is saved — no fallback to sample data. Full 13-value `EntityType` styling (13 evenly-spaced hues) replaces the fixture's 7 invented types. Node click shows a real detail panel (value, source collector, confidence-or-"not scored", live connection count, BFS distance from target) — the fixture's fabricated "Aliases"/"Risk score"/"First seen" fields are gone, not just relabeled. Same DOM-scale problem as the evidence-inspector milestone below applies here too: capped at 150 rendered nodes, nearest-to-target first, disclosed on-canvas. 23 new tests. **Verified live** (`google.com`): empty state confirmed pre-investigation; ran a real investigation, clicked "View in Graph," landed on a populated graph with real `RESOLVES_TO` edges to live-resolved IPs; selected the root node and confirmed real DNS-collector data in the detail panel; selected a `dorks`-collector news-article entity and confirmed the "Path to target" panel computed a real `mentioned in` path back to the root; confirmed the filter dims non-matching nodes. Zero console errors. One real, already-documented behavior surfaced, not a new bug: `pollInvestigation()` dedupes by exact id, not by value, so `dns` and `rdap` each independently producing a `domain` entity for the same value render as two nodes — value-based merging is `entity-resolution.ts`'s job, used by the batch path, not the live-polling path this UI reads from. Full suite 835/835 passing, `tsc --noEmit` clean, `fabrication-check` unchanged at 81 (one new match introduced and fixed in the same pass — a `?? 0` on a structurally-always-populated `Map.get()`, replaced with a `!` assertion). This closes every remaining P2-UI checklist item except Report generation.
- [x] **OSINT collector framework — `/recon` manual collector selection, closing P2-UI's checklist bar Graph (2026-08-14)**: `InvestigationPanel` now previews the plan (`planOsintInvestigation`, a new read-only `createServerFn` in `jobs.ts` — plans without starting anything, no job created) whenever the target changes, rendering one checkbox per candidate collector, checked by default. `startInvestigation()` gained an optional `collectorIds` parameter restricting execution to that subset (omit it, or pass every candidate, for the unchanged "run everything" default; an empty array explicitly means "run nothing," kept distinct from "no target set," which disables the button for a different, honest reason). `startOsintInvestigationJob`'s validator threads the same optional field through. 4 new tests covering the filter (subset selection, an unknown id silently ignored since the UI only ever sends ids from its own plan, empty array vs. omitted). **Verified end-to-end, not just in the UI**: an `example.com` run showed 8/8 checked by default, deselecting `news` and `shodan-internetdb` updated the count to 6/8, and the subsequent live collector-status list showed *exactly* those 6 — the two deselected collectors never appeared, confirming the filter reaches execution, not just checkbox state. Zero console errors. Full suite 812/812 passing. This closes every P2-UI checklist item except Graph navigation.
- [x] **OSINT collector framework — `/recon` evidence inspector + a real scale finding (2026-08-14)**: Closed the plan's "Evidence" item — a collapsible section under Entities lists every evidence item individually (collector badge, timestamp, source, confidence where scored, a JSON preview of `normalizedValue`, and a link to `sourceUrl` when present), the concrete answer to Rule 6/§20's "the source of every fact must remain inspectable," not just a count. **Real finding from testing against an actual large target**: a `cloudflare.com` run returned 3,461 entities — almost all genuine crt.sh-logged subdomains for a company that size, a correct result, not a bug — but rendering all of them into the DOM uncapped is a real performance/UX problem an analyst would hit on any sizeable target, the kind of thing a synthetic fixture never would have surfaced. Capped rendering at 200 items per list (`MAX_RENDERED_ITEMS`), UI-layer only — the underlying `poll.entities`/`poll.evidence` arrays stay untruncated for whatever consumes them later (a report, an export, a graph view). Verified live against `github.com` (148 entities, under the cap) with the evidence panel expanded and screenshotted; zero console errors. Full suite 808/808 passing.
- [x] **OSINT collector framework — `/recon` panel gets live progress (2026-08-14)**: `InvestigationPanel` switched from the blocking `runOsintInvestigation` to polling two new `createServerFn`s in `jobs.ts` (`startOsintInvestigationJob`/`pollOsintInvestigationJob`, mirroring `orchestrator.ts`'s existing wrapper), every 1.2s until every collector job reaches a terminal status. Badges now show `running` (spinning icon) live, not just the final state. **This is the first UI consumer `jobs.ts` has ever had** — it was fully built and unit-tested in P1 but had zero callers anywhere in the app, the identical "control with no handler" shape as the theHarvester/SpiderFoot registration bug from the milestone below, just for the entire job system instead of two collectors. Entity resolution is deliberately not applied during polling (only the synchronous path does that — resolving on every poll tick against a still-growing set would be wasted work). **Verified live** (Chrome via `playwright-core`): a `stripe.com` run was screenshotted mid-flight showing 6 collectors simultaneously in a `running` state (theHarvester/SpiderFoot were already terminal — correct, their `unavailable` check needs no network call), then again after completion showing all 8 terminal (`crtsh` failed on a live HTTP 502, `news` hit GDELT's real rate limit) with 37 entities / 30 evidence items and zero console errors. A screenshot of only the end state would not have distinguished this from the old blocking version — the mid-flight capture is what actually proves "Progress" works. Full suite 808/808 passing.
- [x] **OSINT collector framework — P2 starts: `/recon` Investigation panel, first reachable feature (2026-08-14)**: New "OSINT Investigation — multi-collector" panel on `/recon` (`InvestigationPanel` in `src/routes/recon.tsx`), following the page's existing self-contained-panel pattern exactly — one new component, one new render line, nothing else on the page touched. Backed by `runOsintInvestigation` (new `createServerFn` in `src/utils/osint/orchestrator.ts`), which registers all collectors and applies entity resolution before returning. **Found and fixed a real bug by actually testing in a browser, not just `tsc`/`bun test`**: theHarvester and SpiderFoot were fully built and unit-tested but never registered anywhere — a classic "control with no handler," the exact pattern CLAUDE.md's own fabrication-audit history warns about. `tsc`/`bun test` couldn't have caught this (both adapters' own test suites pass regardless of whether anything registers them). Fixed by adding `src/utils/collectors/external/index.ts` (mirroring `existing/index.ts`) and wiring it in; confirmed fixed by re-running the same browser test and watching the collector count go from 6 to 8. **Verified live** (Chrome via `playwright-core`, dev server, real network): a `github.com` run returned 31 entities / 28 evidence items — `dorks`/`dns`/`rdap`/`shodan-internetdb` completed, `crtsh` failed with the exact live "HTTP 503 after a retry" `recon-sources.ts` itself produces, `news` hit GDELT's real rate limit, and the merged `github.com` domain entity showed 95% confidence from 3 independent sources — a live exercise of the entity-resolution confidence model, not a fixture. Screenshotted; visually consistent with the rest of the page. One real TanStack Start integration issue hit and fixed along the way: `createServerFn`'s serialization type-checker rejects `unknown`-typed fields (the P0 contract's `metadata`/`rawValue` are deliberately `unknown`) — resolved narrowly at the server-function boundary via a `JSON.parse(JSON.stringify(...))` round-trip (a real serializability proof, not just a type-checker workaround) rather than loosening the P0 contract itself. Covers investigation-start/collector-status/results from the P2-UI checklist, partial collector-selection (automatic only) and evidence (count only); progress (job-polling UI) and graph navigation remain unbuilt. Full suite 808/808 passing throughout.
- [x] **OSINT collector framework — entity resolution, P1 now fully complete (2026-08-14)**: `src/utils/osint/entity-resolution.ts` — the piece `orchestrator.ts`/`jobs.ts` both explicitly deferred: merges same-type, same-normalized-value entities across collectors (`dns:domain:x` + `rdap:domain:x` + `crtsh:domain:x` → one entity), matching plan §17's own worked example (three collectors reporting one email → ONE entity, THREE evidence items — evidence is never touched by this file, only the entity/relationship lists). **`person` and `organization` entities are never merged by value equality, at all** — not merged-with-low-confidence, genuinely kept separate — because a shared *name* is exactly what plan §18 says must not imply identity, and a caveat on an already-merged row is a weaker safeguard than not merging in the first place. Everything else (email, domain, ip, url, username, phone, location, article, image, video, social_account) merges on exact value after type-specific normalization (email/domain/username/url get real rules; the rest trim+lowercase) — precise identifiers, a materially different kind of match than a name. Confidence scores only on "multiple independent sources" (honestly the only signal this file has access to), always with reasons, never a bare number. Relationship endpoints get rewritten to merged ids; a resulting self-loop is dropped; duplicates from the remap collapse via the existing shared dedup. Opt-in via `resolveInvestigationEntities()` — not wired into `runInvestigation()`/`pollInvestigation()` automatically. Found and fixed one real bug while testing: `normalizeUrl`'s trailing-slash strip had an off-by-one guard that protected exactly the root-path case (`https://example.com/`) it was meant to also normalize. 19 new tests. Full suite 808/808 passing. **This is the last item in plan §31's P1 list** — P1 is done in full.
- [x] **OSINT collector framework — SpiderFoot adapter, client-only (2026-08-14)**: `src/utils/collectors/external/spiderfoot.ts` — same "adapter built, no worker deployed" status as theHarvester (see the entry below), and the same non-reopening of `RECON_NOTES`'s existing SpiderFoot objection, for the same reason. Differs from every other collector in the codebase in one real way: SpiderFoot scans take minutes, not seconds, so `execute()` starts a scan then polls SpiderFoot's own status endpoint (`SPIDERFOOT_POLL_INTERVAL_MS`, default 5s) until `FINISHED`/`ERROR-*` or a bounded wait (`SPIDERFOOT_MAX_WAIT_MS`, default 2 minutes) elapses — documented as a real simplification (production scans can run considerably longer; a full integration would need the scan to survive across multiple job-system polls rather than block one call). Defaults to SpiderFoot's "passive" use-case, never active/intrusive. API shape (`/startscan`, `/scanstatus`, `/scaneventresults`) is from training knowledge, not a verified live instance — flagged the same way theHarvester's parser is. Event-type → entity mapping deliberately covers a defensible subset of SpiderFoot's several hundred event types; unmapped types stay evidence-only with a named warning, never silently dropped. 13 tests (fetch-stubbed, run 3× to rule out polling-loop flakiness). Full suite 789/789 passing. This closes out everything in plan §31's P1 list except entity resolution (§17) and UI wiring (P2) — P1's external-tool and orchestration work is done.
- [x] **OSINT collector framework — theHarvester adapter, client-only (2026-08-14)**: `src/utils/collectors/external/theharvester.ts` — the first `external/` (as opposed to `existing/`) collector. Calls an independently-deployed worker at `THEHARVESTER_WORKER_URL`; **no such worker is deployed anywhere**, so the collector honestly reports `unavailable` in every real environment today — not a hidden gap behind a checked box. This deliberately does not reopen the licensing question `recon-sources.ts`'s `RECON_NOTES` already settled ("theHarvester executed in-app" — objects to *subprocessing the GPL binary inside Sentinel's own process*): this adapter never subprocesses theHarvester, only makes an HTTP call to a separate worker, the same architecture plan §15 describes and `ai-service/` already established as a pattern this session. `RECON_NOTES` itself is untouched and still accurate. The JSON parser targets theHarvester's own documented `-f json` export format from training knowledge, not a verified live instance — flagged explicitly in the code and the plan doc as needing reverification once a real worker exists, written defensively (unexpected/missing fields degrade to "not reported," never fabricated) so a shape mismatch fails safe. Uses the plan's own recommended sources (crt.sh, CertSpotter), explicitly not `-b all`. 14 tests, all fetch-stubbed. Full suite 776/776 passing.
- [x] **OSINT collector framework — P1 job system (2026-08-14)**: `src/utils/osint/jobs.ts` — the async, pollable sibling of `orchestrator.ts`'s synchronous `runInvestigation()`. `startInvestigation()` plans and creates one `InvestigationJob` per selected collector, starts each without awaiting it (returns immediately, matching plan §12: external tools "must not run inside a normal browser request for an extended period"); `pollInvestigation()` aggregates completed jobs' results (`GET /investigation/:id`'s shape, as a plain function — not a route). Extracted `dedupeEntitiesById`/`dedupeRelationships` out of `orchestrator.ts` into a new shared `osint/merge.ts` so both execution paths dedupe identically. Three limits documented in the code and the plan doc rather than left implicit: persistence is in-memory/per-process only (same accepted tradeoff as `llm.ts`'s cache — needs real storage, §16, before production use); "queued" is near-instant for P1's own collectors since none of them hand off to an external worker yet; cancellation cannot abort an in-flight request because `Collector.execute()` takes no `AbortSignal` — `cancelJob()` marks a job cancelled and discards its result once the underlying (uncancellable) fetch eventually resolves, verified by a dedicated test. 9 new tests, including the cancellation-discard behavior and an injectable-timeout test (fast — doesn't wait on the real 60s default), run 3× to confirm no timing flakiness. Full suite 762/762 passing.
- [x] **OSINT collector framework — P1 orchestrator + query planner (2026-08-14)**: `src/utils/osint/query-planner.ts` (`detectTargetType`: precedence-ordered IP/URL/email/domain/phone classifier, ambiguous bare-word/free-text input returns both `person` and `username` as candidates rather than guessing one; `planInvestigation`: selects registered collectors by `supportedTargetTypes` across all candidate types, deduped) and `src/utils/osint/orchestrator.ts` (`runInvestigation`: runs every planned collector's `execute()`+`normalize()` in one `Promise.all`, merges entities/relationships/evidence/warnings/errors, exact-id-only entity dedup). Deliberately does NOT do: the Job system (§12, everything runs synchronously in-process, no queue/polling), cross-collector semantic entity merging (§17 Entity Resolution — `dns:domain:x` and `rdap:domain:x` both surface as separate entities on purpose, documented in the code and the plan doc rather than silently left thin), or auto-registration into the global `collectorRegistry` (a caller must call `registerExistingCollectors()` first, so isolated test/future registries never get real network-calling adapters silently added). 22 new tests against isolated stub registries — no real network call in either test file. Full suite 753/753 passing.
- [x] **OSINT collector framework — P0 + P1 existing adapters (2026-08-14)**: Implementing `docs/OSINT-INTEGRATION-PLAN.md` in the order it prescribes (Rule 3: one architectural layer per task). **P0** — `src/utils/collectors/{types,result,errors,registry,index}.ts`: the `Collector` contract, zod-validated `InvestigationResult` model (entities/relationships/evidence/warnings/errors/metadata/execution), typed `CollectorError` (Rule 5: failures carry `status/reason`, never collapse to an empty result), and an empty `collectorRegistry`. **P1 — existing adapters**, `src/utils/collectors/existing/{dorks,dns,rdap,crtsh,shodan-internetdb,news,social}.ts`: six wrap an existing exported function verbatim (`collectCrtShSubdomains`, `resolveA`/`internetDb` newly exported from `attack-surface.ts`, `fetchNewsDorkHits` extracted from `dorks.ts`'s `runNewsDork`, `collectNewsGeo`, three `social.ts` fetchers) with zero behavior change to any of them; RDAP is a new implementation against the same free `rdap.org` endpoint `routes/news.tsx`'s inline WHOIS tab already validated, because extracting *that* would have meant editing a route file (deliberately out of scope). Building real adapters surfaced a genuine P0 contract gap — `normalize()` needs `execution` (part of `InvestigationResult`) but only `execute()` computes it — fixed by changing the signature to take the whole `CollectorRunOutcome` before any adapter was written against the broken version, not patched around it seven times. 47 new tests, full suite 731/731 passing, `tsc --noEmit` clean. Auth/RBAC from the earlier `MERGE_PACKAGE` merge stays deliberately excluded (see the entry below); nothing here reopens that decision. **Not done**: orchestrator, query planner, job system, theHarvester/SpiderFoot workers, entity resolution, UI — all P1-remainder/P2/P3, not started.
- [x] **`ai-service/` Python vision/forensics backend merged in (2026-08-14)**: A teammate's independently-developed FastAPI backend was merged from a `MERGE_PACKAGE/` (now deleted after merge — its content is preserved in this entry and in `CLAUDE.md`'s own `ai-service/` section). New top-level directory `ai-service/`, its own venv/`requirements.txt`/`Dockerfile`, deploying separately from the frontend. Real endpoints: `POST /ai/forensics` (EXIF incl. GPS location, pHash, C2PA best-effort — a Python-side re-implementation of the same techniques as `imaging.ts`, not a replacement for it), `POST /ai/ocr` (Tesseract), `POST /ai/phash/compare`, `POST /ai/detect` (Grounding DINO tiny, Apache 2.0, zero-shot object detection — the exact model this project's own licence-trap warning names as the correct choice over YOLO). Still 501 stubs: `/ai/faces`, `/ai/video`, `/ai/transcribe`, `/ai/translate`, `/ai/describe`, `/ai/chat`. **Verified in this environment**: all 8 `test_forensics.py` tests and 4/5 `test_skeleton.py` tests pass under a fresh venv with only the pure-Python dependencies installed. **Not verified here** (missing system Tesseract binary, and `torch`/`transformers`/vendored Grounding DINO weights deliberately not installed — multi-GB download, no GPU in this environment to exercise it on): the OCR and detect endpoints' own test files. Known real limitation carried forward: Grounding DINO returns confident false positives for absent objects, so `/ai/detect` output must be treated as an unverified candidate match, never a confirmed finding, until a UI surfaces it. **Deliberately excluded from the same merge**: a session-based auth/RBAC system (Prisma+SQLite) that was in the same source package — this project already built and deliberately reverted an auth system out of `main` on 2026-08-06 (see `backup/pre-auth-rollback` branch/tag below); re-adding it is a product decision, not something to fold in silently. No frontend code calls `ai-service/` yet — that integration is unstarted, not regressed.
- [x] **Collection-policy model + media ingestion + manual capture (2026-08-12)**: Implemented the ingestion-legality matrix across Module 3. `PLATFORM_NOTES.available` was a **boolean**, rendered as a green "collected" / red "unavailable" badge, which could not express "YouTube text yes, frames no" (so YouTube had no row at all), could not express "Meta not automated but an analyst may capture", and gave a ToS prohibition and a missing free tier the same red badge. New `src/utils/collection-policy.ts` adds four modes (`automated` / `partial` / `manual-only` / `none`), five legal bases, and the ingestion route per source; `policyId` links each platform note to its row, additively — `available` is untouched because three test files assert on it. **Media ingestion closed** for Bluesky, Reddit, Telegram and Mastodon (`SocialPost.media`, five extractors), with an Analyse hand-off into Module 4 via a new validated `?url=` param on `/images`. **Manual capture path** added for Meta (`manual-evidence.ts` + `components/manual-capture-panel.tsx`), writing to the same `sentinel_evidence` store `/vault` reads. **YouTube comments** added via the official Data API v3, behind a new `youtube` vault provider with a live verification probe. **625 unit tests passing** (+58), **`tsc --noEmit` clean**, **151 core exports verified**, `bun run build` green. Two pre-existing defects fixed in passing — see below.
- [x] **Browser-audit remediation, Phases 1, 2 and 4 (2026-08-12)**: Six agents drove all 31 routes in real Chrome, clicking every control on a fresh page load. The finding: the analytical core is sound and the presentation layer was not.

  **Phase 1 — `0ab3d44`, fabrication removal.** Verified absent from the SERVED HTML, not just the source. `/live` was discarding real article text and substituting invented Spanish, French and Hindi prose attributed to El Pais, Le Monde and Dainik Jagran — the code comment read "Simulating different languages based on index" — with platform, handle, location and credibility all manufactured from the array index, so Google News RSS rendered as X/Twitter posts while `/social` correctly declared X uncollectable. `/osint` carried five WHOIS/DNS literals ("GoDaddy", nameservers, an A record), a hardcoded "Aggregate confidence 74/100" sitting beneath six genuinely-derived counts, `status || "online"` rendering an unmeasured indicator as a live C2 beside a pulsing green dot, and `return 4290` as the unconditional OpenSky error value. `/agents` fed three hardcoded Jerusalem coordinates into the focal-point detector and printed the result as convergence analysis. `/tasks` badged all five modules "Nominal / Verified" on a compliance console, including two the same page's self-test called NOT IMPLEMENTED. **`<Toaster />` was never mounted**, so all 30 `toast.*` call sites were silent — including the vault path that rejects evidence when SubtleCrypto is unavailable, which failed invisibly.

  **Phase 2 — `e564b60`, correctness in working features.** Module 1 was rating `news.google.com` for every article, because a queried corpus comes from the Google News search feed whose links are all redirects; `src/utils/rss-source.ts` recovers the real publisher from the `<source url>` attribute in the raw XML, which rss-parser discards (verified live: 104 items, 104 index-aligned slots, 10 distinct publishers). TF-IDF ran over raw HTML and reported `nbsp`, `href` and `6f6f6f` among its dominant terms. The GPS and radiation collectors ran in the BROWSER, were CORS-blocked, and swallowed the failure into a permanent "Loading…"; the GPSJam endpoint also did not exist — it publishes a daily CSV of H3 cells, now parsed with `h3-js` (3,425 real cells). Spike detection bucketed on author-declared `createdAt`, running a median 2.8 hours behind, so `SocialPost.observedAt` records arrival instead. `validateCitations` accepted "Corroborated by two sources" while citing one.

  **Phases 3-4 — `c96912f` and `f3a21e0`.** EXIF capture time was run through `new Date(...).toISOString()` over a timezone-naive camera clock, applying the analyst machine's offset and appending a Z; `readExifCaptureTime` keeps the wall clock and fills `absolute` only when the file records a real offset. `/watchlists` had zero controls while importing six unused symbols. `/alerts` rendered 178 characters with no empty state. `/graph` had eight dead controls and its sample banner nested inside a button. The notification bell had no handler and a permanent unread dot. The evidence vault carried three invented SHA-256 digests — one of them 66 hex characters, not a SHA-256 at all, and unnoticed until now.

  **567 unit tests passing**, **`tsc --noEmit` clean**, **123 core exports verified**, `bun run build` green.

- [x] **YouTube module repaired — InnerTube rewrite (2026-08-12)**: Every panel on `/youtube` was failing at once and looked like one fault; it was three. (a) `@distube/ytdl-core@4.16.12` can no longer parse YouTube's player script ("Could not parse decipher function"), so metadata degraded to oEmbed and showed Unknown duration/views/date, and downloads died on "Failed to find any playable formats". (b) Both subtitle strategies called the **unsigned** `api/timedtext` endpoint, which now returns HTTP 200 with a **zero-length body** — they could never have succeeded for any video. (c) `&fmt=vtt` is ignored by YouTube, so the one strategy that did fetch captions ran a WebVTT parser over `<timedtext format="3">` XML, found nothing, and reported "no subtitles available" for 93,199 bytes of captions. Rebuilt on the InnerTube `player` endpoint (see the architecture note above), added `parseTimedTextXml`/`parseSubtitleBody`, and removed two fabrications: a hardcoded `available_subtitles` English entry and an invented "age-restricted or region-locked" cause printed on every download failure. Also removed the unused `export default` from `timeline.tsx` and `tasks.tsx`, which was the source of the router's code-split warnings on every page load. **567 unit tests passing** (+56), **`tsc --noEmit` clean**, **123 core exports verified**, `bun run build` green.
- [x] **Credentials Vault wired to the collectors (2026-08-12)**: The Settings page was a write-only box — it saved `data/credentials.json` and nothing in the system ever read it, so an operator could add a key, watch it save, see it badged "Active", and collect exactly as much as before. New `src/utils/credential-vault.ts` is now the store the collectors resolve from, with a nine-provider registry, env-first resolution, real per-provider verification probes, masked listing plus a separate reveal call, and a computed capability matrix. Two fabrications removed: `status: "Active"` written at save time for an untested secret (now `unverified` until a live call says otherwise, and legacy `"Active"` rows are read back as `unverified`), and `lastUsed: "Never"` stored as data (now `null`). **New collection unlocked:** authenticated Bluesky `searchPosts` (`fetchBlueskySearch`) — historical keyword search, previously listed as a stated limitation because it 403s unauthenticated — and authenticated Mastodon `api/v2/search` (`fetchMastodonSearch`), reaching posts that carry no hashtag. Reddit, UCDP and GitHub now resolve from the vault as well as the environment. **511 unit tests passing** (+41), **`tsc --noEmit` clean**, **113 core exports verified**, `bun run build` green. Two pre-existing defects fixed in passing — see the note below.
- [x] **YouTube Ingestion for OSINT & Social Intelligence (2026-08-11)**: Implemented full YouTube video ingestion with a Python FastAPI backend (`yt-dlp` Python API) and a TanStack Start frontend route (`/youtube`). Includes URL host validation (`youtube.com`/`youtu.be`), metadata extraction without video download, subtitle timestamp segment parsing (`[{start, end, text}]`), analyst-initiated single-video MP4 artifact download into `YT_DOWNLOAD_DIR` with audit logging, privacy-mode embed player (`youtube-nocookie.com`), clickable timestamp seeking, handoff to video analysis pipeline (`/videos`), 5 Python unit tests passing (`pytest tests_py/`), 470 JS/TS unit tests passing (`bun test`), 90 core exports verified, and `tsc --noEmit` clean.
- [x] **v1 Feature & Intelligence Merge (2026-08-11)**: Merged missing working functions, APIs, resources, OSINT tools, agents, crawlers, and GIS data sources from `social-media-ai-agents-` (v1) into `v2`. Added real-time GPS jamming feed (`gps-interference.ts`), environmental radiation monitoring network (`radiation.ts`), CISA KEV cyber intelligence (`cyber-intel.ts`), social velocity & posting volume spike calculator (`social-velocity.ts`), Telegram topic classifier (`telegram-intel.ts`), multi-domain threat classifier (`threat-classifier.ts`), spatio-temporal focal point convergence engine (`focal-point.ts`), OSINT route updates, and collector health probes. **470 unit tests passing**, **85 core exported symbols verified**, **`tsc --noEmit` clean**.
- [x] **Fabrication sweep + gate repair (2026-08-11)**: Removed the last three fabricated outputs — `osint.tsx`'s invented RSS fallbacks (real outlet names, current timestamps), its six hardcoded Overview cards ("3 repos leak internal endpoints"), and `tasks.tsx`'s synthetic Module 1 probe with its `50` / `0.5` defaults. Also fixed a live `ReferenceError` on the Tasks page, and an entity-key regex covering only U+0900–U+0DFF that silently merged every Urdu entity name into one. `tsc --noEmit` clean for the first time; lint 10,051 → 224 problems (all `no-explicit-any`). New `src/utils/osint-summary.ts` + 21 tests; `fromSocialPost` now refuses a platform the frozen contract does not define rather than remapping it.
- [x] **Container & Azure Deployment Drift Resolution (2026-08-10)**: Replaced broken v10 auth drift with demo session (`src/utils/demo-session.ts`). Live version has since moved on — see the deployed-state note above.
- [x] **Data Contract Freeze (2026-08-06)**: Six inter-developer boundary types frozen in `src/types/core.ts` (Article, Post, Entity, Finding, MediaAsset, VideoAsset) + adapters in `src/types/core-adapters.ts`.
- [x] **Module 1 (Source Credibility)**: Synchronous scoring in `credibility.ts`, 7 PS-18 factors, language marker assessment in `credibility-llm.ts`.
- [x] **Module 2 (Open-Source Content Analysis)**: Topic clustering, stance detection, entity extraction in `analysis.ts` & `analysis-llm.ts`.
- [x] **Module 3 (Social Media Analysis)**: Bluesky Jetstream WS, public AppView, Reddit OAuth, Mastodon hashtag timelines, Telegram preview, CIB signal detection in `cib.ts` & `social.ts`.
- [x] **Module 3 Collection Integrity (2026-08-10)**: Reddit migrated to OAuth after unauthenticated access started returning 403 everywhere; Mastodon added as a keyless second open feed; the fabricated Instagram/Facebook cache and both fake scraper scripts removed; `/crawlers` replaced its invented throughput figures with a live reachability probe.
- [x] **Module 4 (Media Analysis & Provenance)**: C2PA manifest verification, EXIF parsing, Tesseract OCR, DCT pHash in `imaging.ts` & `imaging-client.ts`.
- [x] **Module 5 (Reports & GIS)**: Provider-agnostic LLM client (`llm.ts`), citation validator, PDF export, UCDP/USGS/GDELT integration in `reports.ts`, `geo.ts`, `geo-sources.ts`.
- [x] **Project Memory & Preservation System (2026-08-10)**: Created `PROJECT_MEMORY.md`, `.claude/rules/memory-and-preservation.md`, updated `CLAUDE.md`, and added `scripts/check-exports.ts`.

### Two pre-existing defects fixed on 2026-08-12

Both were found while wiring the vault and both silently disabled a safety net.

1. **`.gitignore` was ignoring the entire repository.** Commit `d935aef` ("ignore root
   `*.js`") appended the pattern as **UTF-16LE**, so the bytes on disk were
   `* \0 . \0 j \0 s \0`. Git parses the line up to the NUL and reads the pattern as bare
   **`*`** — every untracked file in the tree, matched. Since that commit no new file could
   be `git add`ed without `-f`, including the two added here. Replaced with a correct
   `/*.js`. **If a new source file ever seems to vanish from `git status`, check this line
   first.**
2. **`scripts/check-exports.ts` had failed on every run since the YouTube feature landed.**
   It required `fetchYoutubeMetadata`, `fetchYoutubeSubtitles` and `downloadYoutubeVideo`
   from `youtube-collector.ts`, which has never exported those names — the public symbols
   are the `serverFetch*` / `serverDownload*` `createServerFn` wrappers over private
   `_getMetadata` / `_getSubtitles` / `_getDownloadUrl`. A permanently red gate is worse
   than no gate: a real deletion would have hidden among those three. Registry corrected;
   the audit now passes at 113 symbols.

### Collection policy — the ingestion-legality matrix (2026-08-12) — READ BEFORE ADDING A COLLECTOR

`src/utils/collection-policy.ts` is the single source for **what may be collected, on what basis,
and by what route**. It supplements `PLATFORM_NOTES` (which answers "does this deployment collect
it"); the two answer different questions and both are needed.

| Source | Mode | Basis | How content gets in |
| --- | --- | --- | --- |
| Instagram, Facebook | `manual-only` | Platform ToS + DPDP Act 2023 | Analyst captures a public post and attests to it |
| YouTube | `partial` | Official API + ToS | API for metadata/comments/captions; **frames only via analyst-initiated download** |
| News (RSS), GDELT, HN | `automated` | Syndication by design | Already automated |
| Reddit, Telegram, Bluesky, Mastodon | `automated` | Official/public APIs | Text and **media URLs** |
| X / Twitter | `none` | No free tier | Nothing automatic — a commercial limit, not a legal one |

- **`allowsAutomatedCollection()` returns `false` for an unknown source.** Absence of a policy is a
  gap to close, never a licence. Do not invert this.
- **Media is collected as URLs, never bytes.** Re-hosting is redistribution, and under the DPDP Act
  these are images of identifiable people. Bytes are fetched only when an analyst sends one asset to
  Module 4.
- **`SocialPost.media` — `undefined` means NOT COLLECTED, `[]` means collected-and-none.** Load
  bearing. A contract-sourced post leaves it `undefined`; see `CONTRACT_MEDIA_LIMITATION` in
  `core-adapters.ts` for why the frozen `Post` is not gaining a media field.
- **Manual captures are `AttestedCapture`, never `SocialPost`.** Fixed marker
  `provenance: "analyst-attested-capture"`, mandatory source URL / capturer / capture time, and they
  must never be counted in volume, rate or coordination signals. This is the exact distinction v1's
  `agent_scraper.py` collapsed when it wrote fabricated Instagram posts into the real collectors'
  cache.

**Payload shapes verified live 2026-08-12 — two do not match the documentation:**

- **Bluesky ships `app.bsky.embed.gallery`** (up to 10 images) whose fields are `items[].thumbnail`,
  *not* the `images[].thumb` of the older `images` embed. An extractor written from the documented
  shape silently drops every carousel post. Also note the raw Jetstream record stores blobs as CIDs
  (compose `cdn.bsky.app/img/feed_fullsize/plain/{did}/{cid}` — verified HTTP 200 image/webp) while
  the AppView returns resolved URLs; both paths exist and must not be merged.
- **A t.me page carries ~85 `background-image` declarations of which ~4 are post photos** — the rest
  are avatars and emoji. The selectors are class-scoped to `tgme_widget_message_photo_wrap` and
  `tgme_widget_message_video_thumb`; an unscoped regex reports a channel avatar as evidence.
- **Reddit's shape is the one NOT verified live** (no OAuth credential in this environment). Its
  fixture is hand-built. Confirm against a real response once a script app is registered.

### Two more pre-existing defects fixed on 2026-08-12

1. **Telegram posts were misattributed.** `fetchTelegramChannel` scanned the page three times into
   parallel `ids` / `texts` / `times` arrays and zipped them by index. Any message without a text
   block — i.e. every photo-only post — shifted all later text up one slot, so a channel posting
   `[text A][photo][text B]` rendered post 2 carrying **text B** under the photo's id, URL and
   timestamp. Confirmed live on `t.me/s/durov`, where `durov/522` is media-only. Replaced with
   `splitTelegramMessages` (slices on `data-post="` boundaries) + `telegramBlockToPost`, so every
   field of a message stays together — which is also the only way media can attach to the right post.
2. **`/images` had no `validateSearch`.** The new Analyse hand-off would have navigated and done
   nothing. Added, and it rejects anything that is not an absolute `http(s)` URL, so a crafted
   `javascript:` or `data:` param cannot reach the fetch.

### Pending Backlog / Roadmap

0. **Obtain the Reddit credential** — free script app at reddit.com/prefs/apps. Reddit
   collection is dead without it. **No longer needs a redeploy**: enter the client ID and
   secret on `/settings` and press Verify. `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` stay
   the durable path, and still take precedence.
1. **Obtain a Bluesky app password** — the largest single collection gain available, and
   free. It turns Bluesky from forward-only firehose monitoring into historical keyword
   search. Same route: `/settings` → Bluesky → Verify.
2. **Module 1 Enhancement**: Persist custom weight profiles to a backend API (currently localStorage `sentinel_credibility_profiles`).
3. **Module 5 GIS Enhancement**: ~~Add UCDP API Token configuration UI~~ — **done 2026-08-12**, the token is a vault provider. Still needs the token itself from ucdp.uu.se.
4. **Vault durability**: `data/` is not a mounted volume and is excluded from the build
   context, so a vault credential dies with the replica on Container Apps. Fine for a demo;
   a real deployment needs Key Vault (which the env path already uses) or a mounted secret.
5. **vLLM Self-Hosted Migration**: Prepare config switch once Azure NC8as-T4 GPU quota is approved.

---

## 2. Non-Destructive Update Protocol (Anti-Deletion Rules)

> [!CAUTION]
> **NEVER DELETE EXISTING EXPORTED FUNCTIONS OR TYPES.**
> Partial updates using snippet views frequently lead AI models to replace entire files with small code snippets, wiping out existing functions. Follow these rules on EVERY edit.

### Rule 1: Full Context Verification Before Editing

- Before editing any file in `src/utils/`, `src/types/`, `src/routes/`, or `tests/`, view the entire file or target function block.
- Identify all existing `export function`, `export const`, `export type`, and `export interface` statements.

### Rule 2: Additive-Only Extensions

- **Never rename or remove an exported symbol** without explicit user instruction and project-wide refactoring.
- When expanding functionality:
  - Add optional parameters to existing signatures (e.g. `opts?: NewOptions`).
  - Add new helper functions alongside existing functions.
  - Wrap logic rather than replacing existing function signatures.

### Rule 3: Export Registry Audit

- Run `bun scripts/check-exports.ts` before committing code updates to ensure no public exports were dropped.

### Rule 4: Mandatory Post-Edit Verification

- Run `bun test` after EVERY modification. If any of the 415+ tests fail, fix the breakage immediately before reporting completion.

---

## 3. Codebase Inventory & Export Registry

This registry lists key files and their exported symbols. When adding features, verify that these exports remain intact.

### Core Types & Seams (`src/types/`)

- **[core.ts](file:///d:/social_media_research/src/types/core.ts)**: Frozen boundary contracts (`ArticleSchema`, `PostSchema`, `EntitySchema`, `FindingSchema`, `MediaAssetSchema`, `VideoAssetSchema`, `ContractViolationError`, `parseMany`).
- **[core-adapters.ts](file:///d:/social_media_research/src/types/core-adapters.ts)**: Seam adapters (`toAnalysisArticle`, `fromAnalysisArticle`, `toSocialPost`, `fromSocialPost`, `toGeoPoint`, `PostDegradation`, `CONTRACT_MEDIA_LIMITATION`).
  - `degraded[]` means "the producer could have supplied this and did not", which is why a fully populated fixture must report **zero** entries. Media is deliberately NOT in that list — the frozen `Post` has no media field, so no producer can ever supply it; flagging it per post would make the list describe the seam rather than the record. It is stated once as `CONTRACT_MEDIA_LIMITATION`.

### Intelligence & LLM Layer (`src/utils/`)

- **[llm.ts](file:///d:/social_media_research/src/utils/llm.ts)**: Open-source LLM client speaking OpenAI format.
  - Exports: `chat`, `chatJson`, `summariseText`, `extractEntitiesFrom`, `assessLanguageOf`, `getLlmStats`, `llmStatsSnapshot`, `LlmUnavailableError`.
- **[osint-summary.ts](file:///d:/social_media_research/src/utils/osint-summary.ts)**: OSINT Overview collection summary, pure half. Lives here rather than in `routes/osint.tsx` because a route file calls `createFileRoute` at module load and so cannot be imported by `bun test` — which is why the hardcoded cards it replaces went uncaught for so long.
  - Exports: `buildOverviewModules`, `rssEmptyReason`, `formatFeedDate`, `OverviewModule`, `OverviewTone`, `OverviewInput`, `RssCollection`.
- **[credibility.ts](file:///d:/social_media_research/src/utils/credibility.ts)**: Module 1 deterministic scoring.
  - Exports: `scoreArticle`, `scoreCorpus`, `defaultFactors`, `TIER_SCORES`, `DOMAIN_REPUTATION`.
- **[credibility-llm.ts](file:///d:/social_media_research/src/utils/credibility-llm.ts)**: Module 1 linguistic factor via LLM.
  - Exports: `assessArticleLanguage`, `assessLanguageFor`, `assessmentSummary`.
- **[credential-vault.ts](file:///d:/social_media_research/src/utils/credential-vault.ts)**: The credential store the collectors resolve from, and the backend of `/settings`. Resolution order is **environment first, vault second** — Key Vault `secretref:` env vars are the audited path and must not be shadowed by a file on an ephemeral replica. `status` is measured by a live call, never asserted at save time; a non-collectable provider (Instagram, Facebook) is permanently `unusable` and can never be verified.
  - Exports: `CREDENTIAL_PROVIDERS`, `CredentialVaultError`, `STATUS_LABELS`, `providerById`, `normaliseStatus`, `normaliseEntry`, `normaliseVault`, `maskSecret`, `secretTail`, `redactEntry`, `redactVault`, `normaliseHost`, `readVault`, `writeVault`, `resolveCredential`, `recordCredentialUse`, `verifyProviderCredential`, `buildCapabilityMatrix`, `githubHeaders`, plus the server functions `listCredentialProviders`, `listCredentials`, `addCredential`, `deleteCredential`, `revealCredential`, `verifyCredential`, `capabilityMatrix`.
  - `writeVault` replaces the **whole** file, so a stale client (an old tab, a page loaded before another was edited) can submit a vault that drops entries it never knew about. It therefore copies the previous generation to `data/credentials.prev.json` before each overwrite — ignored by `.gitignore` and covered by `.dockerignore`'s wholesale `data/` rule. **If a credential disappears from `/settings`, look there first.**
  - **Do not re-add an Instagram or Facebook collector behind these entries.** The bottom of the file records exactly what v1's `agent_scraper.py` / `agent-scraper.js` did with these same rows — instaloader login, then a Google-News-RSS fallback relabelled as Meta posts, then hardcoded posts with 842 and 420 likes. That decision is settled.
- **[collection-policy.ts](file:///d:/social_media_research/src/utils/collection-policy.ts)**: The ingestion-legality matrix — see the dedicated section above. Answers "may this be collected, on what basis, by what route"; `PLATFORM_NOTES` answers "does this deployment collect it". **`allowsAutomatedCollection()` returns `false` for an unknown source — absence of a policy is a gap, not a licence.**
  - Exports: `COLLECTION_POLICIES`, `MODE_LABELS`, `BASIS_LABELS`, `BASIS_DETAIL`, `policyFor`, `policyById`, `allowsAutomatedCollection`, `policySummary`, `CollectionMode`, `LegalBasis`, `CollectionPolicy`.
- **[manual-evidence.ts](file:///d:/social_media_research/src/utils/manual-evidence.ts)**: Analyst-attested capture — the ONLY route by which Instagram/Facebook content enters. Deliberately **not** a `SocialPost` and **not** a contract `Post`: a collected post is an observation, a screenshot is an observation of a screen whose source is the analyst. Crosses to Dev 1 as a `MediaAsset` with `source: "analyst upload — <url>"`, so `PlatformSchema` never has to widen.
  - Exports: `AttestationError`, `CAPTURE_PLATFORM_LABELS`, `CAPTURE_CAVEATS`, `ATTRIBUTION_LIMITATION`, `isPublicPostUrl`, `buildAttestedCapture`, `attestedCaptureToMediaAsset`, `AttestedCapture`, `CapturePlatform`.
  - `attestedCaptureToMediaAsset` **throws** when `phash` is null rather than inventing one — a synthesised perceptual hash matches nothing, which renders as "no near-duplicates found", a finding from a value never measured.
- **[evidence.ts](file:///d:/social_media_research/src/utils/evidence.ts)**: `sha256OfFile` extracted from `routes/vault.tsx` so the vault and the capture panel hash identically. Refuses rather than falling back when SubtleCrypto is unavailable — this digest was once 64 random hex characters.
  - Exports: `EvidenceIntegrityError`, `sha256OfFile`, `bytesToHex`, `isSha256`, `HASH_MEANING`.
- **[evidence-store.ts](file:///d:/social_media_research/src/utils/evidence-store.ts)**: The single owner of `sentinel_evidence`. That key had TWO writers with two independently-declared shapes — `routes/vault.tsx` (inlining the literal three times) and `components/manual-capture-panel.tsx`, whose own comment admitted it: *"Local mirror of vault.tsx's stored shape."* Same duplication `evidence.ts` was extracted to prevent for hashing.
  - Exports: `EVIDENCE_KEY`, `EvidenceRecord`, `withoutSeeded`, `getEvidence`, `saveEvidence`, `appendEvidence`, `deleteEvidence`, `setEvidenceCase`, `nextEvidenceId`.
  - **`withoutSeeded` drops only `seeded: true` rows.** The three that shipped carried `caseId: "INV-2041"` / `"INV-2038"` — ids `createInvestigation` can never mint, since it numbers from INV-1001 up — so every one rendered a bold blue case reference resolving to nothing. It **migrates rather than wipes**: the same key holds real analyst uploads and attested manual captures.
  - **`nextEvidenceId` never reuses an id.** The route computed `EVID-0${400 + list.length + 1}`, so deleting one record and adding another produced two exhibits under one identifier — in the one store whose purpose is identifying exhibits.
- **[bookmark-store.ts](file:///d:/social_media_research/src/utils/bookmark-store.ts)**: The `/live` shortlist. v1 was a bare `string[]` of URLs that **no file in the repo ever read back**, discarding publisher, date, headline and body — so a bookmark could never be reconstituted into `PinnedEvidence`.
  - Exports: `BOOKMARK_KEY`, `Bookmark`, `BookmarkInput`, `migrateBookmarks`, `getBookmarks`, `saveBookmarks`, `isBookmarked`, `toggleBookmark`, `removeBookmark`, `setBookmarkCase`, `shortlisted`, `pinnedBookmarks`.
  - **Migration back-fills NOTHING.** A v1 record keeps its URL and reports every other field as `null`, because v1 genuinely did not store them. Inventing a headline or date at migration time would manufacture provenance.
- **[live-filters.ts](file:///d:/social_media_research/src/utils/live-filters.ts)**: The `/live` date window, extracted so the predicate is testable — a route module calls `createFileRoute` at load and cannot be imported by `bun test`.
  - Exports: `DATE_WINDOWS`, `DEFAULT_WINDOW_ID`, `DateWindow`, `windowHours`, `withinWindow`, `WINDOW_REACH_NOTE`.
  - **An undated item passes every window**, deliberately — dropping it would delete real reporting over a field the publisher never supplied. **An unknown window id fails open.** "Any time" is `hours: null`, a real window rather than a missing key the predicate happened to no-op on.
- **[graph-build.ts](file:///d:/social_media_research/src/utils/graph-build.ts)**: Module 2's entity co-occurrence graph. Replaces a fixed ten-node topology written into `routes/graph.tsx` with literal x/y coordinates.
  - Exports: `ENTITY_TYPES`, `normaliseEntityType`, `entityKey`, `buildEntityGraph`, `degreeCentrality`, `shortestPath`, `layoutGraph`, `nodeRadius`, `COOCCURRENCE_CAVEAT`, plus the `GraphNode` / `GraphEdge` / `EntityGraph` / `PositionedNode` types.
  - **`layoutGraph` is deterministic** — Fruchterman–Reingold seeded **on a circle by index**, never randomly. A graph that reshuffles between renders cannot be cited, and `Math.random()` is banned in this layer. Hand-written rather than adding d3-force or cytoscape, the same call as the DCT hash in `imaging.ts`.
  - **`entityKey` moved here from `entities.tsx` unchanged.** Read its comment before touching it: the old class covered U+0900–U+0DFF only, so every Urdu name (Arabic script) was stripped to an empty key and merged into one node.
  - **No betweenness, no modularity, no "avg. degree".** Degree over a graph we built is computable and is shown; modularity needs a walked follow graph this system does not have. `network.tsx:372-377` records what happened last time one was printed anyway.
  - `COOCCURRENCE_CAVEAT` must stay on screen: an edge means two entities were named in the same article, and **nothing more**. A node-edge diagram is very good at making a weak claim look strong.
- **[social.ts](file:///d:/social_media_research/src/utils/social.ts)**: Module 3 collection & monitors.
  - Exports: `eventToPost`, `monitorMatches`, `assessSpike`, `bucketise`, `readMonitor`, `fetchProfile`, `fetchProfiles`, `fetchAuthorFeed`, `redditCredentials`, `resolveRedditCredentials`, `resetRedditToken`, `fetchRedditSearch`, `fetchTelegramChannel`, `fetchBlueskySearch`, `resetBlueskySession`, `fetchMastodonTag`, `mastodonStatusToPost`, `fetchMastodonSearch`, `stripMastodonHtml`, `mastodonLinks`, `MASTODON_INSTANCES`, `MASTODON_DEFAULT_INSTANCE`, `socialMastodon`, `socialBlueskySearch`, `socialMastodonSearch`, `socialCredentials`, `PLATFORM_NOTES`, `SocialUnavailableError`, `blueskyMediaFromRecord`, `blueskyMediaFromView`, `redditMediaFrom`, `telegramMediaFrom`, `mastodonMediaFrom`, `splitTelegramMessages`, `telegramBlockToPost`, `SocialMedia`.
  - **`SocialPost.media`: `undefined` = NOT COLLECTED, `[]` = collected and none.** Load bearing; do not collapse. Media is collected as **URLs only, never bytes** — re-hosting is redistribution and these are images of identifiable people under the DPDP Act.
  - `redditCredentials()` stays **synchronous and env-only** — call sites depend on that and its tests pin it. `resolveRedditCredentials()` is the async superset the collector uses, which also reads the vault.
  - **Removed 2026-08-10 (deliberate, not a regression):** `socialCache`. It read `data/social_cache.json`, whose only writers were `scripts/agent-scraper.js` and `scripts/agent_scraper.py` — both fabricated Instagram/Facebook posts with `Math.random()` engagement counts. All 128 records were invented. Both scripts and the reader are deleted; do not restore them (see §4 rule 2).
- **[collector-health.ts](file:///d:/social_media_research/src/utils/collector-health.ts)**: Live reachability probe for every collector endpoint (replaces the invented `/crawlers` telemetry).
  - Exports: `probeCollectors`, `collectorHealth`, `CollectorProbe`, `ProbeStatus`.
- **[cib.ts](file:///d:/social_media_research/src/utils/cib.ts)**: Module 3 Coordinated Inauthentic Behavior detection.
  - Exports: `analyseCib`, `assessCluster`, `temporalSynchrony`, `contentDuplication`, `accountMaturity`, `handlePatterns`, `amplification`.
- **[imaging.ts](file:///d:/social_media_research/src/utils/imaging.ts)** & **[imaging-client.ts](file:///d:/social_media_research/src/utils/imaging-client.ts)**: Module 4 media & provenance.
  - Exports: `pHash`, `hammingDistance`, `interpretExif`, `interpretC2pa`, `interpretOcr`, `assessProvenance`.
- **[reports.ts](file:///d:/social_media_research/src/utils/reports.ts)** & **[report-pdf.ts](file:///d:/social_media_research/src/utils/report-pdf.ts)**: Module 5 intelligence product generation.
  - Exports: `sourcesFromArticles`, `sourcesFromSocial`, `sourcesFromImages`, `sourcesFromGeo`, `renumber`, `buildSourceContext`, `validateCitations`, `citedSourceNumbers`, `generateProduct`, `toMarkdown`, `renderProductPdf`.
- **[geo.ts](file:///d:/social_media_research/src/utils/geo.ts)** & **[geo-sources.ts](file:///d:/social_media_research/src/utils/geo-sources.ts)**: Module 5 GIS & spatial analysis.
  - Exports: `isRealCoordinate`, `fromUsgsFeature`, `fromUcdpEvent`, `GEO_LAYERS`, `collectSeismic`, `collectConflict`, `collectNewsGeo`, `collectGeoLayers`.
- **[dorks.ts](file:///d:/social_media_research/src/utils/dorks.ts)**: OSINT query dork generators.
  - Exports: `buildDork`, `toDomain`, `DORK_TEMPLATES`.
- **[recon-sources.ts](file:///d:/social_media_research/src/utils/recon-sources.ts)**: Infrastructure recon utilities.
  - Exports: `parseIssuerOrg`, `isWithinDomain`, `collectCrtShSubdomains`.

### Python backends (separate from the TS/JS export registry above)

- **`app/`** (repo root): FastAPI YouTube ingestion/collector backend (`yt-dlp`). Tests in `tests_py/`. Own `requirements.txt` at repo root.
- **`ai-service/`** (merged 2026-08-14): FastAPI vision/forensics backend — `app/forensics.py` (EXIF/GPS/pHash/C2PA), `app/ocr.py` (Tesseract), `app/detect.py` (Grounding DINO). Own `requirements.txt`/`.env.example`/`Dockerfile`/`docker-compose.yml` inside `ai-service/`, deploys independently of both the frontend and `app/`. Tests in `ai-service/tests/`. See `CLAUDE.md`'s `ai-service/` section for the full status table and the milestone entry above for what was and wasn't verified at merge time.

---

## 4. Hard Constraints & System Policies

1. **Open-Source LLMs Only**: Sarvam (`sarvam-105b`), Groq (`openai/gpt-oss-120b`). **Meta Llama models are explicitly BANNED** due to Meta's Acceptable Use Policy prohibiting military and espionage use (disqualifying for IAF PS-18).
2. **Data Honesty**: Never fabricate data or placeholder confidence scores. Unmeasured values must strictly be `null`, never `0` or default fallbacks.
3. **Zero Budget / Free Tier**: All external tools must run in-browser (WASM/WSS) or use keyless/free open endpoints.
4. **Coordinate Honesty**: No record without a real coordinate is plotted on GIS. `0,0` is treated as missing.
