# Sentinel AI

OSINT analysis and monitoring platform built for **ADITI 4.0 / iDEX Problem Statement 18**,
sponsored by the Indian Air Force. Stage: **pre-selection demo**.

> **Status: demonstrator — not an accredited system.**
> See `CLAUDE.md` and `PROJECT_MEMORY.md` for the full capability breakdown,
> hard constraints, and anti-deletion rules that apply to every AI session on this repo.

## Deployed state

- **Live URL**: `sentinel-web.livelyfield-6aea41cd.centralindia.azurecontainerapps.io`
- **Version**: `v25` / revision `sentinel-web--0000023`
- **Tests**: 653 JS/TS unit tests passing · `tsc --noEmit` clean · 151 core exports verified
- **Git**: `origin/main` at `1e944d4`

## Stack

- TanStack Start 1.168 (SSR), React 19, TypeScript, Vite 8, Bun
- Tailwind 4, shadcn/ui
- 33 routes under `src/routes/`, i18n across 15 Indian languages
- Deployed to Azure Container Apps (Central India) as a Node server container

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

## Container / Azure deployment

```sh
# Build image in Azure Container Registry (no local Docker required)
az acr build --registry sentinelacr4821 --image sentinel-web:vXX --no-logs .

# Deploy
az containerapp update -g rg-sentinel-demo -n sentinel-web \
  --image sentinelacr4821.azurecr.io/sentinel-web:vXX

# Push source
git add -A && git commit -m "..." && git push origin main
```

> ⚠️ The Azure CLI crashes while streaming build logs on Windows (`cp1252` encoding error).
> This is client-side log streaming only — the remote build still completes.
> Always verify with:
> `az acr repository show -n sentinelacr4821 --image sentinel-web:<tag> --query createdTime`

The image runs on `node:22-alpine`, serving `.output/server/index.mjs` on port 3000.
`data/` is excluded from the build context (`.dockerignore`) and is not a mounted volume —
vault credentials do not survive a replica restart; use Key Vault `secretref:` env vars
for anything that must persist.
