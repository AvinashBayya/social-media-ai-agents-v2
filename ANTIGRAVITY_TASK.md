# ANTIGRAVITY_TASK.md — Sentinel AI Implementation Tasks

> **For Antigravity (AI agent) use only.**
> Read `PROJECT_MEMORY.md` and `CLAUDE.md` before touching any file.
> All edits must be **additive-only**. Run `bun test` after every change.
> Run `bun scripts/check-exports.ts` before committing. Never fabricate data.

---

## 🔴 Phase 3 — Asset Bundling (Browser-Audit Remediation, Outstanding)

> Phases 1, 2 and 4 complete (2026-08-12). **Phase 3 (asset bundling) and Phase 5 (repeatability) remain outstanding.**

### Task 3.1 — Audit all WASM / worker assets for CDN leaks

**Problem:** tesseract.js was silently fetching from jsDelivr (third-party CDN) until 2026-08-12.
Other WASM-backed libraries may have the same issue.

**Files to audit:**
- `src/utils/imaging-client.ts` — c2pa WASM worker, tesseract.js worker
- `src/utils/leaflet-client.ts` — Leaflet tile layers
- `vite.config.ts` — verify all `?url` imports emit as first-party assets

**Acceptance criteria:**
- No runtime `fetch` to a CDN for a script or WASM binary
- `bun run build` then `grep -r "jsdelivr\|unpkg\|cdnjs\|skypack" .output/` → zero hits
- If a remote fetch is unavoidable (e.g. map tiles), it must be labelled in the UI

---

### Task 3.2 — Verify Vite `?url` asset emission for c2pa worker

1. Run `bun run build`
2. Check `.output/public/assets/` for `c2pa.worker*` and `tesseract*` files
3. Grep `.output/` for any remaining `jsdelivr` or `esm.sh` URLs
4. Fix any that are missing

---

### Task 3.3 — SIMD probe for tesseract.js (imaging-client.ts)

From CLAUDE.md: pointing at a build the browser cannot compile hangs the worker forever.
Verify `imaging-client.ts` probes SIMD support and falls back to the plain `.wasm.js` build.

---

## 🔴 Phase 5 — Repeatability / Reproducible Builds (Outstanding)

### Task 5.1 — Verify clean build from source

1. `bun install`  — verify `bun.lock` is committed and up to date
2. `bun run build`  — must succeed
3. `bun test`  — must be **>=653 passing, 0 failing**
4. `bun scripts/check-exports.ts`  — must report **>=151 exports**
5. `tsc --noEmit`  — must be clean
6. Add any missing manual steps to README.md

### Task 5.2 — README accuracy pass

Update README.md to reflect:
- Current test count (653), export count (151)
- Deployed version v25 / sentinel-web--0000023
- YouTube InnerTube architecture (no FastAPI backend)
- Credential vault and /settings page
- Collection policy matrix summary
- Known working vs blocked/flaky collectors

---

## 🟡 Backlog — Active Collector Issues

### Task B1 — Reddit OAuth credential UI integration

Reddit is blocked (403 on all unauthenticated endpoints).
- `credential-vault.ts` reddit provider exists
- `/settings` vault UI exists
- `resolveRedditCredentials()` reads vault + env

**Missing:** Clear UI copy on `/settings` explaining Reddit script app registration flow.
**File:** `src/routes/settings.tsx`, `src/utils/social.ts`

---

### Task B2 — Bluesky app-password historical search

`fetchBlueskySearch` and `resetBlueskySession` already implemented.

**Missing:**
- UI on `/settings` explaining how to create a Bluesky app password
- A "test search" button that calls `socialBlueskySearch` with a sample query

**File:** `src/routes/settings.tsx`, `src/utils/social.ts`

---

### Task B3 — UCDP API Token end-to-end

`collectConflict()` in `geo-sources.ts` reads `UCDP_API_TOKEN`. Vault provider wired.

**Needed:**
- UI hint on `/settings` UCDP provider row pointing to ucdp.uu.se
- Verify `collectConflict` sends `x-ucdp-access-token` header (not query param)
- Add a test fixture for the authenticated path

**File:** `src/utils/geo-sources.ts`, `src/routes/settings.tsx`

---

## 🟡 Module 1 — Credibility Weight Profiles Server-Side Persistence

**Current state:** profiles saved to localStorage key `sentinel_credibility_profiles`.

**Target:** Persist to `data/credibility-profiles.json` via TanStack Start server functions
(same pattern as `credential-vault.ts`).

**New file:** `src/utils/credibility-profiles.ts`
- `readProfiles()` server function
- `writeProfiles(profiles)` server function
- Types: `WeightProfile`, `ProfileId`

**Modify:** `src/routes/sources.tsx` — migrate from localStorage to server function calls.
Keep localStorage read as one-time migration fallback.
Add `data/credibility-profiles.json` to `.gitignore` and `.dockerignore`.

---

## 🟡 Module 5 — GIS Enhancements

### Task G1 — GDELT source-country label fix

GDELT gives `sourcecountry` = publishing outlet country, NOT event location.
Verify `collectNewsGeo` in `geo-sources.ts` labels points as "Publisher location (not event location)".
If not, add it.

### Task G2 — ReliefWeb integration

Register at https://reliefweb.int/developers for an `appname`.
- Add `RELIEFWEB_APP_NAME` vault provider in `credential-vault.ts`
- Implement `collectReliefWebEvents()` in `geo-sources.ts`
- Wire into `collectGeoLayers()` behind credential gate

---

## 🟢 Tech Debt / Quality

### Task Q1 — Eliminate remaining no-explicit-any lint issues (224 open)

Run: `bunx eslint src/ --quiet 2>&1 | head -80`
Fix in batches per file. Do NOT use eslint-disable suppressions.

### Task Q2 — Fabrication guard pre-commit check

Create `scripts/fabrication-check.ts` that runs:
```sh
grep -rn "|| new Date()" src/
grep -rnE '\|\|\s*"[A-Z]' src/
grep -rnE '\?\?\s*0\b|\|\|\s*0\b' src/
```
Exit non-zero if any match found.

### Task Q3 — Vault durability warning in /settings UI

Add visible banner to `src/routes/settings.tsx`:
> "⚠️ Credentials are stored on this replica only. They will be lost on the next deployment
>  or replica restart. For production, use Azure Key Vault secretref: env vars."

---

## 🔵 vLLM Self-Hosted Migration (Future / Blocked on GPU Quota)

> **Do NOT start until Azure NC8as-T4 GPU quota is granted.**

### Task V1 — GPU quota request

Submit Azure support ticket:
- Subscription: `8a8baea4-547c-4f55-b206-d6af16a24970`
- Region: Central India
- SKU: `Standard NCASv3_T4 Family` — 8 vCPU
- Profile: `Consumption-GPU-NC8as-T4`

Fill in CLAUDE.md GPU section with ticket ref and date raised.

### Task V2 — vLLM app config (after quota)

Add GPU workload profile to `sentinel-env`. Deploy `sentinel-vllm` Container App
running `vllm/vllm-openai` with `sarvam-105b`. Point `LLM_BASE_URL` at vLLM service.
No application code changes needed.

---

## ✅ Verification Checklist (run before any commit)

```sh
bun test                               # >=653 passing, 0 failing
tsc --noEmit                           # clean
bun scripts/check-exports.ts           # >=151 exports
grep -rn "|| new Date()" src/          # empty
grep -rnE '\|\|\s*"[A-Z]' src/         # empty
grep -rnE '\?\?\s*0\b|\|\|\s*0\b' src/ # empty
```

---

## 📁 Key Files Reference

| File | Purpose |
|---|---|
| PROJECT_MEMORY.md | Active task state, export registry, hard constraints |
| CLAUDE.md | Stack, constraints, module-level design decisions |
| src/utils/credential-vault.ts | Credential store — pattern to follow for new persistence |
| src/utils/collection-policy.ts | Ingestion-legality matrix |
| src/utils/social.ts | Module 3 collectors (Reddit, Bluesky, Mastodon, Telegram) |
| src/utils/geo-sources.ts | Module 5 GIS data sources |
| src/routes/settings.tsx | Credential vault UI |
| src/routes/sources.tsx | Module 1 credibility weight profiles UI |
| src/utils/imaging-client.ts | WASM asset loader (c2pa, tesseract) |
| scripts/check-exports.ts | Export audit gate |
