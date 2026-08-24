# Sentinel AI

OSINT analysis and monitoring platform built for **ADITI 4.0 / iDEX Problem Statement 18**,
sponsored by the Indian Air Force. Stage: **pre-selection demo**.

> **Status: demonstrator — not an accredited system.**
> See `CLAUDE.md` and `PROJECT_MEMORY.md` for the full capability breakdown,
> hard constraints, and anti-deletion rules that apply to every AI session on this repo.

## Deployed state

- **Runs locally.** There is no hosted deployment — Azure was removed 2026-08-20.
- **Version**: `v25` / revision `sentinel-web--0000023`
- **Tests**: 653 JS/TS unit tests passing · `tsc --noEmit` clean · 151 core exports verified
- **Git**: `origin/main` at `1e944d4`

## Stack

- TanStack Start 1.168 (SSR), React 19, TypeScript, Vite 8, Bun
- Tailwind 4, shadcn/ui
- 33 routes under `src/routes/`, i18n across 15 Indian languages
- Runs as a Node server container (`node:22-alpine`); no cloud coupling in the app

## PS-18 Modules

| PS-18 module                                 | State                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 · Source credibility, user-defined factors | ✅ Implemented — 7-factor deterministic scoring + opt-in LLM linguistic-marker assessment       |
| 2 · Open-source content analysis             | ✅ Implemented — topic clustering, stance detection, entity extraction, TF-IDF over live feeds  |
| 3 · Social media analysis                    | ✅ Implemented — Bluesky, Mastodon, Telegram, Reddit (blocked without OAuth cred), CIB signals  |
| 4 · Image / video, provenance                | ✅ Implemented — C2PA manifest verification, EXIF, Tesseract OCR (14 langs), DCT pHash         |
| 5 · Reports and GIS                          | ✅ Implemented — LLM report generation, PDF export, USGS/UCDP/GDELT/GPSJam/Safecast GIS layers |

## Data collectors

| Source            | State        | Credential needed                              |
| ----------------- | ------------ | ---------------------------------------------- |
| Bluesky Jetstream | ✅ Working   | None (public WebSocket firehose)               |
| Bluesky AppView   | ✅ Working   | None for timelines; app password for search    |
| Mastodon          | ✅ Working   | None for hashtag timelines; token for search   |
| Telegram          | ✅ Working   | None (public channel previews)                 |
| GPSJam ADS-B      | ✅ Working   | None (public daily CSV)                        |
| Safecast Rad      | ✅ Working   | None (open sensor network)                     |
| CISA KEV          | ✅ Working   | None (public feed)                             |
| Reddit            | 🔴 Blocked   | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` from reddit.com/prefs/apps |
| UCDP GED          | 🔴 Gated     | `UCDP_API_TOKEN` from ucdp.uu.se               |
| crt.sh            | ⚠️ Flaky    | None                                           |
| GDELT             | ⚠️ Rate-ltd  | None (1 req/5 s limit)                         |
| X / Twitter       | ⛔ None      | No free tier since 2023                        |
| Instagram / Meta  | ⛔ None      | ToS prohibits scraping; Graph API limited      |

Credentials are managed on the `/settings` page (credential vault) or via environment
variables — see `CREDENTIAL_PROVIDERS` in `src/utils/credential-vault.ts`.

## YouTube

YouTube metadata, captions and analyst-initiated downloads run entirely through
TanStack Start **server functions** using YouTube's own InnerTube `player` endpoint.
No FastAPI backend, no `ytdl-core` for primary playback — the InnerTube approach is
keyless and does not require player-signature deciphering.

## LLM

Open-weight models only, behind an OpenAI-compatible interface so the endpoint is
configuration rather than code:

```sh
LLM_BASE_URL=https://api.sarvam.ai/v1
LLM_API_KEY=<key>
LLM_MODEL=sarvam-105b
LLM_FALLBACK_BASE_URL=https://api.groq.com/openai/v1
LLM_FALLBACK_KEY=<key>
LLM_FALLBACK_MODEL=openai/gpt-oss-120b  # open weights despite the openai/ prefix
```

Both are Apache 2.0 and self-hostable. Pointing `LLM_BASE_URL` at a vLLM instance
requires no application code change. No Llama-derived model — Meta's AUP bars
military and espionage use.

## Development

Requires [Bun](https://bun.sh) and Node 24. No local Docker needed.

```sh
bun install
bun run dev      # dev server at http://localhost:3000
bun run build    # production build to .output/
bun test         # must be ≥653 passing
tsc --noEmit     # must be clean
bun scripts/check-exports.ts      # must report ≥151 exports
bun scripts/fabrication-check.ts  # must exit 0 (no invented data)
```

Copy the LLM variables above into `.env` (gitignored) before running. Without them the AI
features report "AI unavailable" rather than returning fabricated output.

## Running it

There is no hosted deployment. **Azure was removed 2026-08-20** — the subscription was
disabled, the Container Apps environment suspended, and every Azure resource is gone. Do not
run `az`.

```sh
bun install
bun run dev                                # dev server

# or the production build, which is what the container runs
bun run build && node .output/server/index.mjs
```

The OSINT tool stack (SpiderFoot, theHarvester, SearXNG, IVRE) runs beside it:

```sh
docker compose -f osint-workers/docker-compose.yml up -d
```

`bash preflight.sh` checks the toolchain. Docker is required — it used to be optional only
because builds ran in the cloud.

**The app has no cloud coupling.** The Dockerfile targets plain `node:22-alpine` serving
`.output/server/index.mjs` on port 3000, and the only Azure reference that was ever in `src/`
was a doc comment. Choosing a host later is a config decision, not a port.

`data/`, `ai-service/` and `osint-workers/` are excluded from the Docker build context
(`.dockerignore`) — the build stage does `COPY . .`, and `data/credentials.json` is an
operator credential store in cleartext.
