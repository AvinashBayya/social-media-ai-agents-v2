# Sentinel AI

OSINT analysis and monitoring platform built for **ADITI 4.0 / iDEX Problem Statement 18**, sponsored by the Indian Air Force. Stage: pre-selection demo.

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

`src/utils/gemini.ts` has been **deleted**. It is replaced by `src/utils/llm.ts` — see the LLM section below.

## Hard constraints

**Open-source LLMs only.** Do not propose Gemini, Azure OpenAI, or any hosted commercial LLM API. Do not propose Llama or anything derived from it — Meta's Acceptable Use Policy explicitly bans military and espionage use, which disqualifies it for an IAF system.

Approved models:
- Sarvam (Apache 2.0, Indian)
- Mistral 3 (Apache 2.0)
- AI4Bharat IndicTrans2 (MIT)

**Never fabricate data.** If something fails, surface an explicit error. Do not write fallbacks that return plausible-looking placeholder results, invented scores, or synthetic content. This is a defence intelligence tool; a fake confidence value is worse than a visible failure.

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
high-confidence AI finding the system makes is a *signed C2PA manifest declaring* generative
provenance.

Dependencies (all free, all in-browser WASM, no server, no GPU):
- `exifr` (MIT) — EXIF/TIFF/XMP
- `c2pa` (MIT, contentauth) — Content Credentials. WASM + worker emitted as **first-party
  assets** via Vite `?url`, deliberately not a CDN.
- `tesseract.js` (Apache 2.0) — OCR incl. nine Indic scripts; traineddata fetched per
  language on first use.
- pHash is hand-written DCT in `src/utils/imaging.ts` — no library.

`imaging.ts` is pure/testable; `imaging-client.ts` holds everything touching DOM or WASM and
imports it one-way. Uploaded media never leaves the browser.

**⚠️ Licence trap if object detection is ever added: use Grounding DINO (Apache 2.0).
Do NOT use Ultralytics YOLO — AGPL-3.0, which would force open-sourcing the whole system.**
Recorded in `NOT_IMPLEMENTED` in `imaging.ts` and asserted by a test.

EXIF absence is reported as absence — every major platform strips it on upload, so a missing
block is the normal case for redistributed media, not evidence of tampering.

## GPU quota request — NOT YET RAISED

Needed later for self-hosted open-source LLM inference (vLLM). **Do not run the
workload-profile command until quota is granted.**

| | |
|---|---|
| Status | **Not yet submitted** — no support ticket has been filed |
| Documented | 2026-08-03 |
| Date raised | _(fill in when submitted)_ |
| Ticket ref | _(fill in)_ |
| Date granted | _(fill in)_ |

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
