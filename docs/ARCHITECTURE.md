# Sentinel AI — architecture and extension guide

**Read this together with `/CLAUDE.md`.** That file is the decision log: what was
tried, what the live APIs actually return, and which choices must not be revisited.
This file is the map: where code lives, which direction dependencies point, and the
exact steps to add a capability without breaking an invariant.

Anyone — human or AI — planning a change should be able to answer three questions
from this document alone:

1. **Is the feature allowed?** → §1 Gates
2. **Where does it go?** → §3 Layer map, §4 Ownership table
3. **What exactly do I touch, in what order?** → §6 Recipes

---

## 1. Gates — check these before designing anything

A proposal that fails any gate is not a smaller version of a good idea; it is the
wrong idea. Reject it and say why.

| #   | Gate                                | Fails if the proposal…                                                                                                                                                                                                                                                 |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Open-source models only**         | uses Gemini, Azure OpenAI, or any hosted commercial LLM API; uses Llama or any derivative (Meta's AUP bans military use — this is an IAF system); uses DeepSeek R1 Distill (Llama-derived). Approved: Sarvam, Mistral 3, IndicTrans2, `openai/gpt-oss-*` open weights. |
| G2  | **Never fabricate**                 | returns a placeholder score, a default confidence, seeded-looking output on failure, or `0` where the real answer is "not measured". Every failure path must surface an explicit error.                                                                                |
| G3  | **Free tier only**                  | requires a paid API, a licence, or always-on GPU. Zero budget.                                                                                                                                                                                                         |
| G4  | **Licence-clean dependencies**      | pulls in AGPL (Ultralytics YOLO is the recorded trap — use Grounding DINO, Apache 2.0), or anything that would force open-sourcing the system.                                                                                                                         |
| G5  | **No fabricated security controls** | adds a credential form, a permission check, or a "secure/nominal" status indicator that nothing behind it enforces. See `src/routes/login.tsx` for how a non-functional screen must disclose itself.                                                                   |
| G6  | **Additive-only contracts**         | renames or removes a field in `src/types/core.ts` without a joint re-freeze with Dev 1 and Dev 2.                                                                                                                                                                      |

Two further constraints are structural rather than ethical, and kill more designs
than the six above:

- **No HTTP API routes exist.** This TanStack Start version exposes no
  `createServerFileRoute`. `fetch("/api/whatever")` cannot work. Every server call
  goes through `createServerFn`. Webhooks, callbacks and OAuth redirects are
  therefore not implementable as specified without changing the framework version.
- **The container scales to zero.** There is no process between requests. No cron,
  no queue worker, no long-lived server-side socket, no in-memory state that
  survives idle. Anything continuous runs **in the browser** (this is why the
  Bluesky Jetstream socket lives client-side) or it does not run.

---

## 2. What exists today

| Layer               | Status                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| Frontend            | Complete and worth keeping — 29 routes, 46 shadcn primitives, 15-language i18n |
| Analysis logic      | Real — ~9,000 lines of tested pure functions across Modules 1–5                |
| LLM access          | Real — provider-agnostic, cached, validated, fails loudly                      |
| Collection          | Real for Bluesky / Reddit / Telegram / RSS / USGS / GDELT                      |
| **Persistence**     | **localStorage only.** No database, no server-side state                       |
| **Auth**            | **None.** No session, no route gating, no user identity                        |
| **HTTP API**        | **None.** `createServerFn` only                                                |
| **Background work** | **None.** Scale-to-zero                                                        |

PS-18 coverage is roughly 15–20%. The gap is almost entirely infrastructure, not
analysis.

---

## 3. Layer map and dependency direction

Arrows point the only legal way. A change that reverses one is a defect regardless
of whether it compiles.

```
                       ┌──────────────────────────────┐
   browser only        │  src/routes/*.tsx  (29)      │  pages
                       │  src/components/*.tsx        │  app UI
                       │  src/components/ui/*  (46)   │  shadcn primitives
                       └──────────────┬───────────────┘
                                      │ imports
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────┐         ┌───────────────────────┐      ┌──────────────────┐
│ *-client.ts   │         │  src/utils/*.ts       │      │ src/utils/*-store│
│ DOM + WASM    │────────▶│  pure logic + zod     │      │ localStorage     │
│ imaging-client│  one    │  analysis, credibility│      │ investigations,  │
│               │  way    │  social, cib, imaging,│      │ watchlist,       │
└───────────────┘         │  geo, reports, search │      │ active-target    │
                          └───────────┬───────────┘      └──────────────────┘
                                      │ type-only for LanguageAssessment
┌───────────────────────┐             │
│  *-llm.ts             │─────────────┘
│  analysis-llm         │  the LLM layer imports the deterministic layer,
│  credibility-llm      │  NEVER the reverse. Deterministic factors must
└──────────┬────────────┘  keep working with the model unreachable.
           ▼
   ┌────────────────┐        ┌────────────────────────┐
   │ src/utils/llm.ts│       │ src/types/core.ts      │  FROZEN contracts
   │ chat / chatJson │       │ src/types/core-adapters│  ──▶ imports src/utils
   │ LlmUnavailable  │       └────────────────────────┘      never the reverse
   └────────────────┘
```

**Hard rules, each currently true and asserted by structure or test:**

1. `credibility.ts` imports `LanguageAssessment` **type-only** from `llm.ts`
   ([credibility.ts:41](../src/utils/credibility.ts#L41)) — there is no runtime edge.
   Keep it that way.
2. `imaging.ts` is pure and testable; everything touching `document`, `canvas`,
   WASM or workers lives in `imaging-client.ts`.
3. `core-adapters.ts` imports `src/utils/*`; the modules stay unaware the contract
   exists.
4. **Nothing under `src/` may import from `tests/`.** Fixtures are synthetic
   records; one refactor away from rendering as real findings.
5. Prompts live server-side in `*-llm.ts` / `llm.ts`. The browser calls a typed
   server function; a raw prompt never crosses the wire (injection surface).

---

## 4. Ownership table — module → files

| PS-18 module               | Routes                                                                                                                                                                                                                                                                                                                                              | Logic                                                                                                                                                                                                                                                                                 | Tests                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **M1** source credibility  | [sources.tsx](../src/routes/sources.tsx)                                                                                                                                                                                                                                                                                                            | [credibility.ts](../src/utils/credibility.ts) 852 · [credibility-llm.ts](../src/utils/credibility-llm.ts) 116 · [social-credibility.ts](../src/utils/social-credibility.ts) 302                                                                                                       | `credibility.test.ts`                |
| **M2** open-source content | [news.tsx](../src/routes/news.tsx) 1679 · [osint.tsx](../src/routes/osint.tsx) 1235 · [recon.tsx](../src/routes/recon.tsx) · [entities.tsx](../src/routes/entities.tsx) · [sentiment.tsx](../src/routes/sentiment.tsx) · [trends.tsx](../src/routes/trends.tsx) · [graph.tsx](../src/routes/graph.tsx) · [timeline.tsx](../src/routes/timeline.tsx) | [analysis.ts](../src/utils/analysis.ts) 471 · [analysis-llm.ts](../src/utils/analysis-llm.ts) 364 · [search.ts](../src/utils/search.ts) · [dorks.ts](../src/utils/dorks.ts) · [attack-surface.ts](../src/utils/attack-surface.ts) · [recon-sources.ts](../src/utils/recon-sources.ts) | `analysis.test.ts` · `recon.test.ts` |
| **M3** social              | [live.tsx](../src/routes/live.tsx) · [social.tsx](../src/routes/social.tsx) · [network.tsx](../src/routes/network.tsx)                                                                                                                                                                                                                              | [social.ts](../src/utils/social.ts) 903 · [cib.ts](../src/utils/cib.ts) 861                                                                                                                                                                                                           | `cib.test.ts` 902                    |
| **M4** image / video       | [images.tsx](../src/routes/images.tsx) · [videos.tsx](../src/routes/videos.tsx)                                                                                                                                                                                                                                                                     | [imaging.ts](../src/utils/imaging.ts) 983 · [imaging-client.ts](../src/utils/imaging-client.ts) 342                                                                                                                                                                                   | `imaging.test.ts` 632                |
| **M5** reports + GIS       | [reports.tsx](../src/routes/reports.tsx) · [gis.tsx](../src/routes/gis.tsx) · [exports.tsx](../src/routes/exports.tsx)                                                                                                                                                                                                                              | [reports.ts](../src/utils/reports.ts) · [report-pdf.ts](../src/utils/report-pdf.ts) · [geo.ts](../src/utils/geo.ts) · [geo-sources.ts](../src/utils/geo-sources.ts) · [data/geo-map.ts](../src/data/geo-map.ts) 2796                                                                  | `reports.test.ts` · `gis.test.ts`    |
| Workspace                  | [investigations.tsx](../src/routes/investigations.tsx) · [vault.tsx](../src/routes/vault.tsx) · [tasks.tsx](../src/routes/tasks.tsx) · [subjects.tsx](../src/routes/subjects.tsx) · [agents.tsx](../src/routes/agents.tsx)                                                                                                                          | [investigations-store.ts](../src/utils/investigations-store.ts) · [watchlist-store.ts](../src/utils/watchlist-store.ts)                                                                                                                                                               | `investigations.test.ts`             |
| Cross-cutting              | [\_\_root.tsx](../src/routes/__root.tsx) · [settings.tsx](../src/routes/settings.tsx)                                                                                                                                                                                                                                                               | [llm.ts](../src/utils/llm.ts) 642 · [types/core.ts](../src/types/core.ts) · [types/core-adapters.ts](../src/types/core-adapters.ts) · [i18n/](../src/i18n/)                                                                                                                           | `core-contracts.test.ts`             |

**Stub routes with no logic behind them** — the cheapest places to add real work:
[watchlists.tsx](../src/routes/watchlists.tsx) 58 · [threats.tsx](../src/routes/threats.tsx) 56 ·
[crawlers.tsx](../src/routes/crawlers.tsx) 56 · [alerts.tsx](../src/routes/alerts.tsx) 45.

---

## 5. The seams — every registration point in the system

To extend a capability, add an entry to one of these. Each is an array or record
that something iterates; nothing else needs to change.

| Seam                         | File                                                                           | Add here to…                                    |
| ---------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `defaultFactors()`           | [credibility.ts:513](../src/utils/credibility.ts#L513)                         | add a credibility factor                        |
| `DOMAIN_REPUTATION`          | [credibility.ts:150](../src/utils/credibility.ts#L150)                         | rate a new publisher (data, not logic)          |
| `builtinProfiles()`          | [credibility.ts:781](../src/utils/credibility.ts#L781)                         | ship a new weight profile                       |
| `socialFactors()`            | [social-credibility.ts:160](../src/utils/social-credibility.ts#L160)           | add a social-specific factor                    |
| `SignalId` + `assessCluster` | [cib.ts:131](../src/utils/cib.ts#L131), [cib.ts:792](../src/utils/cib.ts#L792) | add a CIB signal                                |
| `GEO_LAYERS`                 | [geo.ts:64](../src/utils/geo.ts#L64)                                           | declare a map layer                             |
| `collectGeoLayers()`         | [geo-sources.ts:175](../src/utils/geo-sources.ts#L175)                         | wire a geo collector                            |
| `PRODUCT_TYPES`              | [reports.ts:56](../src/utils/reports.ts#L56)                                   | add an intelligence product type                |
| `DORK_TEMPLATES`             | [dorks.ts:40](../src/utils/dorks.ts#L40)                                       | add a search dork                               |
| `OCR_LANGUAGES`              | [imaging.ts:692](../src/utils/imaging.ts#L692)                                 | add an OCR script                               |
| `NOT_IMPLEMENTED`            | [imaging.ts:935](../src/utils/imaging.ts#L935)                                 | declare an M4 capability gap honestly           |
| `PLATFORM_NOTES`             | [social.ts:831](../src/utils/social.ts#L831)                                   | state why a platform is uncollectable (M3)      |
| `RECON_NOTES`                | [recon-sources.ts](../src/utils/recon-sources.ts)                              | declare an external-recon capability gap (M2)   |
| `NAV_GROUPS`                 | [app-shell.tsx:64](../src/components/app-shell.tsx#L64)                        | put a page in the sidebar                       |
| `LOCALES`                    | [i18n/dictionary.ts:19](../src/i18n/dictionary.ts#L19)                         | add a language                                  |
| Schemas + `parse*`           | [types/core.ts](../src/types/core.ts)                                          | extend a frozen contract (optional fields only) |

---

## 6. Recipes

Each recipe lists files **in the order to touch them**. Every recipe ends with a
test, because every one of these seams is already under test.

### A. Add a page

1. `src/routes/<name>.tsx` — copy the shape of
   [watchlists.tsx](../src/routes/watchlists.tsx): `createFileRoute("/<name>")({ head, component })`,
   body wrapped in `<AppShell>` with a `<PageHeader>`.
2. `routeTree.gen.ts` regenerates on `bun run dev` — never hand-edit it.
3. Register in `NAV_GROUPS` ([app-shell.tsx:64](../src/components/app-shell.tsx#L64)) under
   the owning module, with a `lucide-react` icon.
4. If the page renders seeded records, add `<SampleDataBanner>` (G2).

Do **not** create `src/pages/`, `app/`, or `_app/` — those are Next/Remix
conventions and the router ignores them. See [src/routes/README.md](../src/routes/README.md).

### B. Add a source-credibility factor (M1)

1. Write `computeX(article, corpus, options): FactorResult | null` in
   [credibility.ts](../src/utils/credibility.ts). **Return `null` when it cannot be
   evaluated** — null is "skipped", never zero.
2. Append to `defaultFactors()` with `id`, `name`, a `description` an analyst can
   read, `weight`, `enabled`, `requiresLlm`.
3. `compute` **must stay synchronous.** If your factor needs async data, pre-compute
   it and thread it through `FactorOptions` the way `clusters`, `social` and
   `language` already are ([credibility.ts:74](../src/utils/credibility.ts#L74)).
   Making it async pushes `async` through `scoreArticle`, `scoreCorpus` and the
   scoring `useMemo` in sources.tsx.
4. `evidence` must name the actual numbers behind the score.
5. Set `confidence` honestly — model-backed factors sit at 0.55, below the fixed
   deterministic ones.
6. Test in `tests/credibility.test.ts`: one case where it scores, one where it
   returns null.

### C. Add a collector / data source (M2, M3, M5)

First decide **where it runs**:

- Needs an API key → **server** (`process.env`, `createServerFn`). Keys are never
  in the browser.
- Long-lived connection (WebSocket, SSE, polling loop) → **browser**. Scale-to-zero
  kills any server socket.
- CORS-blocked from the browser → **server**.
- Touches uploaded media → **browser**. Uploaded media never leaves the device.

Then:

1. Add `async function collectX(): Promise<...>` to the owning util. Follow
   [geo-sources.ts](../src/utils/geo-sources.ts): explicit timeout via
   `AbortSignal.timeout`, non-2xx → throw with status and body prefix.
2. **Distinguish failure modes in the message.** A 429 is a rate limit, a 401 is a
   missing credential, an empty array is "no results". `collectConflict` shows the
   pattern: no token → the layer reports the missing credential rather than zero
   events ([geo-sources.ts:88](../src/utils/geo-sources.ts#L88)).
3. Export a thin `createServerFn` wrapper. Keep the logic in the plain function —
   server functions cannot execute outside the Start runtime, so that separation is
   what makes it testable.
4. Register in the relevant seam (`collectGeoLayers`, `GEO_LAYERS`, …).
5. If a platform is _deliberately_ not collected, add a `PLATFORM_NOTES` entry
   instead of a scraper. Instagram, Facebook, X and CrowdTangle are settled — do not
   re-add them.

### D. Add an LLM-backed capability

1. Define a zod schema for the output next to the function.
2. Write the prompt + call in a `*-llm.ts` module (or `llm.ts` if it is generic).
   Use `chatJson(prompt, Schema, { system, maxTokens })` for structured output,
   `chat()` for prose.
3. **Budget 1400–2800 `maxTokens`.** Both models are reasoning models: chain-of-thought
   is billed against `max_tokens`, and an answer-sized budget returns
   `finish_reason: "length"` with `content: null`. `llm.ts` throws on that rather
   than returning a partial product.
4. Never catch `LlmUnavailableError` and substitute text. Let it reach the UI, which
   renders an explicit "AI unavailable" state.
5. Add the `createServerFn` wrapper at the bottom of the file, alongside the others.
6. If the result feeds a deterministic module, put the call in a **separate
   `*-llm.ts` file** that imports the deterministic one — never the reverse.

### E. Add a map layer (M5)

1. Declare it in `GEO_LAYERS` ([geo.ts:64](../src/utils/geo.ts#L64)).
2. Write `fromXRecord(raw): GeoRecord | null` — returning `null` for anything without
   a real coordinate.
3. Every record needs a `GeoPrecision`. `exact` renders as a point; `city`/`country`
   render as a dashed uncertainty circle. Mislabelling precision is the single
   worst bug this module can have.
4. Count nulls as `unplaceable` in the `LayerResult` and let the UI report the
   count. **Never approximate a record onto the map.** `0,0` is a missing-value
   sentinel, rejected by `isRealCoordinate`.
5. A layer that needs a credential it does not have should be _declared and empty
   with the reason_, like Shodan and UCDP — not omitted, not faked.
6. Test in `tests/gis.test.ts`.

### F. Add a CIB signal (M3)

1. Extend the `SignalId` union ([cib.ts:131](../src/utils/cib.ts#L131)).
2. Write `signalX(posts): CibSignal` returning `null` score **with a stated reason**
   when it cannot be computed — never 0. An uncomputable signal that reports 0 makes
   a network look clean.
3. Populate `evidence` with the actual accounts and timings.
4. Wire into `assessCluster` ([cib.ts:792](../src/utils/cib.ts#L792)).
5. Signals are **review triggers, never verdicts** — organised legitimate campaigns
   produce identical patterns. `CIB_CAVEAT` must stay attached wherever they render.
6. Test in `tests/cib.test.ts`.

### G. Add a media check (M4)

1. Pure interpretation → [imaging.ts](../src/utils/imaging.ts). Anything touching
   canvas/WASM/workers → [imaging-client.ts](../src/utils/imaging-client.ts).
2. **Do not build or claim a deepfake classifier** (G2). The system's position is
   that provenance beats classification: the only high-confidence AI finding is a
   _signed C2PA manifest declaring_ generative provenance.
3. Absence is reported as absence. Every major platform strips EXIF on upload, so a
   missing block is the normal case, not evidence of tampering.
4. If the capability is real but out of reach, add it to `NOT_IMPLEMENTED` with what
   it would require and what it would still get wrong.
5. Object detection → Grounding DINO (Apache 2.0). **Never Ultralytics YOLO** —
   AGPL-3.0 would force open-sourcing the whole system. A test asserts this.

### H. Add persisted state

Today this means localStorage. Follow
[investigations-store.ts](../src/utils/investigations-store.ts):

1. `STORE_KEY` + `STORE_VERSION_KEY` + `STORE_VERSION`. Bump the version when the
   shape changes; on mismatch **drop** old data rather than migrating invented
   values forward.
2. Guard every access with `typeof window === "undefined"` (SSR) and `try/catch`
   (quota, private mode).
3. Derive every displayed figure from stored records. `caseMetrics()` deliberately
   computes **no risk score and no threat score**, because nothing measures them.
4. Test in a `tests/*.test.ts` with a localStorage stub.

Know the ceiling: localStorage is per-browser, not per-user, not audited, not
shared. `sentinel_credibility_profiles` is the recorded example of an M1 gap this
causes. Anything needing real multi-user state needs a database, which needs the
decisions in §7.

### I. Add an intelligence product type (M5)

1. Extend `ProductType` and add a `ProductSpec` to `PRODUCT_TYPES`
   ([reports.ts:56](../src/utils/reports.ts#L56)).
2. Every judgement and finding must carry numbered citations. `validateCitations`
   resolves them against the real source list **after** generation; a violation
   retries once with the specific problems and then throws. Partial products are
   never returned.
3. Show the model name — on screen, in the provenance block, and in the PDF footer
   of every page. §6.5 is the only place PS-18 names the open-source LLM
   requirement, so that visibility is the compliance evidence.
4. `exports.tsx` renders the same product object the analyst reviewed. Do not
   reintroduce a separate export path — that is what `export-helpers.ts` was, and
   it let a figure differ between screen and file.
5. Test in `tests/reports.test.ts`.

### J. Add or extend a UI language

1. `src/i18n/locales/<code>.ts` exporting `{ phrases, words }` (see
   [types.ts](../src/i18n/types.ts)); ~338 lines is the established size.
2. Register in `LOCALES` ([dictionary.ts:19](../src/i18n/dictionary.ts#L19)) and add
   the code to `languages.ts` with `htmlLang`, `fontStack`, and `rtl` for
   Perso-Arabic scripts.
3. Strings that must never be translated (identifiers, handles, timestamps) carry
   `data-no-translate`.
4. `phrases` are exact-match; `words` are a fallback that only applies at ≥60%
   coverage on strings of ≤6 alphabetic tokens.

### K. Extend a frozen contract

1. **Optional fields only.** `z.string().optional()` — never rename, never remove,
   never make an existing field required. Freeze date: 2026-08-06.
2. Anything that can fail to be measured is `| null`. `null` means not measured; it
   never means zero.
3. Add the field to the zod schema _and_ the TS type (they are one — `z.infer`).
4. Handle it in [core-adapters.ts](../src/types/core-adapters.ts). If the conversion
   is lossy, report what was lost — `toSocialPost` returns a `degraded[]` list
   naming every CIB input the contract could not supply.
5. Add a fixture to `tests/helpers/core-fixtures.ts` and a case to
   `tests/core-contracts.test.ts`.
6. Tell Dev 1 / Dev 2. An optional field that nobody populates leaves the dependent
   signal permanently uncomputed.

---

## 7. Capability ceilings — features that need infrastructure first

If a request lands in this table, the honest answer is a prerequisite, not an
implementation.

| Wanted                                                       | Blocked by                     | What it actually needs                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login, user accounts, RBAC, audit log                        | No DB, no session store        | A complete system already exists on branch `backup/pre-auth-rollback` / tag `pre-auth-rollback-20260806` (commit `214f0df`) — Prisma/SQLite, Argon2id, sealed-cookie sessions, rate limiting, 7 test files. It was reverted out of `main`. Restoring needs `DATABASE_URL`, a ≥32-char `SESSION_SECRET`, and a persisted volume. **Current decision: not being restored.** |
| Shared state between users, saved profiles, real persistence | No database                    | A DB + a persisted volume. localStorage cannot do it.                                                                                                                                                                                                                                                                                                                     |
| Scheduled monitoring, alerting, digest emails                | Scale-to-zero                  | An always-on process or an external scheduler. Browser-side monitoring only runs while a tab is open.                                                                                                                                                                                                                                                                     |
| Webhooks, OAuth callbacks, third-party integrations          | No HTTP routes                 | A framework version exposing `createServerFileRoute`, or an external relay.                                                                                                                                                                                                                                                                                               |
| Self-hosted model inference                                  | No GPU quota                   | `Consumption-GPU-NC8as-T4` in Central India (A100 unavailable in any Indian region). **Not yet requested.** Roughly USD 0.5–0.8/hour against a USD 30/month alert — the funding conflict is unresolved.                                                                                                                                                                   |
| Historical keyword search on Bluesky                         | `searchPosts` returns 403      | An authenticated account. Monitoring runs forward from connection.                                                                                                                                                                                                                                                                                                        |
| Instagram / Facebook / X collection                          | Platform terms and pricing     | Nothing. Settled — do not re-add scrapers.                                                                                                                                                                                                                                                                                                                                |
| Precise event geolocation from news                          | GDELT GEO API retired (404)    | GDELT DOC gives the _outlet's_ country, not the event's. Plotted at country precision, labelled as such.                                                                                                                                                                                                                                                                  |
| Conflict-event layer                                         | UCDP now 401s                  | `UCDP_API_TOKEN`.                                                                                                                                                                                                                                                                                                                                                         |
| Host geolocation                                             | Shodan InternetDB returns none | The paid Shodan API (fails G3).                                                                                                                                                                                                                                                                                                                                           |

Shared cache across replicas, rate limiting, and anything else stateful hits the
same wall: `llm.ts`'s LRU is per-process and lost on restart.

---

## 8. Honesty invariants — the review checklist

These are what a reviewer will actually reject a change for. Each one exists because
the alternative was tried and produced something misleading.

- [ ] No fallback value on any failure path. `LlmUnavailableError`,
      `SocialUnavailableError`, `ContractViolationError`, `MediaError` propagate.
- [ ] `null` used for "not measured"; `0` never stands in for it.
- [ ] Every score carries an `evidence` string naming the real numbers behind it.
- [ ] Every confidence value is justified relative to its neighbours.
- [ ] Seeded records carry `<SampleDataBanner>`.
- [ ] Declared-but-unavailable capabilities appear in `NOT_IMPLEMENTED` /
      `PLATFORM_NOTES` with the reason, rather than being silently absent.
- [ ] Coordinates: no record plotted without a real fix; unplaceable ones counted
      and reported; precision labelled truthfully.
- [ ] Model output validated by zod, never coerced.
- [ ] Model name shown wherever a model-derived product is displayed or exported.
- [ ] CIB output framed as signals warranting review, never as a verdict.
- [ ] Batch operations keep good records and report rejects by index —
      `parseMany`, `assessLanguageFor`, `unplaceable`.
- [ ] No security control implied that nothing enforces.

---

## 9. Verify a change

```sh
bun test          # bun:test, tests/*.test.ts
bun run lint      # eslint .
bun run format    # prettier --write .
bun run dev       # vite dev — also regenerates routeTree.gen.ts
bun run build     # production build
```

There are no end-to-end or browser tests. Anything in `*-client.ts`, in a route
component, or behind WASM is verified by running the app. Tests cover the pure
layer, which is where the analysis actually lives.

Azure CLI work runs in Git Bash and requires `export MSYS_NO_PATHCONV=1`, or every
`--scope` path gets mangled.

---

## 10. Reading order for a new agent

1. `/CLAUDE.md` — constraints and the decision log. Non-negotiable.
2. This file — §1 gates, §3 layer map.
3. [src/types/core.ts](../src/types/core.ts) — the vocabulary the modules exchange,
   and the clearest statement of the nullability rule.
4. [src/utils/llm.ts](../src/utils/llm.ts) — how failure is handled everywhere else.
5. The one module you are changing, plus its test file.

The header comment of each `src/utils/*.ts` file explains _why_ it is shaped the way
it is, including several designs that were tried and rejected. Read it before
proposing a restructure — the alternative you are about to suggest may already be
documented there as a mistake.
