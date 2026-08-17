# Sentinel AI

OSINT analysis and monitoring platform built for **ADITI 4.0 / iDEX Problem Statement 18**, sponsored by the Indian Air Force. Stage: pre-selection demo.

## Mandatory AI Memory & Preservation Protocol

> **CRITICAL FOR ALL CLAUDE / AI SESSIONS:**
>
> 1. **Read Project Memory First:** Always inspect [`PROJECT_MEMORY.md`](file:///d:/social_media_research/PROJECT_MEMORY.md) at the start of any session to load active progress, codebase inventory, and hard constraints.
> 2. **Never Delete Existing Functions:** Snippet-based edits wipe out un-viewed exports. Inspect full target files before editing. All edits must be **additive-only**.
> 3. **Verify Integrity:** Run `bun test` after edits to ensure zero regression across the 415+ unit test suite.
> 4. **Update Memory State:** Record progress and newly added exports in [`PROJECT_MEMORY.md`](file:///d:/social_media_research/PROJECT_MEMORY.md) upon task completion.

## Stack

Originally scaffolded from a TanStack Start template. All Lovable tooling, branding and
the `@lovable.dev/vite-tanstack-config` build package have been removed; `vite.config.ts`
now composes the plugin list explicitly (order matters — see the comment in that file).

- TanStack Start 1.168 (SSR), React 19, TypeScript, Vite 8, Bun
- Tailwind 4, shadcn/ui
- 27 routes under `src/routes/` (flat file-based routing, plus `__root.tsx`)
- i18n covering 15 Indian languages under `src/i18n/locales/`

## PS-18 required modules

1. Source credibility check, scored on user-defined factors
2. Open-source content analysis
3. Social media content analysis
4. Image and video analysis, including deepfake / synthetic media detection
5. Report extraction and GIS output, built on open-source LLMs

Plus real-time monitoring of user-defined subjects, and data mining at scale.

## Current state

The frontend is good and worth keeping. Everything behind it needs building: no database (all state is localStorage), no auth, no backend. Roughly 15–20% of PS-18 is covered.

**Deployment drift — RESOLVED 2026-08-10. Live state below is current as of 2026-08-11.**
The container app `sentinel-web` runs **`v15`**, built from `main` by `az acr build` and
serving revision **`sentinel-web--0000013`** (healthy, `RunningAtMaxScale`, 1 replica).
The tree and the live app match, and the app is rebuildable from source.

**Check this section against the live app before trusting it.** It said `v13` /
`sentinel-web--0000011` until 2026-08-11, by which point `v14` had been built and deployed
without the note being updated. One command settles it:

```sh
az containerapp show -g "$RG" -n "$APP" \
  --query "{image:properties.template.containers[0].image, rev:properties.latestReadyRevisionName}"
```

The drift this replaces: `v10` was built from an auth system committed, deployed, then
reverted out of `main`, so the live app gated every route behind a login no source here
produced. That work is now pushed as branch `backup/pre-auth-rollback` (tip `1f3259f`, auth
at `214f0df`) and tag `pre-auth-rollback-20260806` — no longer reflog-only. It is **not**
restored; the route gate on `main` is the disclosed client-side demo session
(`src/utils/demo-session.ts`), which is not authentication and says so.

Traps when deploying — the first two were hit again on 2026-08-11:

- **No Docker locally.** Build with `az acr build`, never `docker build`.
- **The Azure CLI crashes while streaming build logs on Windows** — Vite prints `✓`, and
  cp1252 cannot encode it (`UnicodeEncodeError`). **This is client-side log streaming only:
  the remote build still completes and pushes.** Never conclude a build failed from CLI
  output alone — check
  `az acr repository show -n $ACR --image sentinel-web:<tag> --query createdTime`.

  **`PYTHONIOENCODING=utf-8` is NOT sufficient — corrected 2026-08-11.** The v15 build set
  it and still crashed. The traceback is not in `_stream_utils.py`'s own write: it ends in
  `colorama/ansitowin32.py` → `encodings\cp1252.py`, i.e. colorama re-wraps stdout and
  encodes to the **console code page**, which `PYTHONIOENCODING` does not change. The build
  itself was fine — `v15` was pushed at 07:37:23Z while the CLI reported exit 1. If you want
  the crash gone rather than merely understood, change the console encoding
  (`[Console]::OutputEncoding = [Text.Encoding]::UTF8` in PowerShell, or `chcp 65001`);
  neither is verified here, so verify the tag either way.

- **Transient DNS failure kills `az` outright — new 2026-08-11.** Not the same thing as the
  log-streaming crash, and not limited to the ACR log-blob host: `az` failed
  `getaddrinfo` on **`login.microsoftonline.com`** (token refresh) on three consecutive
  attempts across both Git Bash and PowerShell, each hanging for ~5 minutes of retries. It
  is not a sandbox or proxy issue and not a broken install — `curl`, `git`, system Python
  **and the Azure CLI's own bundled `python.exe` invoked directly** all resolved the host
  correctly throughout. The fourth attempt succeeded with no change. **Retry before
  diagnosing.**

- Leftover `DATABASE_URL`, `SESSION_SECRET` and `seed-admin-password` remain configured on
  the container app from the `v10` auth deployment. Nothing on `main` reads them.
- **`data/` is excluded from the build context** (`.dockerignore`, 2026-08-11). The build
  stage does `COPY . .`, so before that it was uploading `data/credentials.json` — an
  operator credential store in cleartext — to the ACR build service on every deploy.

`src/utils/gemini.ts` has been **deleted**. It is replaced by `src/utils/llm.ts` — see the LLM section below.

## Frozen data contracts — FROZEN 2026-08-06

`src/types/core.ts` holds the six inter-developer shapes (Article, Post, Entity, Finding,
MediaAsset, VideoAsset). Dev 1 produces the media assets, Dev 2 the articles/posts/findings,
Dev 3 owns the file. **Additive changes only** — new optional fields are fine, renames and
removals need a joint re-freeze.

These are **boundary** types, deliberately not the internal working types. `analysis.ts` keeps
its own richer `Article` (note `pubDate`, not `publishedAt`), `social.ts` its `SocialPost`,
`imaging.ts` its report family. `src/types/core-adapters.ts` is the _only_ place the two
worlds convert — one function per direction per type. Retyping the existing modules onto the
contract would have rewritten Modules 1–5 to fix an integration seam.

Rules that must not regress:

- Anything that can genuinely fail to be measured is `| null`, deviating from the brief's bare
  fields. `null` means **not measured**, never zero — an unfetchable account age must stay
  distinguishable from an account created today.
- Every contract carries a zod schema and is parsed at the boundary. Mismatch throws
  `ContractViolationError` naming the contract, the producer and the field path; it is never
  coerced. `parseMany` keeps good records and reports rejects by index, so one malformed item
  neither drops the batch nor vanishes silently.
- `toGeoPoint` enforces coordinate honesty at the seam — `0,0` and out-of-range return null.
- **Dev-3 additive extension:** Appendix B's `Post` carries no stable account id and no links.
  Module 3's handle-family and amplification signals need both, so `authorId`, `langs` and
  `links` were added as optional fields. `toSocialPost` returns a `degraded[]` list naming
  every CIB input a contract-sourced post could not supply, rather than silently returning a
  cleaner picture than the evidence supports. **Raise these with Dev 2** — they are optional
  so the freeze holds, but the signals stay uncomputed until populated.

Fixtures live in `tests/helpers/core-fixtures.ts` and are enforced by
`tests/core-contracts.test.ts` (37 tests). They are in `tests/` on purpose: synthetic records
importable from `src/` are one refactor away from rendering as real findings. **Nothing under
`src/` may import them.**

## Hard constraints

**Open-source LLMs only.** Do not propose Gemini, Azure OpenAI, or any hosted commercial LLM API. Do not propose Llama or anything derived from it — Meta's Acceptable Use Policy explicitly bans military and espionage use, which disqualifies it for an IAF system.

Approved models:

- Sarvam (Apache 2.0, Indian)
- Mistral 3 (Apache 2.0)
- AI4Bharat IndicTrans2 (MIT)

**Never fabricate data.** If something fails, surface an explicit error. Do not write fallbacks that return plausible-looking placeholder results, invented scores, or synthetic content. This is a defence intelligence tool; a fake confidence value is worse than a visible failure.

**The three shapes this keeps coming back as.** A six-agent browser audit on 2026-08-12
found 14 live fabrications; **nine matched one of three grep patterns**. They are cheap
to reintroduce and cheap to catch, so check for them before committing:

```sh
grep -rn "|| new Date()" src/          # 1. timestamp invention
grep -rnE '\|\|\s*"[A-Z]' src/         # 2. string literal as a measurement
grep -rnE '\?\?\s*0\b|\|\|\s*0\b' src/ # 3. numeric zero-flattening
```

1. **`x || new Date().toISOString()`** stamps _now_ onto an undated record. Found at
   ten sites, including posts attributed to real named Telegram channels. Use `null`.
2. **A string literal fallback that renders as a measurement** — `Registrar || "GoDaddy"`,
   `status || "online"`, `conflict_new_id || "State Conflict"`, `primarySource || "News Wire"`.
   An honest absence marker (`|| "not reported"`, `?? "issuer not reported"`, `|| "—"`) is
   fine and is the intended replacement; the test is whether a reader would take the value
   for a finding.
3. **`?? 0` / `|| 0` in collector mapping** flattens _unreported_ into a measured zero:
   unreported casualties rendered as "0 casualties", an unreported radiation reading was
   classified "normal", and `lat ?? 0` produced the exact `0,0` sentinel `toGeoPoint` exists
   to reject. Loop accumulators and config defaults are fine — this is about values that
   reach a screen.

The same audit found a fourth class worth naming: **a control with no handler**. `/vault`'s
Download button had `onClick: undefined`, `/graph` had eight, and the notification bell had
none while showing a permanent unread dot. A control that cannot act tells the analyst a
capability exists. Wire it or remove it.

**Free-tier tooling only.** Zero budget for licences and APIs.

**Deployment target** is Azure Container Apps in Central India.

## LLM layer

`src/utils/llm.ts` is a provider-agnostic client speaking the OpenAI
`/chat/completions` format. Endpoint and model are **config, never code** — that is what
makes the vLLM migration a one-line change once GPU quota lands.

```sh
# Primary
LLM_BASE_URL=https://api.sarvam.ai/v1
LLM_API_KEY=<key>
LLM_MODEL=sarvam-105b
# Fallback (used only on 429 / 5xx — a 401/403 does not fail over)
LLM_FALLBACK_BASE_URL=https://api.groq.com/openai/v1
LLM_FALLBACK_KEY=<key>
LLM_FALLBACK_MODEL=mistral-saba-24b
```

**Model IDs — both verified against `/models` on 2026-08-03 with live keys.**

- Sarvam returns exactly one model: **`sarvam-105b`**. There is no `sarvam-m`.
- Groq offers **no Mistral model at all** — `mistral-saba-24b` does not exist there.
  Of Groq's 15 models, the licence-clean chat options are `openai/gpt-oss-120b`,
  `openai/gpt-oss-20b` (both **Apache 2.0 open-weight**, not the OpenAI API) and
  `qwen/qwen3.6-27b`. Everything Llama-derived is excluded by Meta's AUP.
  We use **`openai/gpt-oss-120b`**. Despite the `openai/` prefix these are open weights,
  self-hostable on vLLM — worth stating explicitly in any pitch, since the prefix
  invites the wrong assumption.

**Both are REASONING models.** They emit chain-of-thought into `reasoning_content`
(Sarvam) / `reasoning` (Groq), and that thinking is billed against `max_tokens`. A budget
sized for the answer alone returns `finish_reason: "length"` with `content: null`.
Measured: `max_tokens: 16` → empty content; `400` → clean answer. Call budgets are
1400–2800 accordingly. `llm.ts` throws on truncation rather than returning a partial brief.

**Model licence constraint.** Do not switch to any Llama model, or to DeepSeek R1 Distill
(distilled from Llama 70B, inherits the licence). Meta's Acceptable Use Policy bans
military and espionage use. Mistral (Apache 2.0) and Sarvam (Apache 2.0) are clear.

Behaviour that must not regress:

- Every failure throws `LlmUnavailableError` with the real upstream cause. No fallback text,
  ever. The UI renders an explicit "AI unavailable" state.
- JSON responses are validated with zod; a schema mismatch throws rather than coercing.
- In-memory LRU cache, 500 entries, keyed on sha256(model + system + prompt). Per-process
  and lost on restart — fine for a demo, needs Redis for real use.
- `getLlmStats()` server function exposes call counts, cache hit rate, token totals and
  latency. It is a server function, not `/api/llm/stats` — this TanStack Start version
  exposes no `createServerFileRoute`, so an HTTP route was not added.

Migration to self-hosted vLLM: point `LLM_BASE_URL` at the vLLM service and set
`LLM_MODEL`. No application code changes.

**Deployed config (v2, 2026-08-03).** Keys live in Key Vault (`sarvam-key`, `groq-key`) and
reach the app as `secretref:` env vars via its **system-assigned identity**, which holds
`Key Vault Secrets User` on the vault. No plaintext key is stored on the container app.
Rotating a key means updating the vault secret and restarting the revision.

Core logic lives in plain exported functions (`summariseText`, `extractEntitiesFrom`,
`assessLanguageOf`, `llmStatsSnapshot`, …) with `createServerFn` as thin wrappers. Server
functions cannot execute outside the Start runtime context, so keeping the logic separate
is what makes it testable — do not move it back inside the handlers.

## Source credibility (Module 1)

All seven PS-18 §6.1 factors are implemented. Six are deterministic and free; the seventh
(`linguistic_markers`) is model-backed, ships **disabled**, and is **opt-in per article** —
assessing a whole feed is one call per item against a free tier.

- `compute()` is **synchronous and must stay that way**. The assessment is pre-computed and
  threaded in via `FactorOptions.language`, the same way `clusters` and `social` are. Making
  it async would push `async` through `scoreArticle`, `scoreCorpus` and the scoring `useMemo`
  in sources.tsx for one factor in seven.
- `credibility.ts` imports `LanguageAssessment` **type-only**, so there is no runtime edge to
  `llm.ts`. The call lives in `credibility-llm.ts`, which imports the deterministic layer and
  not the reverse — mirroring `analysis-llm.ts` over `analysis.ts`. The five deterministic
  factors keep scoring with the model unreachable.
- **Hedging is deliberately NOT scored.** The score is `1 - mean(emotiveLoad, absolutism,
sensationalism)`. Hedging's direction is genuinely ambiguous — "officials said" is careful
  attribution, "reportedly" throughout is vagueness — and one number cannot separate them. It
  is reported as evidence, with the reason for its exclusion, and the analyst judges it.
- Confidence is **0.55**, below the fixed-confidence deterministic factors. Note corroboration
  and source diversity scale confidence with corpus size (`0.4 + n/50`), so on a small corpus
  they sit _below_ the linguistic factor — correctly, and a test asserts only against the
  fixed ones.
- A missing entry in the language map means **not yet assessed**, never "assessed and clean".
  Failures are collected per article with the real upstream cause; `assessmentSummary` reports
  coverage as a proportion, because "12 assessed" hides whether that was 12 of 12 or 12 of 200.

Still outstanding for M1: weight profiles are localStorage (`sentinel_credibility_profiles`),
so they are not per-user and not audited.

## Social collection (Module 3)

Verified against live endpoints 2026-08-04.

- **Bluesky Jetstream** `wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`
  — open WebSocket firehose, no auth, emits JSON. The socket runs **in the browser**:
  the container scales to zero, so a server-side socket would be torn down between
  requests. Buffer is a bounded 2,000-post ring.
- **Bluesky public AppView** `https://public.api.bsky.app/xrpc/` — `app.bsky.actor.getProfile`,
  `getProfiles` (≤25 actors), `app.bsky.feed.getAuthorFeed` all work unauthenticated.
  `getProfile` returns `createdAt`, `postsCount`, `followersCount` — the basis for the
  account-maturity signal.
- **`app.bsky.feed.searchPosts` returns 403** — it needs auth. No historical keyword
  search without an account, so monitoring runs forward from connection.
- **Reddit** `https://www.reddit.com/search.json` — unauthenticated, rate limited; a 429
  is surfaced as a rate limit, not as "no results".
- **Telegram** `https://t.me/s/{channel}` — public channel previews only.

**Instagram and Facebook are not collected, and this is stated in the UI.** Meta's terms
prohibit scraping and the Graph API only grants access to Pages/Business accounts the
caller owns, so broad monitoring is genuinely unavailable rather than unimplemented.
CrowdTangle shut down August 2024. X/Twitter has had no free tier since 2023. Do not
re-add scrapers for any of these.

CIB signals (`src/utils/cib.ts`) are presented as **signals warranting review, never a
verdict** — organised legitimate campaigns produce identical patterns. Every signal
carries an evidence string naming the accounts and timings; a signal that cannot be
computed returns `null` with a reason, never 0.

## Image / video analysis (Module 4)

**We do not build or claim a deepfake classifier.** Detectors trained on GAN-era fakes
generalise poorly to diffusion models and collapse under the recompression social
redistribution applies. With no GPU that would be a fabricated confidence value — the one
thing the hard constraints forbid.

Position taken instead: **provenance beats classification**. A C2PA Content Credential is a
signature (verifies or does not, no false positives); a deepfake score is a guess. The only
high-confidence AI finding the system makes is a _signed C2PA manifest declaring_ generative
provenance.

Dependencies (all free, all in-browser WASM, no server, no GPU):

- `exifr` (MIT) — EXIF/TIFF/XMP
- `c2pa` (MIT, contentauth) — Content Credentials. WASM + worker emitted as **first-party
  assets** via Vite `?url`, deliberately not a CDN.
- `tesseract.js` (Apache 2.0) — OCR incl. nine Indic scripts. Worker script and the
  `tesseract.js-core` WASM engine are emitted as **first-party assets** via Vite `?url`,
  exactly like c2pa. tesseract.js defaults BOTH to jsDelivr, so until 2026-08-12 pressing
  "Run OCR" fetched and executed undisclosed third-party JavaScript on the analyst's
  machine and OCR could not work without egress. Two traps: `corePath` must be an
  **`-lstm` `.wasm.js`** build (the `.wasm.js` embeds the wasm as base64, so there is no
  second request) because `createWorker(..., 1, ...)` is `OEM.LSTM_ONLY` — change one and
  you must change the other; and pointing at a build the browser cannot compile does not
  error, it **hangs the worker forever**, which is why the SIMD level is probed and the
  plain build is the fallback. Traineddata is the one remaining remote fetch and is
  disclosed in the UI: ~27.6 MB for all fourteen languages (measured 2026-08-12) against a
  scale-to-zero image, and `langPath` is one flat directory for every language, so it is
  all or nothing — it is none. Build with `VITE_TESSERACT_LANG_PATH` pointing at a flat
  directory of `<lang>.traineddata.gz` to make OCR fully air-gapped.
- pHash is hand-written DCT in `src/utils/imaging.ts` — no library.

`imaging.ts` is pure/testable; `imaging-client.ts` holds everything touching DOM or WASM and
imports it one-way. Uploaded media never leaves the browser.

**⚠️ Licence trap if object detection is ever added: use Grounding DINO (Apache 2.0).
Do NOT use Ultralytics YOLO — AGPL-3.0, which would force open-sourcing the whole system.**
Recorded in `NOT_IMPLEMENTED` in `imaging.ts` and asserted by a test.

EXIF absence is reported as absence — every major platform strips it on upload, so a missing
block is the normal case for redistributed media, not evidence of tampering.

## `ai-service/` — Python vision/forensics backend — MERGED 2026-08-14, not yet wired up

A separate FastAPI backend, developed independently and merged in from a teammate's branch
via `MERGE_PACKAGE/` (now removed after merge — see git history if the original notes are
needed). It duplicates none of the client-side Module 4 logic above; it exists because
server-side gives it access to heavier models (Grounding DINO) that can't run in-browser.
**Deploys separately from the frontend**, to its own host (a local/air-gapped Linux+GPU box
for the real deployment), with its own `Dockerfile`/`docker-compose.yml` — excluded from the
frontend's Docker build context via `.dockerignore` for the same reason `data/` is.

Real endpoints: `POST /ai/forensics` (EXIF incl. GPS, pHash via 2D-DCT, C2PA best-effort —
the same techniques as `imaging.ts`, independently implemented in Python), `POST /ai/ocr`
(Tesseract, English/Hindi/Tamil), `POST /ai/phash/compare`, `POST /ai/detect` (Grounding DINO
tiny, zero-shot/open-vocabulary — **Apache 2.0**, matching the licence trap warned about
above; the vendored weights, ~650MB, are `.gitignore`d and loaded from `ai-service/models/`
only, never fetched at runtime). Still 501 stubs: `/ai/faces`, `/ai/video`, `/ai/transcribe`,
`/ai/translate`, `/ai/describe`, `/ai/chat`.

**Verified at merge time, in this environment (no GPU, no system Tesseract, no vendored
weights):** `pytest` on the pure-Python surface — all 8 `test_forensics.py` cases (EXIF/GPS,
pHash, C2PA, timestamp-mismatch) and 4 of 5 `test_skeleton.py` cases passed. OCR and detect
tests fail here for exactly the reasons `ai-service/README`-equivalent docs say they would:
no `tesseract` binary on PATH, and no `torch`/`transformers`/vendored model weights installed
(deliberately not installed by default — `torch` alone is a multi-GB download and this
environment has no GPU to exercise it on). Install
`transformers`+`torch` and a system Tesseract, vendor the Grounding DINO weights per
`ai-service/requirements.txt`'s comments, and re-run `pytest` before trusting those paths.

**Re-verified 2026-08-17, at the live HTTP layer this time, not just `pytest`.** No Docker
needed for this — `ai-service`'s own `.venv` runs `uvicorn app.main:app` directly. `/health`
honestly reports every model's real state. `/ai/forensics` against three real fixtures:
correct EXIF/GPS/software-tag extraction, correct null-EXIF handling with the "not evidence
of manipulation" note intact, correct `timestamp_mismatch: true` on a real 2019-capture/
2026-modified fixture. `/ai/phash/compare`: Hamming 2 (`near_duplicate: true`) on a resized/
recompressed near-duplicate pair, Hamming 36 (`false`) on a genuinely different pair — real
discrimination, not a fixed number. `/ai/ocr` and `/ai/detect` fail exactly as documented
above (`TesseractNotFoundError` / 500, `ModelNotLoadedError` / 503) — clean, typed JSON error
envelopes, no crash. `/ai/faces` (a stub) correctly 501s. **Still not verified**: the OCR/
detect code paths' actual behavior *when* Tesseract/weights are present — this confirms they
fail safely without those, not that they produce correct results with them.

**`/ai/stats` was a hardcoded placeholder (`{"calls": 0, "cache_hits": 0}`, always) —
fixed 2026-08-17.** Found while re-verifying live: real requests plainly happened and it
still reported zero. `cache_hits` stays honestly 0 — there is no caching layer anywhere in
`ai-service` yet, so a cache genuinely cannot have been hit, a different situation from
`calls` reporting a false zero for something real. New `app/stats.py` (an in-process
counter, mirroring `loaders.py`'s `registry` singleton pattern — lost on restart by design,
not a durable log) plus HTTP middleware in `main.py` that counts every `/ai/*` request.
**A real bug surfaced while testing the fix itself**: a naive `record_call()` placed after
a bare `await call_next(request)` silently failed to count requests that hit the *generic*
exception handler (e.g. `TesseractNotFoundError` from `/ai/ocr`) while correctly counting
ones hitting a registered `AIServiceError` subclass (e.g. `/ai/faces`'s 501) — because
Starlette routes an `Exception`-class handler into `ServerErrorMiddleware`, which sits
*outside* custom `@app.middleware` layers, so `call_next()` raises rather than returning
for exactly that path. Fixed with `try/finally`. Confirmed live via curl against a real
running server across every response type (200/500/503), and covered by two new
`test_skeleton.py` cases (one of which reproduces the exact bug in an environment with no
system Tesseract, using `raise_server_exceptions=False` since `TestClient`'s default
re-raises server exceptions into the test process rather than returning them, unlike a
real server).

**Known, real, unfixed limitation** (locked in as a characterization test,
`test_detect_known_limitation_confident_false_positive_on_absent_object`): Grounding DINO
does not reliably report "nothing found" — prompting for an absent object still returns a
confident (35–65%) detection at the best-matching region. **`/ai/detect` output must be
framed as an unverified candidate match for analyst review, never a confirmed finding**,
consistent with this project's EXIF-GPS/C2PA framing elsewhere — this is not yet decided
for any UI that might surface it, because no frontend caller exists yet.

**Not done:** no frontend code calls this service — `src/utils/imaging.ts`/`imaging-client.ts`
still do everything client-side, independently. Wiring them together (or deciding not to) is
unstarted work, not a regression.

**Deliberately not merged from the same source:** a local session-based auth/RBAC system
(Prisma+SQLite, login, guards) was in the same source package but was not brought in — this
project already built and then deliberately reverted an auth system out of `main` (see the
deployment-drift note above; `backup/pre-auth-rollback` branch/tag). Re-introducing auth is a
product decision, not a merge task, and was left out on that basis.

## Reports + GIS (Module 5)

§6.5 is the **only** place PS-18 names the open-source LLM requirement explicitly, so every
product shows its model — on screen, in the provenance block, and in the PDF footer of every
page. That visibility is compliance evidence.

**Geo source reality, verified live 2026-08-04:**

- **UCDP GED now returns 401** — `API token required. Add header: x-ucdp-access-token`. Every
  version (23.1/24.1/25.1). Set `UCDP_API_TOKEN` to enable the conflict layer; without it the
  layer reports the missing credential rather than showing zero events.
- **GDELT GEO API (`/api/v2/geo/geo`) is 404** — retired. GDELT DOC only gives
  `sourcecountry` = **the publishing outlet's country, not the event location** (a Sputnik
  article about India carries `China`). Plotted at country precision and labelled as such.
- **GDELT rate limit: 1 request / 5 seconds**, enforced with a 429.
- **USGS earthquake feed** — free, keyless, precise epicentres. The only open dataset giving
  precisely located + timestamped + magnitude-bearing events, so it anchors the precision,
  time-slider and magnitude-sizing work.
- **ReliefWeb** needs an approved `appname`. Not wired.
- **Shodan InternetDB returns no geolocation** — host geo needs the paid API. Layer declared
  and empty rather than faked.

**Coordinate honesty is the load-bearing rule.** No record without a real coordinate is ever
plotted; unplaceable records are counted and reported. Exact fixes render as points, anything
coarser as a dashed uncertainty circle. `0,0` is rejected as a missing-value sentinel.

**Sourcing discipline in `reports.ts`:** every judgement/finding cites numbered sources;
citations are resolved against the real source list _after_ generation; failure retries once
with the violations and then throws. Partial products are never returned.

`export-helpers.ts` was deleted — exports.tsx now renders the same product object the analyst
reviewed, so a figure can no longer differ between screen and file.

## GPU quota request — NOT YET RAISED

Needed later for self-hosted open-source LLM inference (vLLM). **Do not run the
workload-profile command until quota is granted.**

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| Status       | **Not yet submitted** — no support ticket has been filed |
| Documented   | 2026-08-03                                               |
| Date raised  | _(fill in when submitted)_                               |
| Ticket ref   | _(fill in)_                                              |
| Date granted | _(fill in)_                                              |

- Request: `Consumption-GPU-NC8as-T4`, Central India, subscription
  `8a8baea4-547c-4f55-b206-d6af16a24970`. Ask for **8 vCPU** of the
  `Standard NCASv3_T4 Family` (one node); 16 for two concurrent.
- Central India and South India support the **T4 profile only**. The A100 profile
  (`Consumption-GPU-NC24-A100`) is **not available in either Indian region** — re-verified
  2026-08-03 via `az containerapp env workload-profile list-supported`. Both regions return
  the same set: D4–D32, E4–E32, Consumption, Flex, Consumption-GPU-NC8as-T4. Do not plan
  around A100 without moving region.
- `sentinel-env` currently carries only the `Consumption` profile (checked 2026-08-03).
- T4 is 16GB: fits 7B–14B models at 4-bit quantisation. Adequate for the demo. Sarvam and
  Mistral 3 both fit; size the model to this ceiling.
- Target environment `sentinel-env` (`rg-sentinel-demo`) is already workload-profiles
  enabled, so the profile can be added in place — no environment rebuild.

Once approved:

```sh
export MSYS_NO_PATHCONV=1
source ./azure-env.sh
az containerapp env workload-profile add \
  -g "$RG" -n "$ENV" \
  --workload-profile-name gpu-t4 \
  --workload-profile-type Consumption-GPU-NC8as-T4
```

**Cost conflict — unresolved.** GPU compute is not free-tier and contradicts the zero-budget
constraint above. An NC8as-T4 runs roughly USD 0.5–0.8/hour, so the USD 30/month budget
alert (`sentinel-monthly-30usd`) is about 40–60 GPU-hours for the month, before anything
else. Keep the GPU app scaled to zero when idle and treat it as demo-only. Decide the
funding source before committing to a self-hosted inference architecture.

## Environment

Windows 11, Git Bash (MINGW64), repo at `D:\social_media_research`, Node 24, Bun, no Docker.

Azure CLI commands run in Git Bash and require:

```sh
export MSYS_NO_PATHCONV=1
```

Without it, Git Bash mangles any argument starting with `/` — which is every `--scope` in Azure RBAC commands.
