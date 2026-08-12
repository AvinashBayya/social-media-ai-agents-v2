# Sentinel AI — Project Memory & Anti-Deletion System

> **Mandatory AI Protocol:** Every AI assistant (Claude / Antigravity / Cursor) interacting with this codebase **MUST** read this file at the start of every session, update the Active Task State upon progress, and observe the strict **Anti-Deletion Code Preservation Protocol**.

---

## 1. Active Task State & Progress Roadmap

### Current Focus

- **Task:** v1 Feature & Intelligence Merge — OSINT tools, agents, crawlers & real-time data sources integrated (Complete)
- **Phase:** PS-18 Pre-selection Demo Integrity & Multi-Source Intelligence
- **Last Verified:** 2026-08-12 — **567 unit tests passing** (`bun test`), **`tsc --noEmit` clean**, **123 core exports verified** (`bun scripts/check-exports.ts`), `bun run build` green.

### Deployed state — 2026-08-12 ✅ LATEST

`sentinel-web` runs **`v22`** / revision **`sentinel-web--0000020`** (healthy, 1 replica).
**470 JS/TS unit tests passing**, **5 Python unit tests passing**, **`tsc --noEmit` clean**.

#### YouTube Feature Architecture (v23+, rewritten 2026-08-12) — CRITICAL FOR AI TO KNOW
- **Self-contained**: no FastAPI backend. All logic runs in TanStack Start **server functions**.
- **Primary source is YouTube's own InnerTube `player` endpoint**, not ytdl-core. Public, keyless,
  and — crucially — its URLs need **no deciphering**, so the player-signature arms race cannot
  break it. `YT_INNERTUBE_CLIENTS` is tried in order.
  - **ANDROID first** — the only client returning a **muxed** format (itag 18, 360p). The runtime
    has no ffmpeg, so adaptive-only clients give streams we cannot join.
  - **IOS second** — metadata and captions; 32 formats, none muxed.
  - **WEB is excluded from playback** — it answers `UNPLAYABLE — "Video unavailable"` for videos
    ANDROID serves fine. It is used *only* for `microformat`, the sole source of an upload date.
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
| GPSJam ADS-B      | Working      | Navigation interference hex feed & regional classifier                                                                |
| Safecast Rad      | Working      | Open environmental radiation sensor network (µSv/h)                                                                 |
| CISA KEV          | Working      | Known Exploited Vulnerabilities cyber threat feed                                                                    |
| **Reddit**        | **Blocked**  | **All unauthenticated endpoints now 403. Needs `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` from a free script app.** |
| crt.sh            | Flaky        | Same URL gave 404 / timeout / 200-in-43s. Retries once; 50s budget                                                   |
| GDELT             | Rate limited | 429 at 1 req/5s, as documented                                                                                       |

### Completed Milestones

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
- **[core-adapters.ts](file:///d:/social_media_research/src/types/core-adapters.ts)**: Seam adapters (`toAnalysisArticle`, `fromAnalysisArticle`, `toSocialPost`, `fromSocialPost`, `toGeoPoint`, `PostDegradation`).

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
- **[social.ts](file:///d:/social_media_research/src/utils/social.ts)**: Module 3 collection & monitors.
  - Exports: `eventToPost`, `monitorMatches`, `assessSpike`, `bucketise`, `readMonitor`, `fetchProfile`, `fetchProfiles`, `fetchAuthorFeed`, `redditCredentials`, `resolveRedditCredentials`, `resetRedditToken`, `fetchRedditSearch`, `fetchTelegramChannel`, `fetchBlueskySearch`, `resetBlueskySession`, `fetchMastodonTag`, `mastodonStatusToPost`, `fetchMastodonSearch`, `stripMastodonHtml`, `mastodonLinks`, `MASTODON_INSTANCES`, `MASTODON_DEFAULT_INSTANCE`, `socialMastodon`, `socialBlueskySearch`, `socialMastodonSearch`, `socialCredentials`, `PLATFORM_NOTES`, `SocialUnavailableError`.
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

---

## 4. Hard Constraints & System Policies

1. **Open-Source LLMs Only**: Sarvam (`sarvam-105b`), Groq (`openai/gpt-oss-120b`). **Meta Llama models are explicitly BANNED** due to Meta's Acceptable Use Policy prohibiting military and espionage use (disqualifying for IAF PS-18).
2. **Data Honesty**: Never fabricate data or placeholder confidence scores. Unmeasured values must strictly be `null`, never `0` or default fallbacks.
3. **Zero Budget / Free Tier**: All external tools must run in-browser (WASM/WSS) or use keyless/free open endpoints.
4. **Coordinate Honesty**: No record without a real coordinate is plotted on GIS. `0,0` is treated as missing.
