# Person Investigation — Analysis (pre-implementation)

**Status: ANALYSIS ONLY. No code changed to produce this document. STOP HERE for approval.**

## 0. A note on scope

The task that produced this document said "Read and follow: `docs/OSINT-INTEGRATION-PLAN.md` and
`docs/PERSON-INVESTIGATION-PLAN.md`." The second file **does not exist** — not in the working tree,
not untracked, no trace of it ever being added in git history, and no similarly-named file anywhere
in the repo. This was flagged before starting; the user confirmed treating the task's own inline
instructions as the plan. Everything below is built against `docs/OSINT-INTEGRATION-PLAN.md` (read
in full, 2,641 lines) plus the task's own numbered requirements.

All file:line citations below were gathered by five parallel research passes over the live source
tree on 2026-08-19, and two of the highest-stakes ones (the `Collector` interface, and the
face-matching "not implemented" entry) were independently re-read and confirmed to match exactly.
The rest were not independently re-verified line-by-line by a second reader; treat line numbers as
accurate as of this date but re-`grep` before citing them in a PR description, since ordinary
editing will drift them.

---

## 1. The Collector interface (exact contract)

**File: `src/utils/collectors/types.ts`, 101 lines. Re-read directly, confirmed exact.**

```ts
// lines 25-38
export const TARGET_TYPES = [
  "person", "email", "phone", "username", "domain",
  "ip", "url", "location", "article", "image", "video",
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];   // 11 values

// lines 40-43
export interface CollectorTarget {
  type: TargetType;
  value: string;
}

// line 52
export type CollectorCategory = "search" | "infrastructure" | "social" | "media" | "external";

// line 60
export type CollectorHealthState = "ready" | "unavailable" | "no-credential" | "degraded";

// lines 62-66
export interface CollectorHealth {
  state: CollectorHealthState;
  detail: string;
  checkedAt: string;
}

// lines 69-73
export interface CollectorRunOutcome<TRaw> {
  execution: CollectorExecutionMeta;
  raw: TRaw | null;   // null iff execution.status is "failed" or "cancelled"
}

// lines 88-100 — THE interface every new collector implements
export interface Collector<TRaw = unknown> {
  id: string;
  name: string;
  category: CollectorCategory;
  supportedTargetTypes: TargetType[];
  requiresCredentials: boolean;
  isOptional: boolean;

  execute(target: CollectorTarget): Promise<CollectorRunOutcome<TRaw>>;
  normalize(outcome: CollectorRunOutcome<TRaw>): InvestigationResult;
  healthCheck(): Promise<CollectorHealth>;
}
```

Note `"person"` is already in `TARGET_TYPES` — a `person`-targeted collector is not a new target
type, just a new set of collectors declaring `supportedTargetTypes: ["person"]` (or `["person",
"email"]` etc. where relevant).

---

## 2. Result / Evidence / Execution schema (exact, zod-validated)

**File: `src/utils/collectors/result.ts`, 226 lines.**

```ts
// lines 39-46
ConfidenceScore = { value: number | null (0-1), reasons: string[] }
UNSCORED = { value: null, reasons: [] }

// lines 55-71 — EntityType, 13 values (11 TargetTypes + organization + social_account)
ENTITY_TYPES = ["person","email","phone","username","domain","ip","url",
                "location","article","image","video","organization","social_account"]

// lines 73-83
CollectorEntity = {
  id: string; type: EntityType; value: string; displayName: string;
  source: string;              // which collector produced it, e.g. "dns"
  confidence: ConfidenceScore; metadata: Record<string, unknown>;
}

// lines 88-101 — RelationshipType, 10 values
RELATIONSHIP_TYPES = ["HAS_EMAIL","USES_USERNAME","WORKS_AT","LOCATED_IN","MENTIONED_IN",
                       "OWNS_DOMAIN","RESOLVES_TO","HOSTED_ON","HAS_PORT","SUPPORTED_BY"]
// Only 7 of these 10 are actually emitted by any shipped adapter today:
// HAS_EMAIL, USES_USERNAME, LOCATED_IN, MENTIONED_IN, OWNS_DOMAIN, RESOLVES_TO, HOSTED_ON.
// WORKS_AT, HAS_PORT, SUPPORTED_BY are declared but unused — WORKS_AT is exactly what
// contact.domain / identity.websearch would be the first real users of.

// lines 103-111
CollectorRelationship = {
  sourceEntity: string;        // entity id, not a raw value
  relationshipType: RelationshipType;
  targetEntity: string;
  confidence: ConfidenceScore; source: string;
}

// lines 122-132 — THE evidence shape (Rule 6's "never fabricate" contract)
CollectorEvidence = {
  source: string; sourceUrl: string | null; collector: string; collectedAt: ISO8601;
  rawValue: unknown; normalizedValue: unknown;
  confidence: ConfidenceScore | null; metadata: Record<string, unknown>;
}

// lines 143-152 — ExecutionStatus, 6 values
ExecutionStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled"

// lines 160-171 — the structured failure envelope, already built
CollectorExecutionMeta = {
  status: ExecutionStatus;
  startedAt: ISO8601; completedAt: ISO8601 | null;
  durationMs: number | null; resultCount: number;
  error: CollectorErrorInfo | null;   // null unless status is failed/partial/cancelled
}

// lines 175-186 — top-level return shape of normalize()
InvestigationResult = {
  entities: CollectorEntity[]; relationships: CollectorRelationship[];
  evidence: CollectorEvidence[]; warnings: string[]; errors: string[];
  metadata: Record<string, unknown>; execution: CollectorExecutionMeta;
}
```

**File: `src/utils/collectors/errors.ts`, 100 lines.**

```ts
// lines 22-39 — the real error-reason vocabulary, 8 values
CollectorErrorReason =
  "timeout" | "unavailable" | "no-credential" | "invalid-target" |
  "rate-limited" | "upstream-error" | "cancelled" | "unknown"

// lines 49-53
CollectorErrorInfo = { collector: string; reason: CollectorErrorReason; message: string }

// lines 63-77 — the class every adapter throws
class CollectorError extends Error {
  constructor(readonly collectorId, readonly reason, message, readonly cause?)
  toInfo(): CollectorErrorInfo
}
// factories: collectorTimeout(), collectorUnavailable(), collectorNoCredential() — lines 80-100
```

**⚠️ Direct correction to the task's own assumed envelope.** The task specifies
`{ collector, status:'ok'|'error'|'timeout'|'skipped', reason?, durationMs, evidence[] }`. The real,
already-built, already-tested envelope is `CollectorExecutionMeta` above:
`status` is `queued|running|completed|partial|failed|cancelled` (not `ok/error/timeout/skipped`),
there is no `skipped` status — an unavailable/uncredentialed collector reports `status: "failed"`
with `error.reason: "unavailable"` or `"no-credential"` — and `"timeout"` is a `reason` value inside
`error`, never a `status` value itself. New collectors must emit the real enum, not the task's
guessed one, or they will fail every existing test/consumer that pattern-matches on
`ExecutionStatus`.

**Helpers**: `emptyInvestigationResult(execution)` (lines 189-199), `parseInvestigationResult(id,
value)` (lines 221-226, throws `InvestigationResultValidationError` on zod mismatch).

**File: `src/utils/collectors/existing/shared.ts`, 85 lines — the four helpers every adapter reuses:**

```ts
startExecution(): ExecutionClock                                    // lines 19-21
finishExecution(clock, status, resultCount, error?): CollectorExecutionMeta  // lines 23-37
classifyError(collectorId, err): CollectorError                     // lines 47-64, message-sniffing
normalizeGuard(outcome): InvestigationResult | undefined            // lines 78-85
  // returns undefined when outcome.raw !== null (fall through to real normalize());
  // else returns a populated-empty InvestigationResult carrying the execution error.
```
Import path from a new `existing/`-tree adapter: `from "./shared"`. From `external/`-tree:
`from "../existing/shared"` (confirmed — this is what `theharvester.ts`/`spiderfoot.ts`/
`jina-reader.ts` already do).

---

## 3. Registry

**File: `src/utils/collectors/registry.ts`, 58 lines.**

```ts
class CollectorRegistry {
  register(collector: Collector): void;        // lines 23-30, throws DuplicateCollectorError on dup id
  unregister(collectorId: string): void;        // lines 31-34
  get(collectorId: string): Collector | undefined;   // line 35
  list(): Collector[];                           // line 39
  findByTargetType(type: TargetType): Collector[];   // line 44 — filters supportedTargetTypes.includes(type)
  findByCategory(category: Collector["category"]): Collector[];  // line 48
  clear(): void;                                 // line 52
}
export const collectorRegistry = new CollectorRegistry();  // line 58, global singleton, in-memory Map
```

**Registration files**, both idempotent (`if (!registry.get(id)) register()`):
- `src/utils/collectors/existing/index.ts:33-47` — `EXISTING_COLLECTORS` array (7 adapters) +
  `registerExistingCollectors(registry?)`.
- `src/utils/collectors/external/index.ts:26-36` — `EXTERNAL_COLLECTORS` array (theharvester,
  spiderfoot, jina-reader) + `registerExternalCollectors(registry?)`.

A new `person/` (or similarly-named) collector directory would follow the identical pattern: one
file per collector, one `PERSON_COLLECTORS` array, one `registerPersonCollectors()` function.

---

## 4. Every existing collector today: target types, entities, relationships produced

| id | file | category | supportedTargetTypes | isOptional | Entities produced | Relationships |
|---|---|---|---|---|---|---|
| `dorks` | `existing/dorks.ts` | search | person, domain, email, username | false | target + `article` (news scope only) | `MENTIONED_IN` |
| `dns` | `existing/dns.ts` | infrastructure | domain | false | `domain`, `ip` | `RESOLVES_TO` (conf. 1) |
| `rdap` | `existing/rdap.ts` | infrastructure | domain | false | `domain` (registrar/dates/nameservers as metadata) | none |
| `crtsh` | `existing/crtsh.ts` | infrastructure | domain | false | `domain` × subdomains + synthesized parent | `OWNS_DOMAIN` (conf. 0.9) |
| `shodan-internetdb` | `existing/shodan-internetdb.ts` | infrastructure | ip, domain | false | `ip`, `domain` | `RESOLVES_TO` (conf. null) |
| `news` | `existing/news.ts` | media | person, domain, location | false | `article`, `location` | `LOCATED_IN` (conf. 0.3-0.9) |
| `social` | `existing/social.ts` | social | username, person | **true** | target + `social_account` (Bluesky/Telegram only) | `USES_USERNAME` (conf. 1) |
| `theharvester` | `external/theharvester.ts` | external | domain | true | `domain`, `email`, `ip`, `url` | `HAS_EMAIL`, `RESOLVES_TO` |
| `spiderfoot` | `external/spiderfoot.ts` | external | domain | true | email/ip/domain/phone/username/**person**/social_account/url (partial map) | `HAS_EMAIL` only |
| `jina-reader` | `external/jina-reader.ts` | media | url | true | `article`, `domain` | `HOSTED_ON` (conf. 1) |

**What already serves identity/contact/presence for a `person` target, today:**
- **`dorks`** — builds Google-News-RSS-scoped search hits for a person's name; web-scope dorks
  (site:linkedin.com etc.) are generated as manual URLs only, never executed (ToS reasons, `dorks.ts`
  header lines 15-18).
- **`news`** — GDELT-sourced articles mentioning the person, geo-tagged when possible.
- **`social`** — Bluesky/Telegram direct-handle lookups + Reddit keyword search (Reddit explicitly
  produces evidence only, never an identity relationship — `social.ts` lines 178-196).
- **`spiderfoot`** (currently `unavailable`, no worker deployed) — the only existing collector whose
  event-type map includes `person`→`HUMAN_NAME` at all, and it only fires on a `domain` target
  (`supportedTargetTypes: ["domain"]`), not on a `person` target — so in practice it contributes
  nothing to a person investigation today even when a worker exists.

**What is completely absent** — confirmed by direct search, not assumed:
- No email syntax/MX validation utility (a route-local, un-exported Cloudflare DoH MX lookup exists
  at `src/routes/news.tsx:976-991`, coupled to that route's own state — see §9).
- No Gravatar integration anywhere.
- No phone-number parsing library (`libphonenumber-js` etc. — not a dependency) and no collector
  declares `supportedTargetTypes: ["phone"]` at all; a `phone`-typed target currently plans to
  **zero** collectors.
- No Wappalyzer-style live tech-stack fingerprinting (RDAP gives registration metadata; Shodan
  InternetDB gives passive-scan ports/CPEs/CVEs — neither is a live page fingerprint).
- No Brave Search or any general web-search API — search is Google News RSS (news-scoped) or
  manual dork URLs only.
- No Sherlock/Maigret-style cross-site username-existence sweep — `social.ts` checks exactly 3 named
  platforms via content APIs, not a broad HTTP-HEAD-across-many-templates check.
- No HIBP integration and no credential-vault slot for it (11 providers exist; none named
  hibp/haveibeenpwned/pwned).
- **No face-matching capability of any kind** (see §8 — this is the single most important gap,
  because the task assumes it exists and can be reused).
- No self-hosted readability library (`@mozilla/readability` etc. not a dependency) — Jina Reader
  (`external/jina-reader.ts`) is the one working full-text extractor, but it is a **remote API call**
  to `r.jina.ai`, not a self-hosted extraction, and it only accepts `url`-typed targets (it cannot be
  pointed at a bio/company page discovered by a search step in the same call).

---

## 5. Orchestration layer

**File: `src/utils/osint/query-planner.ts`.**

`detectTargetType(rawInput: string): DetectionResult` (lines 66-82), `DetectionResult = {
primaryType: TargetType; alternateTypes: TargetType[] }`. Precedence, first match wins: empty →
person; IPv4 → ip; URL → url (+domain alt); email → email; no-space domain-shaped → domain;
phone-shaped (≥7 digits) → phone; no-space ≤30 chars → username (+person alt); **everything else
(contains a space, e.g. `"John Smith"`) → `primaryType: "person"`, `alternateTypes: ["username"]`**
(line 81). A bare person name already routes to both `person`- and `username`-capable collectors.

`planInvestigation(rawInput, registry?)` (lines 101-133): for each candidate type (`primaryType` +
`alternateTypes`), calls `registry.findByTargetType(type)`, dedupes by collector id, returns
`OsintPlan = { input, detected, collectors: PlannedCollector[], excluded: [] }`.

**File: `src/utils/osint/orchestrator.ts`.**

`runInvestigation(rawInput, registry?)` (lines 70-114): plans, runs every planned collector via
`Promise.all`, dedupes entities/relationships **by exact id/edge only** (`merge.ts`, no semantic
merge), concatenates evidence/warnings/errors, returns `Investigation`. Does **not** call
`resolveInvestigationEntities` itself.

`runOsintInvestigation` — the `createServerFn` **already used by `/recon` and `/reports`**, same
file, lines 131-150:
```ts
export const runOsintInvestigation = createServerFn({ method: "POST" })
  .validator((d: { target: string }) => d)
  .handler(async ({ data }) => {
    registerExistingCollectors();
    registerExternalCollectors();
    const investigation = await runInvestigation(data.target);
    const resolved = resolveInvestigationEntities(investigation);   // entity resolution DOES run here
    return JSON.parse(JSON.stringify(resolved));
  });
```
A new person-collector registration array/function (`registerPersonCollectors()`) would need to be
added to this same call site (or a parallel one) for person collectors to actually run — mirroring
exactly how theHarvester/SpiderFoot registration was a real, separately-landed fix (§21a of the
integration plan: they were built and tested but unreachable until this exact wiring was added).

**File: `src/utils/osint/jobs.ts` — the pollable sibling `/recon`'s UI actually uses.**

`startInvestigation(rawInput, registry?, store?, timeoutMs?, collectorIds?)` (lines 209-228) —
already accepts an optional `collectorIds?: readonly string[]` allow-list. `pollInvestigation(id,
store?)` (lines 255-277) — **does not** apply entity resolution (raw per-collector entities, exact-id
deduped only; `recon.tsx`'s own comment at lines 538-542 documents this as a known, deliberate gap).
Three `createServerFn`s: `planOsintInvestigation`, `startOsintInvestigationJob` (validator: `{
target: string; collectorIds?: string[] }`), `pollOsintInvestigationJob`.

`JOB_TIMEOUT_MS = 60_000` (line 114) — the outer safety-net timeout every job gets regardless of a
collector's own internal timeout.

**Consumers, confirmed by direct grep** (three, not the two the task might assume):
1. `src/routes/recon.tsx`'s `InvestigationPanel` — uses the `jobs.ts` polling trio only, never
   `runOsintInvestigation` directly.
2. `src/routes/reports.tsx`'s `collectOsint()` — uses `runOsintInvestigation` (the entity-resolved,
   synchronous path), appends results as citable `SourceRef`s.
3. `src/routes/osint.tsx` — **confirmed NOT a consumer.** Despite being the route the integration
   plan's own §21 UI Strategy names for "person / email / username / location / news / social /
   investigation overview," it currently calls none of `runInvestigation`, `runOsintInvestigation`,
   `startOsintInvestigationJob`, or `pollOsintInvestigationJob`. It is a fixed 8-tab dashboard
   (WHOIS/DNS, cyber-threat IOCs, curated Telegram channels, geopolitical/GDELT, RSS aggregation, GPS
   jamming, radiation) driven by one generic free-text target box, not a structured person form, and
   its 7 data-fetching effects are unrelated to the collector-orchestration layer entirely.

---

## 6. Entity resolution

**File: `src/utils/osint/entity-resolution.ts`.**

`resolveInvestigationEntities(investigation)` (lines 209-217) → calls `resolveEntities(entities,
relationships)` (lines 141-201).

Per-type normalization (lines 45-86): `email`→trim+lowercase; `domain`→trim+lowercase+strip
trailing dot (does **not** strip leading `www.`); `username`→trim+strip one leading `@`+lowercase;
`url`→lowercase scheme+host, drop fragment, drop one trailing pathname slash, **keep** query string;
everything else (including `phone`, `location`, `ip`) → generic trim+lowercase.

**`NOT_MERGEABLE_BY_VALUE = new Set(["person", "organization"])`** (line 91) — structurally enforced,
not just a low confidence score: two different "John Smith" entities are **never** merged into one,
under any circumstance, by this file. This is directly load-bearing for requirement #5's "never infer
identity merely from a matching name" — it is already built, not something new to add.

`computeMergeConfidence(entityType, contributingSources)` (lines 105-119): `UNSCORED` if ≤1 unique
source; else `value = min(0.5 + 0.15 × (uniqueSources - 1), 0.95)` with `reasons` naming the source
count and list. This is the **only** signal this file computes — "same organization" / "same
location" / "matching username" as independently corroborating facts about one already-identified
person (the task's confidence-model worked example) is **not built** here; it would need new,
person-specific correlation logic.

Relationship endpoints get remapped through `idRemap` after merging; a resulting self-loop
(`sourceEntity === targetEntity` post-remap) is dropped, not kept (line 198). Re-dedup via
`merge.ts`'s `dedupeRelationships` after remapping (line 200).

**Deliberately not auto-wired** into `runInvestigation()`/`pollInvestigation()` — only the
`runOsintInvestigation` server fn applies it. A Person Investigation feature reusing `jobs.ts`'s
polling UI pattern would inherit the same "no entity resolution during polling" gap `/recon` already
has, unless it explicitly resolves once the job reaches `done`.

---

## 7. Graph layer

**⚠️ Direct correction to the task's requirement #6.** The task specifies "Person-centered
**Cytoscape.js** graph." **Cytoscape.js is not a dependency of this project and is not used anywhere
in the codebase** — confirmed via `package.json` (no `cytoscape` entry) and a repo-wide grep (zero
matches). The actual, already-built, already-shipped graph (`/graph`, per OSINT-INTEGRATION-PLAN.md
§21e) is:

- **`src/utils/graph-layout.ts`** — a dependency-free, DOM-free pure TypeScript module. Its own file
  header states explicitly: *"No physics simulation, no external layout library... pulling in a new
  rendering dependency is more than this step needs."* `layoutRadial(entities, relationships,
  preferredRootId, options?)` (lines 65-70) — deterministic BFS-ring layout: root at center, each
  further ring at `radius = ring × ringGap` with members evenly spaced by angle, node radius scaled
  by connection degree. `shortestPath(entities, relationships, fromId, toId)` (lines 172-177) — real
  BFS, returns `null` (never guessed) when unreachable.
- **`src/routes/graph.tsx`** renders the result as **raw inline SVG** — `<circle>`/`<line>`/`<text>`
  elements built directly in JSX (lines 276-364), not Canvas, not Cytoscape. `TYPE_HUE: Record<EntityType,
  number>` (lines 31-45) gives all 13 entity types a distinct color. `MAX_GRAPH_NODES = 150` caps
  on-screen rendering (closest-to-root by BFS ring kept preferentially), disclosed on-canvas.
- **`src/utils/graph-store.ts`** — a versioned `localStorage` hand-off (`sentinel_graph_snapshot`),
  one snapshot at a time: `saveGraphSnapshot(snapshot)`, `readGraphSnapshot(): GraphSnapshot | null`
  (rejects a version mismatch or malformed payload rather than coercing it).
- **`src/utils/maltego-export.ts`** — `toMaltegoCsv(entities, relationships)`, an edge-list CSV
  export, already wired to a "/graph" button.

**Recommendation**: reuse this exact graph, not a new Cytoscape.js integration. A "Person-centered
graph" is achievable today by calling `layoutRadial()` with the Person entity's id as
`preferredRootId` and handing the investigation's real entities/relationships to `/graph` via the
existing `saveGraphSnapshot()` — zero new rendering code needed. Introducing Cytoscape.js would be a
second, parallel graph-rendering stack, which requirement zero ("do NOT build a parallel stack")
directly prohibits. If Cytoscape.js specifically (vs. "a graph that visualizes the person") was a
hard requirement rather than a description of what a reader would picture, that needs to be settled
explicitly before building — see Assumptions & Unknowns.

**`RelationshipType` gap relevant to person investigation**: `WORKS_AT` exists in the vocabulary
(§2) but is never emitted by any current adapter. `identity.websearch` (bio/company-page discovery)
is the natural first real producer of `WORKS_AT` edges.

---

## 8. Face matching — confirmed NOT to exist (task's `presence.image` requirement)

The task's `presence.image` collector says: "reuse existing Module-4 face MATCH against an
operator-supplied reference set only." **This capability does not exist, anywhere, in this
codebase, and its absence is a deliberate, disclosed, user-visible design decision — not an
oversight to "reuse."**

Exact source, `src/utils/imaging.ts:1140-1145` (re-read directly, confirmed):
```ts
{
  capability: "Face matching against a watchlist",
  requires: "A face recognition model, a curated reference set, and a lawful basis to hold it.",
  limitation:
    "Beyond the technical requirement, holding biometric templates of identifiable individuals " +
    "engages the DPDP Act 2023. Not a gap to close without a legal basis first.",
},
```
This is one entry in the `NOT_IMPLEMENTED: Gap[]` array, rendered verbatim by
`src/components/not-implemented.tsx` in the product UI (`/images`' own "Not implemented — and why"
panel). There is no face detection, embedding, or comparison logic anywhere in `imaging.ts` or
`imaging-client.ts` (which do implement pHash near-duplicate matching, EXIF, C2PA, OCR, and video
scene-cut detection — genuinely real capabilities, just not this one). `src/types/core.ts:242-257`
defines a `FaceSchema`/`MediaAsset.faces` field, but it is **never populated by any running code** —
the only write site (`manual-evidence.ts:236-237`) hardcodes an empty array with the comment
"nothing has run a detector or a face model over this asset."

This is not a small gap to patch — building it for real means a face-recognition model, GPU
inference (this project has none — see CLAUDE.md's GPU-quota section, not yet granted), and a
lawful-basis argument under the DPDP Act 2023 that the rest of this codebase has consistently
declined to make. **`presence.image` as specified cannot be built by "reusing existing Module-4 face
match" because that thing does not exist to reuse** — see Assumptions & Unknowns for options.

---

## 9. Email, phone, domain-tech, search: what exists vs. what's missing

- **`contact.email`** — MX lookup logic *exists* but is not reusable as written:
  `src/routes/news.tsx:976-991`, an un-exported, route-local Cloudflare DNS-over-HTTPS `type=MX`
  query, coupled to that route's own state, only triggered via a domain extracted from a broader
  query (including the domain half of an email). No email syntax validator exists as a standalone
  utility (the only email regex, `query-planner.ts:36`, is for target-type classification, not
  validation). Gravatar: zero references anywhere.
- **`contact.hibp`** — zero references anywhere; **no credential-vault slot exists** for it. The full
  `CREDENTIAL_PROVIDERS` array (`src/utils/credential-vault.ts:142-355`) has exactly 11 entries
  (reddit, bluesky, mastodon, github, ucdp, llm-primary, llm-fallback, reliefweb, youtube, instagram
  [blocked], facebook [blocked]) — none HIBP-shaped. A new entry would need every field of
  `CredentialProvider` (`credential-vault.ts:98-133`) populated with real prose, plus a
  `resolveCredential("hibp")` call site and (if `verifiable: true`) a new branch in
  `verifyProviderCredential()`'s switch.
- **`contact.phone`** — no phone-parsing library is a dependency (`libphonenumber-js` etc. absent
  from `package.json`); only a loose shape regex (`query-planner.ts:39`) used for target-type
  routing, not validation/normalization. No collector currently declares `phone` support at all.
- **`contact.domain`** — RDAP genuinely exists and is reusable (`existing/rdap.ts`, wraps a real
  `rdap.org` query, returns registrar/dates/nameservers). **Wappalyzer-style live tech
  fingerprinting does not exist anywhere** — RDAP is registration metadata, Shodan InternetDB
  (`existing/shodan-internetdb.ts`) is passive-scan ports/CPEs/CVEs, neither is a live-page
  fingerprint.
- **`identity.websearch`** — no Brave Search integration exists (zero references, not a
  dependency). All existing "search" is Google News RSS (news-scoped, real, executed) or
  ToS-constrained manual dork URLs the analyst opens themselves (`dorks.ts`, explicit ToS rationale
  in its header). Readability/full-text extraction exists via **Jina Reader**
  (`external/jina-reader.ts`) — free, keyless, real, verified live — but it accepts only `url`-typed
  targets; it cannot itself discover which URLs to read. A real `identity.websearch` needs (a) a
  search step to find candidate bio/company-page URLs and (b) Jina Reader (or a new self-hosted
  extractor — no `@mozilla/readability`-equivalent dependency exists today either) to extract them.
- **`presence.username`** — no Sherlock/Maigret-equivalent exists. `existing/social.ts` checks
  exactly 3 named platforms (Bluesky, Telegram directly; Reddit via keyword search, explicitly never
  producing an identity claim) via each platform's own content API — structurally different from a
  broad HTTP-existence sweep across dozens/hundreds of site templates.
- **`presence.news`** — GDELT-backed news collection genuinely exists and is directly reusable
  (`existing/news.ts`, wraps `collectNewsGeo`), already produces `article` entities with
  `MENTIONED_IN`/`LOCATED_IN` relationships and real source provenance.

---

## 10. External-tool integration pattern (for `presence.username`'s Sherlock/Maigret shell-out)

**⚠️ Correction to the task's phrasing.** The task says `presence.username` should be "out-of-process
where it shells to a tool." Read literally ("shells to a tool") this could mean a direct
`child_process`/subprocess spawn from within the Sentinel request handler. **That is not this
codebase's established pattern, and the codebase's own docs explicitly reject it for exactly this
reason.**

The real, already-built, twice-precedented pattern (`external/theharvester.ts`,
`external/spiderfoot.ts`) is an **HTTP client to an independently-deployed worker service**, never
an in-process subprocess:

```ts
// theharvester.ts:82 / spiderfoot.ts:88 — pattern is identical
function workerUrlFromEnv(): string | null {
  const url = process.env.THEHARVESTER_WORKER_URL?.trim();   // or SPIDERFOOT_WORKER_URL
  return url ? url.replace(/\/$/, "") : null;
}
// theharvester.ts:93-98
res = await fetch(`${workerUrl}/harvest`, { method: "POST", ..., signal: AbortSignal.timeout(30_000) });
```

When the env var is unset (the honest default in every environment today — no worker is deployed),
`execute()` returns `collectorUnavailable(id, "…_WORKER_URL is not configured…")` immediately, no
network attempt. Both adapters' own file headers state this explicitly and tie it to two real
constraints: (1) subprocessing a GPL-licensed CLI inside Sentinel's own process is a licensing/linking
concern (theHarvester specifically), and (2) this deploys to Azure Container Apps with scale-to-zero
— there is no persistent process to subprocess into between requests anyway. `docs/OSINT-
INTEGRATION-PLAN.md` §15 ("Worker Strategy," lines 774-798) states the same architecture:
"Do not make the external worker a required dependency for normal Sentinel startup." CLAUDE.md
confirms "No Docker locally" and this project's only other external-process precedent (`ai-service/`)
is also a separately-deployed, separately-versioned HTTP service, never an in-process subprocess.

**A Sherlock/Maigret-backed `presence.username` collector should follow this exact shape**: a new
`SHERLOCK_WORKER_URL` (or similar) env var, a `fetch()` call to a small HTTP wrapper around the tool
running on its own host, `collectorUnavailable(...)` when unset, `isOptional: true`. No worker exists
today (matching theHarvester/SpiderFoot's honest current state) — standing one up is real
infrastructure work, out of scope for the Sentinel-side collector code itself, exactly as the
integration plan already treats theHarvester/SpiderFoot's workers.

---

## 11. Lawful-basis gate + audit log (task requirement #1) — confirmed absent, one cross-reference found

Direct search of `src/` for `caseRef`, `lawfulBasis`, `auditLog`, `investigator`-as-a-field: **no
code construct exists for any of these.** "Lawful basis" appears only as prose inside DPDP Act
2023 compliance-warning strings/comments (`collection-policy.ts`, `manual-capture-panel.tsx`,
`youtube-collector.ts`, `imaging.ts`) — never as a field, type, or enum. "Audit log" appears three
times, every one explicitly documenting its **absence** (`social.ts:2135`,
`collection-policy.ts:165`, `routes/profile.tsx:107` — e.g. `collection-policy.ts:165`: `// NOT
"audit logged" — no audit trail exists anywhere in this system.`).

One exception worth flagging as a cross-reference, not a reusable asset: `src/routes/login.tsx:38`
references an audit log "already exists in git at commit `214f0df`, held by branch..." — this
matches CLAUDE.md's own documented `backup/pre-auth-rollback` branch (the deliberately-reverted
auth system, tag `pre-auth-rollback-20260806`). That audit log was built for user login events, not
case-scoped OSINT-investigation events, and CLAUDE.md is explicit that re-introducing that branch's
work is "a product decision, not a merge task" left deliberately undone. **A new, small,
purpose-built audit log for this feature (investigator/caseRef/subjectSeeds/startedAt/sources, per
the task's own spec) is genuinely new work, not something to pull from that branch** — but worth
naming so nobody rediscovers it mid-implementation and wonders whether to merge instead of build.

**What already exists that a lawful-basis gate could attach to**: `src/utils/investigations-store.ts`
(314 lines) — a real case concept, `Investigation { id: "INV-nnnn", target, title, status, owner,
keywords, evidence: PinnedEvidence[], notes, createdAt }`, with sequential id generation
(`createInvestigation()`, lines 104-135) and `localStorage`-only persistence
(`sentinel_investigations`, versioned, migration-drop on mismatch). Its own file header explicitly
disclaims fabricated risk/threat scoring ("There is deliberately NO risk score and NO threat score.
Nothing in this system computes either," lines 231-234) — the same anti-fabrication discipline the
Person Investigation feature needs for confidence scoring.

**Critical architectural finding**: `investigations-store.ts` (the case/evidence-pinning system) and
the collector-orchestration layer (`osint/query-planner.ts`, `osint/orchestrator.ts`, `osint/jobs.ts`,
consumed by `/recon`) **do not talk to each other at all** — confirmed via `orchestrator.ts`'s own
header comment: *"nothing here writes to `investigations-store.ts` or any graph."* A Person
Investigation feature needs to either (a) bridge these two systems (an investigation gets a real
`INV-nnnn` id via `investigations-store.ts`, and the orchestrator's results get pinned into it as
evidence), or (b) build a separate, smaller case concept scoped just to this feature. Given
requirement zero ("do NOT build a parallel stack"), (a) is the reading that best fits the task's own
constraint, but it means touching (additively) both systems, which is worth confirming before
building — see Assumptions & Unknowns.

---

## 12. Summary table: task's 8 requested collectors vs. reality

| Collector | Reusable today | Genuinely missing | Notes |
|---|---|---|---|
| `identity.websearch` | Jina Reader (`url`→text) | Brave Search (no search-by-name step exists) | Needs a real search API key/integration before Jina Reader has anything to read |
| `contact.email` | MX logic exists, route-locked | Syntax validator, Gravatar | MX code needs extracting to a reusable util first (same shape as RDAP's own prior extraction) |
| `contact.hibp` | Credential-vault *pattern* | The provider entry itself, the API client | Needs a new `CredentialProvider` + a real, gated call |
| `contact.phone` | — | Everything (no library, no collector, no target-type support beyond a shape regex) | `libphonenumber-js` (or similar) is a new dependency |
| `contact.domain` | RDAP fully reusable | Wappalyzer-equivalent tech detection | RDAP alone ≠ "tech check" the task asks for |
| `presence.username` | Worker-pattern (theHarvester/SpiderFoot precedent) | Sherlock/Maigret worker itself | No worker deployed for anything yet — same honest "adapter built, worker doesn't exist" state as the two existing external collectors would be the expected initial outcome |
| `presence.news` | `existing/news.ts` fully reusable | — | Closest thing to "already done" of the eight |
| `presence.image` | — | **Everything** — no face detection/matching exists anywhere, and its absence is a stated, deliberate, DPDP-Act-motivated design decision | Cannot be built as "reuse Module 4" — there is nothing to reuse |

---

## Assumptions & unknowns

These need an explicit answer (or explicit acceptance of the assumption stated) before
implementation starts:

1. **`docs/PERSON-INVESTIGATION-PLAN.md` does not exist.** Per the user's direction, this analysis
   and the resulting implementation treat the task's own inline instructions as the authoritative
   plan, layered on top of `docs/OSINT-INTEGRATION-PLAN.md`. If a real plan document surfaces later,
   it should be reconciled against this analysis, not silently override it.

2. **`presence.image` cannot be built as specified.** The task says "reuse existing Module-4 face
   MATCH against an operator-supplied reference set" — this does not exist, and its absence is a
   deliberate DPDP Act 2023 decision already made and disclosed in the product UI. Three options,
   needing a decision: (a) drop `presence.image` from this feature's v1 entirely, and note it as a
   deferred capability the same way `NOT_IMPLEMENTED` already does; (b) scope it down to something
   that genuinely exists today — e.g. pHash near-duplicate matching of an operator-supplied reference
   photo against collected images (real, already built, NOT face matching — a different, weaker
   signal that must not be presented as identity confirmation); (c) treat "build real face matching"
   as its own separate, much larger task with its own lawful-basis sign-off, GPU/model sourcing, and
   DPDP compliance review, explicitly out of scope for this pass. Recommendation: (a) or (b), not (c),
   given this project's zero-GPU constraint and its consistent prior stance on this exact capability.

3. **"Cytoscape.js" in requirement #6 — literal dependency or a description of "a graph"?**
   Cytoscape.js is not used anywhere in this codebase; the real, working graph is a dependency-free
   SVG+BFS-ring layout. Assumption: the task means "a person-centered graph view," and the existing
   `/graph` infrastructure (already Person-capable — `layoutRadial()` takes any `preferredRootId`)
   satisfies this without a new rendering dependency, consistent with "do NOT build a parallel
   stack." If Cytoscape.js specifically is a hard requirement (e.g. for a specific interaction model
   this analysis isn't aware of), that changes the plan meaningfully and should be said explicitly.

4. **"Shells to a tool" for `identity.websearch`/`presence.username`.** Assumption: this means the
   established worker-over-HTTP pattern (theHarvester/SpiderFoot precedent), not a literal in-process
   subprocess spawn — the codebase has twice already rejected subprocessing external tools, for
   licensing and scale-to-zero reasons documented in both existing adapters' file headers. No worker
   for Sherlock/Maigret (or a Brave-Search-backed identity.websearch) exists today; building the
   Sentinel-side adapter against an undeployed `*_WORKER_URL` (reporting `unavailable` honestly, per
   Rule 5) is consistent with how theHarvester/SpiderFoot currently ship. Standing up the actual
   worker(s) is separate infrastructure work.

5. **The task's failure-envelope shape (`status:'ok'|'error'|'timeout'|'skipped'`) doesn't match the
   real `CollectorExecutionMeta`/`ExecutionStatus` already built and tested across the whole
   collector framework.** Assumption: new collectors emit the real enum
   (`queued|running|completed|partial|failed|cancelled`, with `reason` inside a nested `error`
   object drawn from the real 8-value `CollectorErrorReason` union) rather than inventing a second,
   parallel status vocabulary — required by requirement zero, "do NOT build a parallel stack."

6. **Where does the lawful-basis gate + audit log live?** Assumption: it bridges into
   `investigations-store.ts`'s existing `Investigation`/case concept (real `INV-nnnn` ids already
   generated) rather than inventing a second case system, since that store already has the closest
   thing to a "case reference" this codebase has, and requirement zero rules out a parallel stack.
   This does mean additively extending `investigations-store.ts` (new fields: lawful-basis
   attestation, investigator, audit entries) — confirm this is the intended integration point rather
   than a feature-local audit mechanism, since the store today is `localStorage`-only (no
   server-side persistence, no cross-analyst visibility) and an audit log for a lawful-basis gate
   arguably wants server-side durability the way `JOB_STORE_PATH`'s optional SQLite backing already
   demonstrates a precedent for.

7. **Which collectors are viable for a genuinely useful v1** given the gaps above: `presence.news`
   (fully reusable today), `contact.domain`'s RDAP half (fully reusable), `identity.websearch`'s
   extraction half via Jina Reader (reusable, but needs a search step in front of it — Brave Search
   specifically is unbuilt and would need a real API key), and `presence.username` as an honestly
   `unavailable` adapter-with-no-worker (matching theHarvester/SpiderFoot's current shipped state,
   not a placeholder). `contact.email`, `contact.phone`, `contact.hibp`, `contact.domain`'s tech-check
   half, and `presence.image` all need real new work before they do anything beyond report
   `unavailable`/`no-credential` honestly. Confirm whether "ship 8 honestly-partial collectors in one
   pass" or "ship a smaller number that are genuinely functional, plus honestly-unavailable stubs for
   the rest, expanded incrementally" is the intended scope — the integration plan's own Rule 3 ("one
   architectural layer at a time") and its actual multi-day P0→P1→P2→P3 delivery history suggest the
   latter.

8. **Brave Search API key.** Not currently in `credential-vault.ts`, not currently an env var
   anywhere. `identity.websearch` as specified needs one; confirm whether acquiring/configuring this
   key is in scope for this task or a prerequisite the user will handle separately (matching how Exa
   was evaluated-and-deferred in a prior pass specifically for lacking a key, per
   `OSINT-INTEGRATION-PLAN.md` §21i).

9. **`/osint` vs `/recon` vs a new route for the Person Investigation UI.** The integration plan's
   own §21 UI Strategy names `/osint` as the intended home for person-shaped investigations, but
   `/osint` currently has zero wiring to the collector-orchestration layer (confirmed) — it's a
   fixed-tab IOC/geopolitical dashboard. `/recon`'s `InvestigationPanel` already has the real,
   working job-polling UI pattern this feature needs, but is documented (plan §21, Rule 4) as a
   domain/infrastructure-oriented page. Building a Person Investigation form as a new panel on
   `/osint` (reusing `/recon`'s `InvestigationPanel` code shape, not its literal placement) seems the
   best fit for "existing UI stays intact... unless the specific phase requires a small extension"
   (Rule 4), but this is a judgment call worth confirming rather than assuming.

10. **`libphonenumber-js` (or equivalent) as a new dependency.** `contact.phone` as specified needs
    a real phone-parsing library; none exists today. This is a small, standard, well-licensed
    addition (matching how `undici` was added explicitly rather than relying on a transitive install
    earlier this session) but is still a new dependency, worth calling out rather than silently
    adding.
