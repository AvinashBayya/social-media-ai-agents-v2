> **STATUS: IMPLEMENTED IN THIS REPOSITORY, 2026-08-17.**
> All seven items below were built rather than handed off. Gates after the work:
> `bun test` **719 pass / 0 fail** · `check-exports` **200 symbols** · `tsc --noEmit` clean ·
> `bun run build` green · `smoke:controls` **0 dead controls across 371 examined, 31 routes**.
> The document is kept as the record of what was wrong and why each fix is shaped the way it
> is. Do **not** hand it to another agent as an outstanding task list.

# Antigravity task — six broken functions + live fabrications

**Repo:** `d:\social_media_research` · **Project:** Sentinel AI (OSINT platform, ADITI 4.0 / iDEX PS-18, Indian Air Force)
**Stack:** TanStack Start 1.168 (SSR) · React 19 · TypeScript · Vite 8 · Bun · Tailwind 4 · shadcn/ui
**Written:** 2026-08-17 · every file:line reference below was verified against the tree on that date.

**Baseline at time of writing (all green, nothing is fixed yet):**
`bun test` 653/653 · `bun scripts/check-exports.ts` 151 symbols · `tsc --noEmit` clean · `bun run build` green.

---

## 0. Read these first — do not skip

1. `PROJECT_MEMORY.md` — active task state, export registry, hard constraints.
2. `CLAUDE.md` — stack, module map, data-honesty rules, deployment traps.
3. `.claude/rules/memory-and-preservation.md` — the anti-deletion protocol.

This codebase has been through a six-agent browser audit that removed 14 live fabrications.
Most rules below exist because something specific went wrong. Read the in-file comments — they
record the failure, not just the fix.

---

## 1. Non-negotiable rules

### 1.1 Additive-only editing

- **Never remove or rename an exported symbol.** Add optional parameters, add new helpers, wrap
  logic — do not replace signatures.
- **View the entire target file before editing it.** Snippet edits in this repo have repeatedly
  wiped out exports that were never in the model's context.
- `src/types/core.ts` holds six **frozen** contracts. Additive changes only (new *optional*
  fields). Renames and removals need a joint re-freeze — do not touch them.

### 1.2 Never fabricate data

This is a defence intelligence tool. **A fake confidence value is worse than a visible failure.**

- Unmeasured is `null`. Never `0`, never a plausible string, never `new Date()`.
- If something fails, surface the real upstream error. No fallback returning placeholder
  results, invented scores, or synthetic content.
- Before committing, run these three greps — the three shapes this defect keeps returning as:

```sh
grep -rn "|| new Date()" src/          # 1. timestamp invention
grep -rnE '\|\|\s*"[A-Z]' src/         # 2. a string literal rendering as a measurement
grep -rnE '\?\?\s*0\b|\|\|\s*0\b' src/ # 3. numeric zero-flattening
```

An honest absence marker (`|| "not reported"`, `?? "—"`) is the intended replacement. The test
is whether a reader would mistake the value for a finding. Loop accumulators and config
defaults are fine — pattern 3 is about values that reach a screen.

**A fourth pattern, added 2026-08-17: a series derived from a loop index.** `idx % 5`,
`150 + idx * 12`, `Math.sin(i/4)` — see item 7.1. No unit test can see it.

### 1.3 No control without a handler

A button with `onClick: undefined` tells the analyst a capability exists. `bun run smoke:controls`
reads React props off live DOM nodes to catch this. It must stay clean.

### 1.4 Repo conventions you must match

| Concern | Convention | Reference |
| --- | --- | --- |
| localStorage keys | `sentinel_<snake_case>`, hoisted `const` | `investigations-store.ts:66` |
| SSR safety | `if (typeof window === "undefined") return [];` or read in `useEffect` | `investigations-store.ts:76` |
| Parse failures | `try/catch` returning **empty**, never partial | `investigations-store.ts:89-91` |
| Schema changes | a `_version` key that drops incompatible data rather than migrating fiction | `investigations-store.ts:66-92` |
| Delete flows | store call → refresh → `toast.success`. **There is no `window.confirm` in `src/` — do not add one.** | `investigations.tsx:389-399` |
| Icon-only buttons | must carry `aria-label` | `watchlists.tsx:226-234` |
| Pure utils | no DOM, no network, **no `Math.random()`** | `geo.ts:26-27` |
| Secrets | `process.env` inside `createServerFn` only; the browser gets **booleans** | `social.ts:2200-2209` |

### 1.5 Hard constraints (from CLAUDE.md)

- **Open-source LLMs only.** No Gemini, no Azure OpenAI, no hosted commercial API. **No Llama
  or Llama-derived model** — Meta's AUP bans military use, disqualifying it for an IAF system.
  Approved: Sarvam (`sarvam-105b`), Groq `openai/gpt-oss-120b` (Apache 2.0 open weights despite
  the prefix), Mistral 3, AI4Bharat IndicTrans2.
- **Free-tier tooling only.** Zero budget for licences and APIs.
- **No new npm dependency for the graph work.** Hand-rolled SVG — decided, see item 4.
- **Never add Ultralytics YOLO** (AGPL-3.0 would force open-sourcing the system). Grounding DINO
  (Apache 2.0) is the approved alternative.
- **Do not re-add Instagram or Facebook scrapers.** Settled decision — the previous attempt
  fabricated posts with `Math.random()` engagement counts.

---

## 2. Premise corrections — read before touching anything

Six items were reported by a user driving the UI. **Two premises are factually wrong**, and
acting on them as stated would break working code.

| # | Reported | What is actually true |
| --- | --- | --- |
| 1 | Vault "Link Case" shows mock data | The **case dropdown already reads real data**. What is fake is the *evidence records* — three seeded items whose `caseId` values (`INV-2041`, `INV-2038`) are ids the store can never mint. **Delete really is absent.** |
| 2 | Live Monitoring bookmark not working | The button **is wired and does persist**. It writes a bare URL to `sentinel_bookmarks`, which **no other file in the repo reads**. A dead *end*, not a dead *control*. |
| 3 | Date filter needs an "Any" option | Correct and trivial — plus two real limits behind it that must be **disclosed, not hidden**. |
| 4 | Module 2 network analysis not working | Two different pages. `/graph` is **100% hardcoded**. `/network` is **real** but renders no graph and is empty without a credential. Both in scope. |
| 5 | Module 2 UCDP missing | UCDP exists in Module 5 and works. `/osint`'s Module-2 copy **never sends the token header**, so it 401s *even when a token is configured*. |
| 6 | Settings missing Reddit / Bluesky / Mastodon / GitHub | **All four already exist** — vault entries, env overrides, live Verify probes, working collectors. The real problem: **nothing is configured**, so every consuming module correctly reports a missing credential and the app reads as broken. |

---

## 3. Item 1 — `/vault` "Link Case": real cases, real records, delete

**File:** `src/routes/vault.tsx` (646 lines) · **Module 5**

### What is actually broken

1. **`DEFAULT_EVIDENCE` at `vault.tsx:66-120`** — three seeded records with dangling case ids:
   `EVID-0402` → `INV-2041`, `EVID-0405` → `INV-2041`, `EVID-0391` → `INV-2038`.
   `createInvestigation` numbers cases from **INV-1001** upward
   (`investigations-store.ts:113-115`), so those ids **can never exist**, and the v2 store wipe
   (`investigations-store.ts:78-85`) guarantees a fresh browser starts with zero cases. The card
   renders that id in bold blue (`vault.tsx:523`) and the preview turns it into a link
   (`:576-581`) — a case reference resolving to nothing.

2. **Cases are read once and never refreshed** — mount-only effect, deps `[]`
   (`vault.tsx:151-172`). A case created on `/investigations` or by `PinButton` is invisible
   until a full reload.

3. **The preview link drops the case id.** `vault.tsx:574-582` renders
   `<Link to="/investigations">{selectedItem.caseId}</Link>` with no search param, and
   `investigations.tsx` reads none.

4. **The pin result is ignored and the toast lies.** `vault.tsx:271-285` discards
   `pinToInvestigation`'s boolean; `:287` then fires
   `` toast.success(`… linked to case ${uploadCaseId}`) `` unconditionally — including when
   `uploadCaseId` is `""`, producing "…linked to case ". `pinToInvestigation` returns `false`
   both when the case is gone and when the URL is already pinned (`investigations-store.ts:161`).

5. **No delete anywhere.** `Trash2` occurs **zero** times in `vault.tsx`.

6. **`sentinel_evidence` has two owners** with two independently-declared shapes:
   `vault.tsx:153/161/176` (`interface EvidenceItem` at `:37-64`) and
   `manual-capture-panel.tsx:33` (`EVIDENCE_KEY`, `interface StoredEvidence` at `:36-49`,
   `appendEvidence()` at `:51-66`) — whose own comment admits *"Local mirror of vault.tsx's
   stored shape. Same key, same reader."*

### What to build

**(a) New `src/utils/evidence-store.ts`** — the single owner of `sentinel_evidence`, modelled on
`investigations-store.ts`:

```ts
export const EVIDENCE_KEY = "sentinel_evidence";
export interface EvidenceRecord {
  /* superset of vault.tsx:37-64 and manual-capture-panel.tsx:36-49 */
  pinnedEvidenceId?: string;   // NEW, optional — id of the PinnedEvidence copy in the case
}
export function getEvidence(): EvidenceRecord[]
export function saveEvidence(list: EvidenceRecord[]): void
export function appendEvidence(record: EvidenceRecord): void
export function deleteEvidence(id: string): void
export function setEvidenceCase(id: string, caseId: string | null): void
```

`manual-capture-panel.tsx` **delegates** to it. Keep its existing exports — re-implement
`appendEvidence` as a one-line delegation, do not drop it.

**(b) Drop the seeded records, keep analyst uploads.** Add `sentinel_evidence_version = "2"`
guarded like `investigations-store.ts:78-85`, but **filter rather than wipe**: remove only
`seeded: true` records. Keep the `seeded` field on the type. Delete `DEFAULT_EVIDENCE` and the
seed-write at `:161`; use the `EmptyState` component already imported (`:480-484`). Once nothing
can be seeded, the `SampleDataBanner` at `:335` goes too.

**(c) Make Link Case live.** Add a `sentinel_investigations_changed` `CustomEvent` dispatched
from `saveInvestigations()` — **additive**, mirroring `src/utils/active-target.ts:27` (listeners
at `app-shell.tsx:200`, `live.tsx:195`, `index.tsx:186`, `osint.tsx:766`, `entities.tsx:123`).
`vault.tsx` listens and re-reads. The dropdown (`:364-368`) shows `{c.id} · {c.title}`. When
`cases.length === 0`, offer an inline create affordance — `pin-button.tsx:139-147` is the pattern.

**(d) Route the case link.** `:576-581` becomes
`<Link to="/investigations" search={{ case: selectedItem.caseId }}>`. Add `validateSearch` to
`investigations.tsx` accepting `{ case?: string }` and preselect. **Precedent:** `/images`
shipped a hand-off with no `validateSearch` and the navigation silently did nothing. If the id
does not resolve, render `case {id} no longer exists` as plain text — never a link to nowhere.

**(e) Honour the pin result.** `uploadCaseId === ""` → no pin and no case in the toast.
`true` → `toast.success` naming the case. `false` → `toast.info("Already pinned to that case, or
the case no longer exists.")` (wording from `pin-button.tsx:37-41`). On success store the
returned id as `pinnedEvidenceId`. **Additively** widen `pinToInvestigation` to return the new
`PinnedEvidence["id"]` or `null` — same name, same parameters — and check all four call sites
still compile (`vault.tsx:273`, `agents.tsx:326`, `manual-capture-panel.tsx:142`,
`pin-button.tsx:33`).

**(f) Delete controls.** Copy: `investigations.tsx:389-399` (delete case),
`investigations.tsx:528-537` (remove evidence), `subjects.tsx:165-176` (**card-level delete with
`e.stopPropagation()`**). `stopPropagation` is **mandatory** — every card already has
`onClick={() => setSelectedItem(item)}` at `vault.tsx:500`.

Add a trash icon per card (`aria-label`), and an **"Unlink case"** control on the preview panel.
Both must call `removeEvidence(caseId, pinnedEvidenceId)` (`investigations-store.ts:183-189`) —
**otherwise the case keeps a citable source pointing at a deleted exhibit**, and
`sourcesFromEvidence()` (`:299-313`) feeds those into Module 5's citation validator. Clear
`selectedItem` if it was the record deleted.

### Must not regress

`sha256OfFile` (`src/utils/evidence.ts:34`) refuses rather than falling back when SubtleCrypto
is unavailable — this digest was once 64 random hex characters, and one seeded literal was 66
hex characters (not a SHA-256 at all) and went unnoticed for months. No fallback, ever.
`tests/no-overclaims.test.ts:201-207` bans "tamper-proof", "audit log" and "chain of custody" in
source text.

---

## 4. Item 2 — `/live` bookmark must reach the investigation

**File:** `src/routes/live.tsx` (567 lines) · **Module 3**
Despite the name, this route reads **one Google News RSS feed** (server fn at `:12-104`). The
Bluesky Jetstream firehose lives in `src/utils/social.ts` and `/social`.

### What is actually broken

The button is wired and does persist: state `:180`, hydrate `:199-208`, toggle `:210-216`,
lookup `:406`, button `:464-472`. **The defect is that it goes nowhere:**

- `sentinel_bookmarks` is read or written in **exactly one file** — `src/routes/live.tsx`.
  Verified across `src/`, `scripts/`, `tests/`, `docs/` and every `*.md`. No route, no sidebar
  entry, no export, no reader.
- It stores **only the URL**. `author`, `pubDate`, `text`, `sentiment`, `threat`, `tags` — all
  produced at `:85-96` — are discarded, so a bookmark can never become citable evidence.
- `/live` is the **only** route with a bookmark-looking control that does not import
  `PinButton` (call sites: `news.tsx:1983`, `social.tsx:712`, `images.tsx:468`).
- `PinButton`'s icon **is** `Bookmark` (`pin-button.tsx:2, 68`), and `investigations.tsx:346`
  / `:468` tell the analyst to *"use the bookmark control on each item"*. "Bookmark" already
  means "pin to case" **everywhere except `/live`**. That inconsistency is the whole bug.

### What to build

**(a) Upgrade the record** behind `sentinel_bookmarks_version = "2"`:

```ts
interface Bookmark {
  url: string;
  title: string | null;
  source: string | null;        // r.author — null when the feed reported no publisher
  publishedAt: string | null;   // r.pubDate — NEVER `|| new Date()`
  text: string | null;
  caseId: string | null;        // set once pinned
  bookmarkedAt: string;         // real: the moment the analyst clicked
}
```

Migration from `string[]`: keep the URL, set **every other field to `null`**. Never back-fill an
invented title, publisher or date. Hoist the key as a `const` and move the store into a util.

**(b) Add `PinButton` to every card**, beside the existing button at `:464-472`:

```tsx
<PinButton payload={{
  kind: "news",
  title: <headline>,
  source: r.author ?? "",          // omit; do NOT substitute a plausible outlet name
  url: r.url,
  publishedAt: r.pubDate ?? "",    // NEVER `|| new Date().toISOString()`
  excerpt: r.text,
  credibility: null,
  credibilityRationale: "Not scored — /live does not run Module 1 scoring on this feed.",
}} />
```

`kind: "news"` maps to `"Module 1 · credibility"` in `MODULE_FOR_KIND`
(`investigations-store.ts:283-289`).

**(c) New "Bookmarked & pinned" panel, two columns:**
- **Shortlist** — bookmarked, not yet pinned. Rows offer Pin-to-case and Remove.
- **Pinned into investigation** — resolved **live** from `getInvestigations()` by matching
  evidence `url`. Rows link to the case (`search={{ case: id }}`, the param added in item 1) and
  offer Unpin via `removeEvidence`.

There is an **orphan i18n key** `"Pin to Investigation"` in ~14 locale files
(`src/i18n/locales/ta.ts:77`, `bn.ts:77`, `ks.ts:84`) with **zero `t()` call sites**. Use it for
this heading via `useT()`.

**(d) Keep both columns in sync** — a successful pin writes `caseId` onto the bookmark record.

---

## 5. Item 3 — `/live` date filter: add "Any time"

**Current:** `DATE_RANGE_HOURS` `:135-140` (`24h` / `7d` / `30d`), state `:177`, select
`:339-350`, predicate `:284-295`.

**(a) Add the option.** `<option value="any">Any time</option>`. The predicate at `:285` already
reads `DATE_RANGE_HOURS[selectedDate]` and guards with `if (cutoffHours && …)`, so an unknown key
is `undefined` → falsy → the window check is skipped. **Verify this; do not rewrite the
predicate.** Default stays `"24h"`.

**(b) Fix the two real limits rather than papering over them.**

1. **The filter runs over the wrong list.** `filteredStreams` filters `visibleStreams` (`:284`) —
   the trickle-in display list seeded with `fetched.slice(0, 4)` at `:225` and capped at 8 by the
   6-second reveal interval (`:267-277`). The full set is in `buffer` (`:174`, `:224`, prepended
   by the 25s poller at `:247-265`). **So "Last 30 days" today widens a window over at most 8
   on-screen cards.** Filter `buffer` instead and render
   `{filteredStreams.length} of {buffer.length} collected`.
2. **The upstream query has no date restriction.** `:26` hits
   `news.google.com/rss/search?q=…` with no date parameter, and that feed is ~24 hours deep. A
   wider window can only stop removing items — it cannot fetch older ones. Say so in one line
   under the select.

**(c) Make it testable.** Extract
`withinWindow(pubDate: string | null, windowKey: string, now: number): boolean` into a util and
add `tests/live-filters.test.ts`. **Undated items must keep passing** — `:288` comments
*"Undated items are kept rather than silently dropped"* and `:432` renders them as
`"no date reported"`. Deliberate.

---

## 6. Item 4 — Module 2 network analysis (both pages)

The Module 2 sidebar group (`app-shell.tsx:77-87`) has **two** graph pages:
`Knowledge Graph → /graph` (`:82`) and `Network Analysis → /network` (`:83`). Opposite problems.

### 6a. New pure util `src/utils/graph-build.ts`

No DOM, no network, **no `Math.random()`**. Fully unit-testable.

**`normaliseEntityType(raw)`** — three vocabularies disagree today:

| Source | Vocabulary |
| --- | --- |
| `src/utils/llm.ts:354-360` | `PERSON` `ORGANISATION` `LOCATION` `EQUIPMENT` `EVENT` `OTHER` |
| `src/types/core.ts:156-177` | `PERSON` `ORG` `LOCATION` `EVENT` `EQUIPMENT` `OTHER` ← **canonical** |
| `src/routes/graph.tsx:19` | lowercase `person` `org` `country` `domain` `phone` `email` `social` |

Adopt `core.ts`. **Drop `domain`, `phone`, `email`, `social` from the legend** — no extractor
produces them, and a legend entry for a type that can never appear asserts a capability that
does not exist.

**`entityKey(name)`** — move the Unicode-safe key from `entities.tsx:87-99` here and import it
back. Read its comment first: the previous class covered U+0900–U+0DFF only, so **every Urdu
entity name was stripped to an empty key and silently merged into one node**. It must stay
`name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")`.

**`buildEntityGraph(perArticleEntities, opts)` → `{ nodes, edges }`**
- Node key `` `${entityKey(name)}::${type}` ``, matching `entities.tsx:177`.
- An edge exists **iff two entities appear in the same article**; `weight` = number of
  co-mentioning articles.
- Every node and edge carries its `articleIds`. A line the analyst cannot trace back to real
  text is a claim the system cannot support.

**`layoutGraph(nodes, edges, { width, height, iterations })`** — deterministic
Fruchterman–Reingold (all-pairs repulsion, spring attraction, cooling schedule). **Seed initial
positions on a circle by index, not randomly.** The same corpus must always lay out identically;
a graph that reshuffles per render is unciteable, and `Math.random()` is banned in pure utils.

**`degreeCentrality(nodes, edges)`** and **`shortestPath(a, b, edges)`** (BFS). No path → an
explicit "no path in the collected graph", never a fabricated route.

**Do NOT add betweenness, modularity, or "avg. degree".** `network.tsx:372-377` records why: the
previous version printed *"Modularity 0.71 · avg. degree 6.2"* over an SVG of 3,980 nodes drawn
from a loop index. Modularity needs a walked follow graph, which does not exist here. Degree over
a graph we actually built **is** computable — state the distinction on screen.

**`tests/graph-build.test.ts`**: co-occurrence edge set, determinism (byte-identical
coordinates), degree counts, no-path case, mixed-script keys.

### 6b. Rewrite `/graph` — `src/routes/graph.tsx` (301 lines)

**Currently 100% fabricated.** No fetch, no server function, no `useEffect` in the whole file.

| Fabrication | Line |
| --- | --- |
| `const NODES` — 10 nodes with literal `x`/`y` (Vector-17, channel_9821, Aster Motors, Syria, Russia, aster-motors.com, +91 98••••4211, vector17@proton.me, @osint_watch, M. Ortega) | `:24-35` |
| `const EDGES` — 10 hardcoded relationships | `:36-47` |
| "Selected node", permanently Vector-17, `Risk score 88 / 100`, `Connections 12` — **12 contradicts the 10 edges above it** | `:248-271` |
| "Shortest path", prose-hardcoded two-hop route | `:272-287` |
| `SampleDataBanner` disclosing all of the above | `:102` |

**Delete all five.** Then wire the pipeline `entities.tsx` already runs:

1. `getActiveTarget()` + `sentinel_target_changed` listener — `entities.tsx:116-125`.
2. `fetchNews({ data: { query: target } })` → `Article[]` — `entities.tsx:129-159`.
3. Per-article `aiExtractEntities({ data: { article } })` — `entities.tsx:232-244`
   (exported from `src/utils/analysis-llm.ts:354`).
4. Feed `Record<articleId, AnalysisEntity[]>` into `buildEntityGraph`, then `layoutGraph`.

**Extraction stays manual and opt-in.** `entities.tsx:127-128` records why: one model call per
article on load *"would empty a free tier immediately"*. Offer "Extract entities from N articles"
with a visible cost note and progress count. Before extraction, an empty state — **never a
sample graph**.

**Keep the controls repaired in commit `c96912f`:** the controlled filter input (`:114-119` +
`matched` memo `:65-71`, non-matching nodes dim to `opacity 0.18` at `:205`), both zoom buttons
with `aria-label`s (`:135-152`), Reset view (`:239-241`). The comments at `:86-101` and
`:229-234` explain that eight other controls were **removed rather than left inert**. You may
reinstate Expand / Collapse / Highlight path **only** because there is finally a real edge set to
traverse. If you cannot implement one, leave it out.

**Selected-node card must be derived, not asserted:** degree, distinct sources, best model
confidence (**`Math.max`, never a mean** — `entities.tsx:209-211`: *"Averaging two model-reported
confidences produces a third number no model ever asserted"*), best Module 1 credibility (via
`clusterStories` + `scoreCorpus`, `entities.tsx:163-168`) or `null`, and the source articles as
real links. **No risk score** — `investigations-store.ts:228-235` sets the precedent.

Add a `PinButton` (`kind: "note"`) on the selected node.

### 6c. `/network` — `src/routes/network.tsx`

The opposite problem: **real data, no rendering.** It fetches live Bluesky profiles and feeds
(`socialProfile`, `socialAuthorFeed`) and runs `analyseCib(posts, { profiles })` at `:147-150`,
then shows the result as text only.

Feed those `CibCluster[]` into the same `layoutGraph`. Nodes = accounts in `subjects[]`; edges =
co-cluster membership, each carrying that cluster's own evidence string.

Constraints:
- `CIB_CAVEAT` is already imported at `:24` and must render **on** the graph. CIB signals are
  *"signals warranting review, never a verdict"* — organised legitimate campaigns produce
  identical patterns.
- Keep the refusal at `:372-377` in spirit: degree over a graph we drew may be shown; modularity
  over a follow graph we never walked may not. Say which is which on screen.
- A signal that cannot be computed returns `null` with a reason, never `0` (`src/utils/cib.ts`).
- The empty state must **name the missing Bluesky credential** and link to `/settings`.

---

## 7. Item 5 — UCDP in Module 2

**Broken:** `src/routes/osint.tsx:399-404`, inside `fetchGeopoliticalSecurity`:

```ts
const res = await fetch("https://ucdpapi.pcr.uu.se/api/gedevents/24.1?pagesize=30", {
  headers: { "User-Agent": "Mozilla/5.0" },        // ← no x-ucdp-access-token
  signal: AbortSignal.timeout(8000),
});
```

No token header, no `resolveCredential("ucdp")`. **This path 401s unconditionally even when a
token IS configured.** UCDP GED has been token-gated since before 2026-08-04 — every version
(23.1 / 24.1 / 25.1) answers `API token required. Add header: x-ucdp-access-token`.

It also re-implements the deaths null-handling (`osint.tsx:411-418`) that `geo.ts:319-325` warns
was *"fixed in osint.tsx's UCDP handler while this copy was missed"*.

**(a) Delegate to the working collector.** Replace the fetch body with `collectConflict()` from
`src/utils/geo-sources.ts:90-130` — already server-side, already resolves env-first-then-vault via
`resolveCredential("ucdp")` (`:94`), already calls `recordCredentialUse` on success (`:112`),
already maps through the single `fromUcdpEvent` (`geo.ts:302-370`), and already returns the
explicit credential-missing error (`:96-106`). Render its `LayerResult` — do not re-map by hand.

**(b) Explicit credential-missing panel** via the existing `CollectorAbsence` component already
wired at `osint.tsx:1418-1422`. It must state: the exact env var **`UCDP_API_TOKEN`**; that this
is a **missing credential, not a finding that no conflicts occurred** (surface `collectConflict`'s
own text verbatim); a link to `/settings` where the `ucdp` provider
(`credential-vault.ts:224-242`) and its live probe (`:802-816`) already exist; and a link to
`ucdp.uu.se` to request the token.

**(c) Add UCDP to the health probe.** `src/utils/collector-health.ts` has `SPECS` at `:77-161`
and a `ProbeStatus` union at `:28-38` that already includes `"no-credential"` (*"Never 'down'"*).
**UCDP has no entry**, so it never appears on `/crawlers`. Add one following `redditProbe()`
(`:237`) / `blueskySearchProbe()` (`:280`).

**Must not regress:** `tests/gis.test.ts:272-287` asserts the missing-token result is exactly
`{ layer: "conflict", records: [], unplaceable: 0, error: "UCDP requires an API token…" }`, with
the comment *"'UCDP needs a token' and 'there are no conflicts anywhere' are opposite"*. Also
preserve coordinate honesty: `toGeoPoint` rejects `0,0` as a missing-value sentinel.

---

## 8. Item 6 — Settings: make Reddit / Bluesky / Mastodon / GitHub actually collect

### Read this before building anything

**All four already exist, end to end.** `src/routes/settings.tsx` (703 lines) writes **zero**
localStorage keys — it persists through `createServerFn` calls into
`src/utils/credential-vault.ts`, which writes `data/credentials.json` server-side. **Every
`onChange` / `onClick` / `onSubmit` on that page is wired. There are no dead controls.** Do not
rebuild any of it.

`CREDENTIAL_PROVIDERS` (`credential-vault.ts:142-335`):

| id | Line | env identifier | env secret | Verify probe |
| --- | --- | --- | --- | --- |
| `reddit` | `:143` | `REDDIT_CLIENT_ID` | `REDDIT_CLIENT_SECRET` | `:674` — `POST reddit.com/api/v1/access_token` |
| `bluesky` | `:163` | `BLUESKY_IDENTIFIER` | `BLUESKY_APP_PASSWORD` | `:708` — `com.atproto.server.createSession` |
| `mastodon` | `:184` | `MASTODON_INSTANCE` | `MASTODON_ACCESS_TOKEN` | `:751` — `GET /api/v1/accounts/verify_credentials` |
| `github` | `:204` | *(none)* | `GITHUB_TOKEN` | `:775` — `GET api.github.com/user` |
| `ucdp` | `:224` | *(none)* | `UCDP_API_TOKEN` | `:802` |
| `llm-primary` / `llm-fallback` / `youtube` | `:243` / `:261` / `:277` | | | |
| `instagram` / `facebook` | `:296` / `:317` | **blocked** — permanently `unusable`, never verifiable | | |

Collectors, all present and working:

| Source | Function | File:line | Auth |
| --- | --- | --- | --- |
| Reddit | `fetchRedditSearch` | `social.ts:1434` | OAuth **mandatory** — unauthenticated 403s everywhere since 2026-08-10 |
| Bluesky | `fetchBlueskySearch` | `social.ts:1200` | app password **mandatory** (403 without) |
| Bluesky | Jetstream WS + AppView `fetchProfile` / `fetchProfiles` / `fetchAuthorFeed` | `social.ts:1015-1058` | **keyless — already works** |
| Mastodon | `fetchMastodonTag` | `social.ts:1781` | **keyless — already works** |
| Mastodon | `fetchMastodonSearch` | `social.ts:1911` | Bearer token |
| GitHub | `githubHeaders()` → `news.tsx:1041-1089` | `credential-vault.ts:964-973` | **optional — raises the rate-limit ceiling, is not a gate** |

**The real problem: nothing is configured.** `data/credentials.json` holds only the two inert
Meta entries, so Reddit and Bluesky search error and the app reads as broken when it is in fact
correctly reporting a missing credential.

### What to build

**(a) Per-source connection cards** replacing the flat provider `<select>` at `settings.tsx:559`.
One card per **collectable** provider, each stating: status badge; `consumedBy` (already rendered
verbatim at `:374` and `:599`); the exact env var names; the endpoint Verify hits; **what it
unlocks**; and where to get it:

| Provider | Where to get it | What it unlocks |
| --- | --- | --- |
| **Reddit** | free script app at `reddit.com/prefs/apps` | `fetchRedditSearch`. Without it **every** unauthenticated Reddit endpoint 403s — a hard gate. |
| **Bluesky** | an app password from `bsky.app` settings | `fetchBlueskySearch` — historical keyword search. **The largest single collection gain available, and free.** Without it, forward-only Jetstream monitoring and AppView profile reads still work. |
| **Mastodon** | any instance → Preferences → Development → new application, `read` scope | `fetchMastodonSearch` (`api/v2/search`), reaching posts carrying no hashtag. Keyless hashtag timelines already work. |
| **GitHub** | `github.com/settings/tokens`, **no scopes needed** for public search | Raises the rate-limit ceiling on the `/news` GitHub sweep. **Not a gate** — must not be presented as one. |

**(b) Every consuming surface names the missing credential and links to `/settings`.**
`socialCredentials()` (`social.ts:2200-2209`) already returns booleans for reddit / bluesky /
mastodon. Extend it **additively** with `github` (and `ucdp` for item 5) — **booleans only, a key
value must never cross to the browser** (`:2193-2199`).

Where a collector throws `SocialUnavailableError` (`social.ts:40-49`), **surface its message
verbatim**. Those messages already carry the full remediation path and name both the env var and
the Settings page — `social.ts:1357-1367` (Reddit), `:1134-1142` (Bluesky), `:1921-1928`
(Mastodon). A generic "failed to load" destroys the one thing that tells the analyst what to do.
Apply to at minimum `/social`, `/network`, `/live`.

**(c) Preserve the honesty guarantees. These are not decoration:**

- Four states (`credential-vault.ts:70-77`): `unverified` (stored, never tried) / `verified` (a
  live call succeeded at `verifiedAt`) / `rejected` (provider refused) / `unusable` (not
  collectable at all).
- `status` is **measured by a live call, never asserted at save time** (`:1022`). Saving is not
  testing.
- Legacy `status: "Active"` is downgraded on read to `unverified` (`:86-92`) — *"That claim was
  never measured."*
- `verifyProviderCredential` (`:644-897`) makes a **real** call on every branch; there is
  deliberately no offline "looks like a valid key" heuristic (`:637-643`).
- Three distinguished outcomes — `ok()` / `rejected()` / `transportFailure()`, the last saying
  *"this is a network failure, not a rejection"* (`:612`).
- YouTube `quotaExceeded` returns `unverified`, not `rejected` (`:831-841`).
- Instagram / Facebook short-circuit to `unusable` with `checkedAt: null` — *"No call was made,
  and saying otherwise would imply one had been"* (`:654-664`). No Verify button renders for them
  (`settings.tsx:482`).
- `revealCredential` stays a **separate** server call so rendering the page does not ship every
  key to the browser (`:1049-1056`).
- `maskSecret()` returns a **fixed** 16-dot mask — a length-preserving mask leaks key length
  (`:375-398`).
- Resolution order is **environment first, vault second** (`:546-562`). Key Vault `secretref:`
  env vars are the audited path and must not be shadowed by a file on an ephemeral replica.
  `rejected` entries are skipped; `unverified` entries **are** tried.
- Keep the storage-policy warning at `settings.tsx:683-694`: `data/` is excluded from the build
  context, so a vault credential **dies with the replica** on Container Apps. It is currently
  true — do not delete it.

**Do not** re-add an Instagram or Facebook collector behind those two rows.
`credential-vault.ts:1100-1127` records exactly what the previous attempt did: instaloader login,
then a Google-News-RSS fallback relabelled as Meta posts, then hardcoded posts with 842 and 420
likes. Settled.

---

## 9. Item 7 — fabrications still live in the tree (found 2026-08-17)

**Not** part of the original six-item report. Found by a fresh sweep with the three CLAUDE.md
greps plus a hunt for index-derived series. All gates pass — `bun test` 653/653,
`check-exports` 151, `tsc --noEmit` clean, `bun run build` green — which is precisely the point:
**no unit test can see any of these.** Fix them alongside the six items.

### 7.1 `/subjects` — a synthetic chart series (most serious)

`src/routes/subjects.tsx:196-205`. The comment says it outright: *"Generate chart mock trend
points based on match density"*.

```ts
const hours = ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
const baseVal = matches.length > 0 ? matches.length : 5;
return hours.map((h, idx) => ({
  hour: h,
  threats: Math.max(2, Math.round(baseVal * 0.4 + ((idx * 2) % 5))),
  scans:   Math.round(150 + idx * 12 + ((idx * idx * 3) % 25)),
}));
```

- Seven hour labels 12:00–18:00 bear no relation to any real clock or collection time.
- `threats` comes from `(idx * 2) % 5` — **the exact index-arithmetic pattern removed from
  `/live`** (`idx % 3`, `locations[idx % 9]`, `credibility: idx % 2`) and from `/sentiment`
  (`30 + Math.sin(i/4)*12 + Math.random()*6`). It survived here.
- `scans` is `150 + idx * 12`. Nothing in this system scans.
- `baseVal … : 5` invents a floor, so the chart **never renders empty even with zero matches**.

It drives the "Activity Scanner Pulse" chart, and `/subjects` carries **no `SampleDataBanner`**.
**Delete the series.** `getWatchlistMatches` returns real matches with real `date` fields
(`watchlist-store.ts:39`, correctly `string | null`) — bucket those by hour if a chart is wanted,
and render an explicit empty state when there is nothing to plot.

### 7.2 `/subjects` — "Growth Rate" is arithmetic on a match count

`src/routes/subjects.tsx:424`:

```tsx
+{matches.length > 3 ? Math.round(matches.length * 1.5) : 8}%
```

Labelled **"Growth Rate"** in a stat tile. Nothing measures growth: this is a match count times
1.5, or the literal `8` when there are three or fewer matches. Remove the tile, or replace it
with a real period-over-period figure — `src/utils/social-velocity.ts` already computes genuine
volume deltas and is tested.

### 7.3 `/subjects` — `riskScore` rendered with no null branch

`src/routes/subjects.tsx:430` renders `{activeWatchlist.riskScore}/100` unguarded.
`createWatchlist` sets `riskScore: null` deliberately (`watchlist-store.ts:121-123` — the random
score was removed), so **an analyst-created watchlist renders literally `null/100`**.
`watchlists.tsx:254-257` already has the correct branch — *"Risk index: not scored — no matches
have been evaluated against this filter."* Copy it.

### 7.4 `watchlist-store.ts` — seeded watchlists carry invented risk scores

`src/utils/watchlist-store.ts:50-88`. `DEFAULT_WATCHLISTS` ships `riskScore: 78` and
`riskScore: 42` — two numbers nothing computes, in the same file where `createWatchlist` was
changed to `null` precisely because the score was invented. They are `[SAMPLE]`-prefixed and
`/watchlists` shows a banner, but the values are still asserted. Set both to `null`.

Also `createdAt: new Date().toISOString()` at **module scope** (`:67`, `:86`) — evaluated at
import time, so both sample watchlists always claim to have been created seconds ago. Use a fixed
literal date or `null`.

### 7.5 `/agents` — five fictional entities, undisclosed

`src/routes/agents.tsx:126-133` seeds `Vector-17`, `Aster Motors`, `Meridian Capital`,
`channel_9821`, `Northwind Logistics` into the entity picker, and `:103-104` **pre-selects two of
them**. `:152` then feeds the selection into the LLM prompt as the analysis target. Unlike
`/graph`, `/vault` and `/watchlists`, this page carries **no `SampleDataBanner`** — verified, zero
matches in the file. Build `availableEntities` from cases and watchlists only, with an empty state
when there are none.

### 7.6 `/` dashboard — hardcoded "MONITORING" badge

`src/routes/index.tsx:509-511` renders a fixed `MONITORING` badge on every watchlist row. Nothing
monitors on a schedule — `watchlists.tsx:244-252` says so explicitly (*"Not scheduled… the
container scales to zero, so there is no process between requests to run one in"*). The dashboard
contradicts it. Also `:478` `{c.status || "OPEN"}` renders in a red destructive badge regardless
of the case's real status, so a `Closed` case shows red.

### 7.7 Aggregator names substituted for missing publishers

Same class as the bug `rss-source.ts` was written to fix (Module 1 was rating `news.google.com`
as the publisher of every article):

- `src/routes/osint.tsx:455` — `source: a.source || "GDELT"`
- `src/routes/osint.tsx:476` and `:591` — `item.source || "Google News"`

GDELT and Google News are aggregators, not publishers. Use `"publisher not reported"` — the
wording `/live:420-424` already uses.

### 7.8 Lower severity, listed for completeness

- `src/routes/vault.tsx:255` — `geo: uploadGeo || "Global"` renders under a **GEOPOINT** label.
  "Global" is not a coordinate.
- `src/utils/youtube-collector.ts:658-659` — `data.author_name || "YouTube Uploader"` puts a
  generic string in the **uploader name** field, where it reads as a channel identity.
- `src/routes/news.tsx:1152`, `:1808`, `:1927` — `countryCode || "Global"` renders an unreported
  country as a global-scope claim.
- `src/routes/tasks.tsx:47-62` — prefilled fictional inputs on the compliance console
  (`"TASS News"`, the Vector-17 Moscow-spaceport paragraph, `"@disinfo_pulse"`,
  `"capture_drone_exif.jpg"`). Editable inputs, not rendered findings — but this is the page an
  evaluator opens to check PS-18 compliance.
- `src/routes/live.tsx:118` — `"Vector-17"` sits in the example-query chips beside real subjects
  (Tesla, ISRO, OPEC). It returns nothing from Google News, which reads as a broken collector.
- `src/routes/live.tsx:15` — the query falls back to `"ISRO Chandrayaan"` when none is given.
  Defensible as a demo default; state it in the UI rather than letting it look like a result.

### What is already clean — do not "fix" these

`analysis.ts`, `cib.ts`, `credibility.ts`, `geo.ts`, `imaging.ts` and `social.ts` all carry
explicit *"No `Math.random()`"* guarantees and hold to them. `/timeline` and `/sentiment` had
their seeded series removed and now show honest empty states. The two remaining
`|| new Date()` grep hits (`images.tsx:234`, `watchlist-store.ts:35`) are **comments describing
removed code**, not live fallbacks. Every `?? 0` hit is a loop accumulator, a config default or a
length check — none reaches a screen as a measurement, the one borderline case being
`osint.tsx:417`, already guarded by the `.some()` check above it.

---

## 10. Verification — all of it, before you report done

```sh
bun test                       # 653+ passing; ZERO regressions
bun scripts/check-exports.ts   # 151+ symbols intact — this is the anti-deletion gate
./node_modules/.bin/tsc --noEmit   # must be clean. NOTE: `npx tsc` does NOT work in this repo
bun run build                  # must be green
bun run smoke                  # every route hydrates
bun run smoke:controls         # zero dead controls introduced

grep -rn "|| new Date()" src/           # must not grow
grep -rnE '\|\|\s*"[A-Z]' src/
grep -rnE '\?\?\s*0\b|\|\|\s*0\b' src/
grep -rnE 'idx \* |i % [0-9]|Math\.sin\(' src/routes/   # index-derived series
```

**New tests required:** `tests/graph-build.test.ts`, `tests/evidence-store.test.ts`,
`tests/live-filters.test.ts`.

Fixtures live in `tests/helpers/` **on purpose** — synthetic records importable from `src/` are
one refactor away from rendering as real findings. **Nothing under `src/` may import them.**

### Manual walk-through

1. `/investigations` → create a case → switch to `/vault`. It appears in **LINK CASE** **without
   a reload**.
2. `/vault` → upload evidence with a case linked → the toast names the case → the case shows the
   pinned item → delete the evidence → the pinned copy disappears from the case too.
3. `/vault` → select a record whose case was deleted → it reads "case … no longer exists" and is
   **not** a link.
4. `/live` → Bookmark an item → it appears in Shortlist → Pin it → it moves to **Pinned into
   investigation** and links to the case.
5. `/live` → set Date to **Any time** → the "N of M collected" count rises, and the note explains
   the feed is only ~24h deep.
6. `/graph` → run extraction → a real node-edge graph appears, no `SampleDataBanner`, and no
   "Risk score" anywhere.
7. `/network` → add a Bluesky handle → CIB clusters render as a graph carrying `CIB_CAVEAT`. With
   no credential, the empty state names the Bluesky app password and links to `/settings`.
8. `/osint` with no UCDP token → the panel names `UCDP_API_TOKEN`, says this is a missing
   credential and not an absence of conflict, and links to `/settings`.
9. `/crawlers` → UCDP appears with status `no-credential`, not absent and not "down".
10. `/subjects` with a fresh watchlist → **no chart series**, no "Growth Rate" tile, and the risk
    index reads "not scored" rather than `null/100`.

---

## 11. On completion

Update `PROJECT_MEMORY.md`:

1. Move the task from **Active Task State** into **Completed Milestones**, dated, with a
   paragraph on what was actually wrong — not just what was added.
2. Register **every new exported symbol** in the **Codebase Inventory & Export Registry** (§3),
   including `evidence-store.ts` and `graph-build.ts`.
3. Record the new test count and confirm `tsc --noEmit` clean plus the export audit passing.
4. If any item could not be completed, say so explicitly and why. A partial result reported as
   complete is the same class of failure as a fabricated data point.

**Do not deploy.** If asked later, read the deployment traps in `CLAUDE.md` first: there is no
Docker locally (`az acr build`, never `docker build`); the Azure CLI crashes while streaming
build logs on Windows **while the remote build still succeeds**; and transient DNS failures on
`login.microsoftonline.com` should be retried before being diagnosed.
