# Sentinel OSINT Integration Master Plan

## Purpose

This document is the **single source of truth** for extending the
existing Sentinel project with additional OSINT capabilities without
breaking, replacing, or unnecessarily refactoring existing
functionality.

Repository: `https://github.com/AvinashBayya/social-media-ai-agents-v2`

Primary development tools:

-   Claude Code in VS Code
-   Antigravity IDE for UI/browser verification
-   Existing Sentinel codebase
-   Optional Docker/Python workers for external OSINT tools
-   Kali Linux is **not** a production dependency

------------------------------------------------------------------------

# 1. Non-Negotiable Rules

These rules apply to every implementation task.

## Rule 1 --- Do not rewrite existing modules

Do not replace working implementations merely because a new tool can
perform a similar task.

Existing Sentinel collectors remain the first implementation.

New tools are **adapters/enrichers**, not replacements.

------------------------------------------------------------------------

## Rule 2 --- Preserve current functionality

Before and after every phase:

``` bash
bun test
tsc --noEmit
bun scripts/check-exports.ts
bun scripts/fabrication-check.ts
```

If a change breaks existing tests or functionality, stop the feature
work and fix the regression first.

------------------------------------------------------------------------

## Rule 3 --- One architectural layer at a time

Do not ask Claude Code to implement:

-   collector framework
-   SpiderFoot
-   theHarvester
-   UI redesign
-   database migration
-   graph changes

in one prompt.

Claude Code must work from the priorities in this document.

------------------------------------------------------------------------

## Rule 4 --- Existing UI stays intact

Do not redesign `/osint`, `/recon`, `/social`, `/graph`, `/images`,
`/videos`, `/news`, `/reports`, or other existing routes unless the
specific phase requires a small extension.

Reuse existing components and styles.

------------------------------------------------------------------------

## Rule 5 --- New collectors must be optional

If SpiderFoot or theHarvester is unavailable, Sentinel must still work.

A failed external collector must result in:

``` text
collector: spiderfoot
status: failed
reason: timeout
```

and **not**:

``` text
collector: spiderfoot
results: 0
```

A failure is not an empty result.

------------------------------------------------------------------------

## Rule 6 --- Never fabricate OSINT facts

Every externally collected fact must retain:

-   source
-   source URL where applicable
-   collector
-   collection time
-   raw/normalized value
-   confidence where applicable

AI interpretation must never be presented as independently collected
fact.

------------------------------------------------------------------------

# 2. Target Architecture

The final architecture is:

``` text
                         SENTINEL UI
                              |
                              v
                    INVESTIGATION API
                              |
                              v
                    OSINT ORCHESTRATOR
                              |
             +----------------+----------------+
             |                |                |
             v                v                v
        PERSON ENGINE    DOMAIN ENGINE    SEARCH ENGINE
             |                |                |
             |                +-- DNS         +-- Dorks
             |                +-- RDAP        +-- News
             |                +-- crt.sh      +-- RSS
             |                +-- Shodan
             |                +-- theHarvester
             |                +-- SpiderFoot
             |
             +-- Existing social/public collectors
                              |
                              v
                       NORMALIZATION
                              |
                              v
                       ENTITY RESOLUTION
                              |
                 +------------+------------+
                 |                         |
                 v                         v
             EVIDENCE                    GRAPH
                 |                         |
                 +------------+------------+
                              |
                              v
                    REPORTS / TIMELINE
```

The most important new component is:

``` text
OSINT ORCHESTRATOR
```

It decides which collectors should run for a target, executes them,
normalizes their output, and sends results into the existing Sentinel
evidence/entity/graph systems.

------------------------------------------------------------------------

# 3. Priority System

Use this priority system throughout the project.

  Priority   Meaning
  ---------- ---------------------------------------------
  P0         Must exist before other work
  P1         Core functionality
  P2         Important enhancement
  P3         Optional/future
  P4         Do not implement unless requirements change

### P0

-   Baseline verification
-   Collector interface
-   Common result model
-   Collector registry
-   Regression protection

### P1

-   Existing collector adapters
-   OSINT orchestrator
-   Job/status model
-   theHarvester
-   SpiderFoot
-   Entity normalization
-   Evidence integration
-   Graph integration

### P2

-   Unified investigation UI
-   Collector health
-   Better confidence scoring
-   Report integration
-   Optional Nmap
-   Better username discovery

### P3

-   Full Shodan API
-   Maltego export/integration
-   Additional providers
-   Continuous monitoring
-   Advanced automation

### P4

Do not implement as part of the free OSINT project:

-   private account access
-   credential collection
-   privacy-control bypass
-   unauthorized camera access
-   paid people-search databases
-   paid scraping/proxy infrastructure as a required dependency

------------------------------------------------------------------------

# 4. Existing Capabilities to Preserve

The current repository already contains substantial functionality.

Treat these as existing infrastructure:

-   `/osint`
-   `/recon`
-   `/social`
-   `/entities`
-   `/graph`
-   `/images`
-   `/videos`
-   `/youtube`
-   `/news`
-   `/sources`
-   `/investigations`
-   `/reports`
-   `/gis`
-   search utilities
-   dork generation
-   evidence handling
-   credibility/scoring
-   RSS/news collection
-   social collectors
-   certificate transparency
-   DNS/infrastructure enrichment
-   Shodan InternetDB
-   image/video analysis

Do not rebuild these.

------------------------------------------------------------------------

# 5. Existing Tool Mapping

## Google Dorks

Status: **Already implemented**

Primary location:

``` text
src/utils/dorks.ts
src/routes/recon.tsx
```

Action:

-   preserve current implementation
-   wrap it as a collector
-   connect generated results to investigations/evidence
-   do not introduce aggressive search scraping

Priority: **P1**

------------------------------------------------------------------------

## Shodan

Status: **Partially implemented**

The current project already uses Shodan InternetDB for free
infrastructure enrichment.

Action:

-   preserve InternetDB
-   create a normalized collector adapter
-   connect ports/CPE/CVE/hostname information to entities
-   make full Shodan API optional

Priority: **P1**

------------------------------------------------------------------------

## crt.sh

Status: **Already implemented**

Action:

-   wrap current implementation as a collector
-   normalize discovered certificates/domains
-   preserve current failure semantics

Priority: **P1**

------------------------------------------------------------------------

## DNS/RDAP

Status: **Already implemented**

Action:

-   wrap existing implementation
-   normalize results
-   connect domain → IP → infrastructure relationships

Priority: **P1**

------------------------------------------------------------------------

## News/RSS/GDELT

Status: **Already implemented**

Action:

-   preserve current providers
-   normalize articles
-   connect article → person/organization/location relationships
-   retain source metadata

Priority: **P1**

------------------------------------------------------------------------

## Social

Status: **Already implemented**

Current social functionality must remain intact.

Action:

-   do not replace `src/utils/social.ts`
-   create adapters around existing supported sources
-   add public username discovery as a separate enrichment capability
-   clearly label unavailable/restricted platforms

Priority: **P1/P2**

------------------------------------------------------------------------

## Images/Videos

Status: **Already implemented**

Action:

-   preserve existing image/video analysis
-   connect media to evidence
-   connect media references to investigations/entities

Priority: **P2**

------------------------------------------------------------------------

# 6. New Collector Architecture

Create:

``` text
src/utils/collectors/
├── types.ts
├── result.ts
├── registry.ts
├── errors.ts
├── index.ts
│
├── existing/
│   ├── dorks.ts
│   ├── dns.ts
│   ├── rdap.ts
│   ├── crtsh.ts
│   ├── shodan-internetdb.ts
│   ├── news.ts
│   └── social.ts
│
├── external/
│   ├── theharvester.ts
│   └── spiderfoot.ts
│
└── optional/
    ├── nmap.ts
    └── maltego.ts
```

Do not move existing implementations immediately if doing so would
create unnecessary risk.

Adapters can initially import existing utilities.

------------------------------------------------------------------------

# 7. Common Collector Contract

Every collector must conceptually implement:

``` text
id
name
category
supportedTargetTypes
requiresCredentials
isOptional
execute()
normalize()
healthCheck()
```

Example target types:

``` text
person
email
phone
username
domain
ip
url
location
article
image
video
```

------------------------------------------------------------------------

# 8. Common Result Model

Every collector must produce:

``` text
InvestigationResult
├── entities[]
├── relationships[]
├── evidence[]
├── warnings[]
├── errors[]
├── metadata
└── execution
```

## Entity

``` text
id
type
value
displayName
source
confidence
metadata
```

## Relationship

``` text
sourceEntity
relationshipType
targetEntity
confidence
source
```

## Evidence

``` text
source
sourceUrl
collector
collectedAt
rawValue
normalizedValue
confidence
metadata
```

## Execution

``` text
status
startedAt
completedAt
duration
resultCount
error
```

------------------------------------------------------------------------

# 9. Collector Registry

Create a central registry.

Conceptually:

``` text
Collector Registry
|
+-- dorks
+-- dns
+-- rdap
+-- crtsh
+-- shodan-internetdb
+-- news
+-- social
+-- theharvester
+-- spiderfoot
```

The orchestrator should ask the registry:

``` text
Which collectors support this target?
```

rather than hard-coding tool logic throughout route files.

------------------------------------------------------------------------

# 10. Query Planner

Create:

``` text
src/utils/osint/query-planner.ts
```

Responsibilities:

1.  Detect target type.
2.  Identify available input fields.
3.  Select appropriate collectors.
4.  Avoid irrelevant collectors.
5.  Apply free-resource policy.
6.  Apply safety/authorization rules.
7.  Return an execution plan.

Example:

``` text
Input:
example.com

Plan:
- DNS
- RDAP
- crt.sh
- Shodan InternetDB
- theHarvester
- SpiderFoot
```

Example:

``` text
Input:
johnsmith

Plan:
- public search
- username discovery
- news
- social collectors
```

Do not run infrastructure collectors until a domain/IP is available.

------------------------------------------------------------------------

# 11. OSINT Orchestrator

Create:

``` text
src/utils/osint/orchestrator.ts
```

Flow:

``` text
Input
  |
  v
Query Planner
  |
  v
Collector Registry
  |
  v
Create Jobs
  |
  v
Run Collectors
  |
  v
Normalize Results
  |
  v
Deduplicate
  |
  v
Resolve Entities
  |
  v
Create Evidence
  |
  v
Create Relationships
  |
  v
Update Graph
  |
  v
Return Investigation
```

The orchestrator should not contain UI code.

------------------------------------------------------------------------

# 12. Job System

External tools must not run inside a normal browser request for an
extended period.

Create a job abstraction:

``` text
InvestigationJob
├── id
├── investigationId
├── collector
├── target
├── status
├── progress
├── startedAt
├── completedAt
├── resultCount
└── error
```

Statuses:

``` text
queued
running
completed
partial
failed
cancelled
```

API behavior:

``` text
POST /investigation
    -> returns job/investigation id

GET /investigation/:id
    -> returns current state
```

------------------------------------------------------------------------

# 13. theHarvester Integration

Priority: **P1**

Create:

``` text
src/utils/collectors/external/theharvester.ts
```

Implementation requirements:

-   run as an external process/worker
-   validate domain targets
-   use explicitly selected sources
-   request structured JSON output
-   parse JSON through a dedicated parser
-   convert emails/hosts/IPs into common entities
-   create evidence
-   record execution metadata
-   implement timeout
-   implement failure handling
-   never convert execution failure into empty results
-   do not use `-b all` as the default strategy

Recommended first sources:

``` text
crtsh
certspotter
```

Expand sources only after the basic adapter works.

------------------------------------------------------------------------

# 14. SpiderFoot Integration

Priority: **P1**

Create:

``` text
src/utils/collectors/external/spiderfoot.ts
```

Do not embed SpiderFoot Python directly inside the main TanStack request
handler.

Preferred flow:

``` text
Sentinel
   |
   v
Job
   |
   v
SpiderFoot Worker
   |
   v
SpiderFoot
   |
   v
JSON result
   |
   v
Parser
   |
   v
InvestigationResult
```

The worker should be independently restartable.

SpiderFoot failure must not prevent Sentinel from functioning.

------------------------------------------------------------------------

# 15. Worker Strategy

For local development:

``` text
Sentinel
+
SpiderFoot worker
+
theHarvester worker
```

Docker is preferred.

For production:

``` text
Azure Sentinel container
+
optional OSINT worker
```

Do not make the external worker a required dependency for normal
Sentinel startup.

------------------------------------------------------------------------

# 16. Persistence

The current application uses local/container state in places, which is
not sufficient for durable external-tool jobs in a scale-to-zero
deployment.

Introduce persistent storage for:

``` text
investigations
jobs
entities
relationships
evidence metadata
collector runs
```

Preferred production direction:

``` text
PostgreSQL
```

For development/testing:

``` text
SQLite or existing test storage
```

Do not migrate the entire application database at once.

Introduce persistence incrementally around the new investigation/job
subsystem.

------------------------------------------------------------------------

# 17. Entity Resolution

Create:

``` text
src/utils/osint/entity-resolution.ts
```

Responsibilities:

-   normalize casing
-   normalize email
-   normalize domain
-   normalize usernames
-   normalize URLs
-   deduplicate identical entities
-   identify likely relationships
-   preserve source provenance

Example:

``` text
SpiderFoot:
john@example.com

theHarvester:
john@example.com

Search:
john@example.com
```

Result:

``` text
ONE EMAIL ENTITY
+
THREE EVIDENCE ITEMS
```

Do not create three duplicate email entities.

------------------------------------------------------------------------

# 18. Confidence Model

Confidence must be evidence-based.

Possible signals:

``` text
same exact email
same username
same organization
same location
multiple independent sources
explicit source statement
```

Do not infer identity merely from a matching name.

Every confidence score should be explainable.

Example:

``` text
Confidence: 82%

Reasons:
+ same public email
+ same organization
+ two independent sources
+ matching username
```

------------------------------------------------------------------------

# 19. Graph Integration

Reuse the existing graph.

Do not build a second graph system.

New entities should flow into:

``` text
Person
Email
Phone
Username
Social Account
Organization
Domain
IP
Location
Article
Image
Video
```

Relationships should include:

``` text
HAS_EMAIL
USES_USERNAME
WORKS_AT
LOCATED_IN
MENTIONED_IN
OWNS_DOMAIN
RESOLVES_TO
HOSTED_ON
HAS_PORT
SUPPORTED_BY
```

------------------------------------------------------------------------

# 20. Evidence Integration

Every collector must use the existing evidence model.

Do not dump raw collector output directly into UI state.

Pipeline:

``` text
Collector
  |
  v
Raw result
  |
  v
Parser
  |
  v
Normalized entity
  |
  v
Evidence
  |
  v
Graph
```

The source of every fact must remain inspectable.

------------------------------------------------------------------------

# 21. UI Strategy

Do not create separate pages for every tool.

Keep current routes.

## `/recon`

Use for:

-   domain
-   DNS
-   RDAP
-   certificates
-   subdomains
-   IP
-   ports
-   Shodan
-   theHarvester
-   SpiderFoot

## `/osint`

Use for:

-   person
-   email
-   username
-   location
-   news
-   social
-   investigation overview

## `/graph`

Use for:

-   entity relationships
-   investigation graph

## `/reports`

Use for:

-   final investigation report
-   evidence
-   sources
-   timeline

------------------------------------------------------------------------

# 21a. `/recon` — Investigation panel landed (2026-08-14)

A new panel, "OSINT Investigation — multi-collector," was added to the existing
`/recon` page (`InvestigationPanel` in `src/routes/recon.tsx`), following the same
self-contained-panel pattern the page's existing `AttackSurfacePanel`/
`SubdomainPanel`/`DorkPanel` already use — one new component, one new line in the
page's render, nothing else touched. Backed by a new `runOsintInvestigation`
`createServerFn` in `src/utils/osint/orchestrator.ts`, which registers both the P1
existing-collector adapters and the theHarvester/SpiderFoot adapters, runs
`runInvestigation()`, and applies `resolveInvestigationEntities()` (§17) before
returning — so the UI shows merged entities, not raw per-collector duplicates.

**Covers, from the P2-UI checklist below:** investigation start, collector status,
results, and a partial cut of collector selection (automatic, via the query
planner — no manual per-collector override) and evidence (a count is shown; no
per-item inspector). **Does not cover:** progress (uses the synchronous
orchestrator with a loading spinner, not the job-polling system — a slow
collector just makes the button take longer) or graph navigation.

**Real bug found and fixed by actually testing this in a browser, not just
`tsc`/`bun test`:** the handler only called `registerExistingCollectors()` —
`registerExternalCollectors()` (a new file, `collectors/external/index.ts`,
mirroring `existing/index.ts`'s pattern) didn't exist yet, so theHarvester and
SpiderFoot were built, tested, and never reachable from anywhere — exactly the
"control with no handler" pattern CLAUDE.md's own fabrication-audit history
warns about. A `tsc`/`bun test`-only verification would not have caught this;
both adapters have their own passing unit tests regardless of whether anything
ever registers them. Confirmed fixed the same way it was found: re-ran the
browser test, watched the collector count go from 6 to 8 with `theharvester`/
`spiderfoot` both correctly reporting `unavailable` (no worker configured, per
their own file headers).

**Verified live, against real free APIs, not mocked:** a `github.com` run
returned 31 entities / 28 evidence items, with `dorks`/`dns`/`rdap`/
`shodan-internetdb` completing, `crtsh` failing with the exact live "HTTP 503
after a retry" message `recon-sources.ts` itself would produce, and `news`
failing `rate-limited` on a repeat run (GDELT's real 1-req/5s limit, per
CLAUDE.md) — the merged `github.com` domain entity showed 95% confidence from
3 independent collectors, a real, live exercise of the entity-resolution
confidence model (§18), not a fixture. Screenshotted; visually consistent with
the rest of `/recon`'s existing styling.

## 21b. `/recon` — live progress landed (2026-08-14)

The panel above was rebuilt the same day to poll rather than block, closing
the plan's "Progress" item: `InvestigationPanel` now calls
`startOsintInvestigationJob`/`pollOsintInvestigationJob` (two new
`createServerFn`s in `jobs.ts`, mirroring `orchestrator.ts`'s existing
`runOsintInvestigation`) instead of the synchronous `runOsintInvestigation`,
polling every 1.2s until every job reaches a terminal status. Per-collector
badges now show `running` (with a spinning icon) while in flight and the
real terminal status once each finishes, rather than only appearing once
the whole investigation is done.

This is the first UI consumer `jobs.ts` has ever had. Before this it was
fully built and unit-tested in P1 but unreachable from the app — the exact
same "control with no handler" shape as the theHarvester/SpiderFoot
registration gap in §21a, just for the whole job system instead of two
collectors. Entity resolution (§17) is deliberately NOT applied during
polling (only `runOsintInvestigation`'s synchronous path does that) — doing
it on every poll tick against a still-growing entity set would be wasted
work; a future refinement could resolve once `done` is true.

**Verified live** (Chrome via `playwright-core`, same method as §21a): ran
against `stripe.com`, captured a screenshot mid-flight showing `dorks`,
`dns`, `rdap`, `crtsh`, `shodan-internetdb` and `news` all in a `running`
state simultaneously (theHarvester/SpiderFoot were already terminal —
correct, since their `unavailable` check needs no network call and returns
instantly), then a second screenshot after polling completed showing all 8
in terminal states (`crtsh` failed on a live HTTP 502, `news` failed
`rate-limited` on GDELT's real limit) with 37 entities / 30 evidence items.
Zero console errors in either run. This is what proves "Progress" actually
works, not just that the code compiles — a screenshot of only the final
state would not have distinguished this from the old blocking version.

## 21c. `/recon` — evidence inspector landed, and a real scale finding (2026-08-14)

Closed the plan's "Evidence" item: a collapsible section under Entities lists every
evidence item individually (collector badge, timestamp, source, confidence where
scored, a JSON preview of `normalizedValue`, and a link to `sourceUrl` when one
exists) — the concrete answer to Rule 6/§20's "the source of every fact must
remain inspectable," not just a count.

**Real finding from testing against an actual large target, not a synthetic
one:** a `cloudflare.com` run returned **3,461 entities** — almost all real
crt.sh-logged subdomains for a company that size, a correct result, not a bug.
Rendering all of them into the DOM uncapped is a genuine performance/UX problem
an analyst would hit on any sizeable target. Capped rendering at 200 items per
list (`MAX_RENDERED_ITEMS`), UI-layer only — the underlying `poll.entities`/
`poll.evidence` arrays are untruncated, so a future report/export/graph view
built on the same data is unaffected. This is exactly the kind of thing a
synthetic fixture would never have surfaced; it took a real target with a real
answer that large.

**Verified live:** `github.com` (148 entities, under the cap) with the evidence
panel expanded and screenshotted — individual rows visible with real collector
attribution, timestamps and source text (e.g. "The GitHub Blog," "Security
Affairs"). Zero console errors.

## 21d. `/recon` — manual collector selection landed, closing P2-UI's checklist (2026-08-14)

Closes the plan's last open "Recon collector selection" item. `InvestigationPanel`
now previews the plan (`planOsintInvestigation`, a new read-only `createServerFn`
in `jobs.ts` — plans without starting anything, no job, no investigation id)
whenever the target changes, rendering one checkbox per candidate collector,
checked by default. `startInvestigation()` (`jobs.ts`) gained an optional
`collectorIds` parameter that restricts execution to the given subset — omit it
(or pass every candidate) to get the unchanged "run everything" default; pass an
empty array to explicitly run nothing (distinct from "no target set" — the button
is disabled in that case too, but for a different, honest reason, and the
distinction is preserved rather than collapsed into one generic disabled state).
`startOsintInvestigationJob`'s validator gained the same optional field and
threads it straight through.

**Verified live:** an `example.com` run showed all 8 collectors checked by
default ("8/8"), deselecting `news` and `shodan-internetdb` updated the count to
"6/8," and the subsequent run's live collector-status list showed **exactly the
6 selected collectors** — `news` and `shodan-internetdb` did not appear at all,
confirming the filter reaches all the way through to execution, not just the
UI's own checkbox state. Zero console errors.

## 21e. `/graph` rebuilt from a fixed fictional topology to a real one (2026-08-14)

Closes P2-UI's last open item. `/graph` previously rendered ten hand-placed
nodes ("Vector-17", "Aster Motors") behind a `SampleDataBanner` disclosing the
fiction. It is now driven entirely by a real investigation's entities and
relationships, handed off from `/recon`.

**New, pure/testable logic** (`src/utils/graph-layout.ts`, `graph-store.ts`):

- `layoutRadial()` — deterministic BFS-ring layout from one root entity
  (typically the investigated target). No physics simulation, no external
  layout library: rings by hop distance, evenly spaced by angle within a
  ring, radius by connection degree. An entity with no path to the root is
  still placed (never dropped), in an honest outermost ring (`ring: null`),
  matching the coordinate-honesty discipline §5's GIS layer already uses for
  unplaceable records.
- `shortestPath()` — real BFS path between two entities, replacing the
  fixture's hand-written "Vector-17 → Aster Motors" narration with an actual
  traversal over the collected relationship set. Returns `null` (never a
  guessed route) when no path exists.
- `graph-store.ts` — a versioned localStorage hand-off (`sentinel_graph_snapshot`),
  the same pattern `investigations-store.ts` and `active-target.ts` already
  use. One snapshot at a time; this is a hand-off, not a history — an
  analyst wanting to keep multiple investigations uses the existing
  evidence-pinning system instead.
- 23 new tests across both files (empty input, single node, BFS ring
  assignment, unreachable-node handling, degree-based radius, shortest-path
  correctness including "picks the shorter of two routes," malformed
  localStorage payloads rejected rather than coerced).

**Wiring:** `/recon`'s `InvestigationPanel` gained a "View in Graph" button
(next to the detected-type line, enabled once the poll has returned at least
one entity) that saves the current investigation's entities/relationships and
navigates to `/graph`. `/graph` reads the snapshot on mount; with none saved,
it shows an honest empty state (`EmptyState`, "No Investigation Loaded," a
link back to Recon) instead of falling back to sample data.

**Full entity-type styling:** the fixture's `TYPE_STYLE` covered 7 invented
types (`person | org | country | domain | phone | email | social`) that did
not match the real 13-value `EntityType` union. Replaced with 13 evenly-spaced
hues (360°/13 ≈ 27.7° apart) so every real type — including `ip`, `url`,
`username`, `article`, `image`, `video`, `social_account` — gets a genuinely
distinct color rather than a handful sharing a "misc" bucket.

**Node detail panel** is real: clicking a node shows its actual `displayName`,
`value`, source collector, confidence (or "not scored" — never a fabricated
number), live-computed connection count, and BFS distance from the
investigated target. The fixture's "Aliases," "Risk score" and "First seen"
fields are gone — nothing in a `CollectorEntity` carries any of those, and
inventing them would be exactly the fabrication CLAUDE.md's hard constraints
forbid.

**Scale handling:** the same class of problem §21c found on `/recon` (3,461
raw entities from crt.sh) applies here — rendering thousands of SVG nodes is
a real DOM-size problem. Capped at `MAX_GRAPH_NODES = 150`, keeping the
entities nearest the investigated target by BFS ring rather than an arbitrary
slice, and disclosed on-canvas ("N of M entities shown") rather than silently
truncated.

**Verified live** (Playwright + system Chrome, `google.com` target): empty
state confirmed before any investigation exists; ran a real investigation,
clicked "View in Graph," landed on a populated graph with real `RESOLVES_TO`
edges between `google.com` and its live-resolved IPs; clicked a node and
confirmed the detail panel showed real DNS-collector data (`Source collector:
dns`, `Connections: 6`, `Distance from target: 0` for the root itself);
selected a second, non-root node (a news article entity from the `dorks`
collector) and confirmed the "Path to target" panel rendered a real
`mentioned in` relationship back to `google.com`; typed a non-matching filter
string and confirmed non-matching nodes dimmed rather than the fixture's
static behavior. Zero console errors throughout. One real, expected
consequence of already-documented behavior, not a new bug: `pollInvestigation()`
(`jobs.ts`) dedupes entities by exact id, not by value, so two collectors
that each independently produce a `domain` entity for the same value (e.g.
`dns` and `rdap` both resolving `google.com`) render as two separate nodes —
value-based cross-collector merging is `entity-resolution.ts`'s job, used by
the batch `runOsintInvestigation` path but not by the live polling path this
UI uses. Retrofitting that is a separate, larger change or a scoping choice
in that layer, not a Graph-UI bug.

**Full suite:** 835/835 passing (23 up from 812 before this item), `tsc
--noEmit` clean, `fabrication-check` unchanged at 81 (one new match introduced
and immediately fixed — a `?? 0` on a `Map.get()` that is structurally always
populated, replaced with a `!` non-null assertion instead of a fallback that
implied a real "unreported" case).

## 21f. `/reports` gains OSINT sourcing, closing P2 -- Reports (2026-08-14)

Closes all four P2-Reports checklist items in one pass — they turned out to be
one integration, not four: OSINT collector evidence and relationships, once
converted to the report layer's own `SourceRef` shape, automatically flow
through Report's existing citation/timeline machinery unchanged.

**New in `src/utils/reports.ts`:**

- `sourcesFromOsintEvidence(evidence, startAt?)` — converts `CollectorEvidence[]`
  into numbered, citable `SourceRef`s. Covers every existing collector (DNS,
  RDAP, crt.sh, Shodan InternetDB, dorks, news, social) and both external
  tools (theHarvester, SpiderFoot) identically — they all already produce the
  same P0 `CollectorEvidence` shape, so there is no separate "external
  results" code path to build. This is what closes "Include external
  collector results" and "Include evidence" together.
- `sourcesFromOsintRelationships(relationships, entities, startAt?)` —
  converts `CollectorRelationship[]` into citable sources too ("example.com
  resolves to 93.184.216.34"), distinct from evidence since a relationship
  carries no `collectedAt`/`sourceUrl` of its own, only the asserting
  collector and (from §17 entity resolution) sometimes a confidence score.
  Closes "Include relationships."
- Both slot into `"Module 2 · content analysis"` — the one `ContributingModule`
  value no existing `sourcesFromX` function had claimed, rather than adding a
  label the report UI and PDF footer would need to learn about.
- "Include timeline" needed no new code: `EVENT_TIMELINE` was already a
  `ProductType` whose prompt asks the model to chronologically order whatever
  sources it receives by `publishedAt`. `sourcesFromOsintEvidence` carries the
  evidence's real `collectedAt` as `publishedAt`, so OSINT-sourced material
  slots into that existing reconstruction generically.
- A real fabrication-guard finding while writing this: the custom
  `sentinel/no-fabricated-fallback` ESLint rule flagged a `catch` branch
  returning the literal `"(unserializable value)"` (a defensive fallback for
  `JSON.stringify` throwing on a `normalizedValue`, near-unreachable in
  practice but not provably so) — rejected because "unserializable" isn't in
  the rule's absence-marker vocabulary. Fixed by rewording to `"(not
  serializable)"`, which matches the rule's own `not\s+\w+` pattern; same
  intent, recognized as an honest absence marker rather than an invented one.

**`/reports` UI (`src/routes/reports.tsx`):** a new "Include OSINT
investigation" button, deliberately a separate, explicit action rather than
folded into the page's existing automatic `collect()` (which already runs on
every subject change for news/geo). Most report subjects here are open topics
("China Taiwan tensions"), not recon targets — running every OSINT collector,
including live crt.sh/Shodan/theHarvester/SpiderFoot calls, on every
collection would be slow and usually return nothing. An analyst working an
actual domain/IP/email subject opts in. Calls the same
`runOsintInvestigation` server function `/recon` uses (registers every
collector, applies entity resolution), converts its evidence and
relationships, and **appends** them to the existing candidate list —
`renumber()` only reassigns citation numbers by array position, so appending
at the end leaves every already-decided inclusion/exclusion untouched.

**Real bug caught by browser-testing, fixed before verification finished:** a
domain with real infrastructure routinely returns 30-100+ evidence and
relationship items, comfortably past `DEFAULT_SOURCE_BUDGET` on their own —
exactly the "HTTP 413: tokens per minute" failure mode `reports.tsx`'s own
comments already document as a prior real incident, just triggered a second
way. First pass appended OSINT sources without applying the budget trim to
them, and a live run showed `71 of 71 included` (everything selected,
nothing trimmed). Fixed by computing remaining budget room from the
analyst's *existing* selections before appending, then pre-excluding only the
overflow among the newly-added OSINT sources — re-running the same live
target then showed the correct `12 of 82 included`, matching
`DEFAULT_SOURCE_BUDGET`, with the existing "N lower-scored sources
pre-excluded" banner (no changes needed there — it already reads generically
off `candidates.length`) rendering the accurate count.

**Verified live** (Playwright + system Chrome, `example.com` target): logged
in, set the subject, "Collect sources" ran automatically (0 news/geo
sources — genuinely nothing collected for a placeholder domain), clicked
"Include OSINT investigation," and confirmed: a real per-run summary
("Included: 30 evidence item(s) and 30 relationship(s) from 8 candidate
collector(s)"); real, honestly-surfaced collector failures rendered on
screen, not swallowed (`crt.sh is not answering reliably... HTTP 502 after a
retry`, `GDELT rate limit... HTTP 429`, theHarvester/SpiderFoot's
already-established `unavailable — no worker configured` messages); the
budget trim correctly capped inclusion at 12 of 71-82 total sources across
two separate runs; 60-71 sources visibly tagged `Module 2 · content
analysis` in the DOM. Also clicked **Generate** with no LLM configured in
this environment and confirmed the existing `LlmUnavailableError` path
produced the honest, pre-existing "No product was produced. No LLM provider
configured..." message rather than hanging or crashing — this session did
not need working LLM credentials to verify the OSINT-sourcing integration
itself. Zero console errors throughout both runs.

**Full suite:** 848/848 passing (13 new), `tsc --noEmit` clean, 151 core
exports unchanged, `fabrication-check` unchanged at 81 after the
`no-fabricated-fallback` fix above. This closes every item in P2 — Reports.

## 21g. Persistent job storage + environment configuration reference (2026-08-14)

Two of six P2-Deployment items. The other four (Worker Dockerfile, local
docker-compose, health checks, Azure configuration) are explicitly **not**
attempted in this pass — deliberately, not by oversight. theHarvester and
SpiderFoot have no deployed worker to containerize (P1 already declared
standing one up "real infra, out of scope"), there is no Docker in this
environment to build or test a Dockerfile against (`CLAUDE.md`: "No Docker
locally"), and Azure configuration touches real subscription resources that
should not be written blind. Persistent job storage and environment
configuration were picked specifically because both are fully buildable and
testable inside this environment with no external infrastructure.

**Persistent job storage** (`jobs.ts`'s own header already named this as the
real limitation: a job is lost on every scale-to-zero cold start between
`POST` and the next `GET`):

- `jobs.ts` used to define its job store as one concrete class. Extracted,
  with zero behavior change, into `src/utils/osint/job-store.ts`: a `JobStore`
  interface (exactly the shape `startInvestigation`/`cancelJob`/
  `pollInvestigation`/`runJob` already depended on) plus `InMemoryJobStore`
  implementing it — byte-for-byte the original logic, just renamed. `jobs.ts`
  re-exports `JobStore`/`InvestigationJob`/`JobStatus`/`InMemoryJobStore`
  under their original names, so nothing importing from
  `@/utils/osint/jobs` needed to change — this is what makes the refactor
  genuinely additive rather than a breaking rename with a wider blast radius.
  One real call site did need updating: `tests/osint-jobs.test.ts`'s 14
  `new JobStore()` constructions became `new InMemoryJobStore()`, mechanical
  and verified by the same tests passing unchanged afterward.
- New `src/utils/osint/job-store-sqlite.ts`: `SqliteJobStore implements
  JobStore`, using `bun:sqlite` (a Bun built-in — no new npm dependency).
  Three tables (`investigations`, `jobs`, `job_results`); every complex field
  (`target`, `error`, the four result arrays) stored as JSON text, since
  SQLite has no native array/object column — the same kind of
  already-proven-serializable round-trip `runOsintInvestigation`'s
  `JSON.parse(JSON.stringify(...))` relies on elsewhere, not a coercion.
  `progress`/`error`/`startedAt`/`completedAt` stay genuine SQL `NULL` and
  round-trip as `null`, never defaulted — the same "null means not measured"
  discipline as everywhere else in this project, verified by tests written
  specifically to check it.
- Wired in behind config, matching `llm.ts`'s `LLM_BASE_URL` philosophy
  exactly: `jobs.ts`'s `createJobStore()` reads `JOB_STORE_PATH` — unset (the
  default) keeps the original in-memory behavior with zero change; set to a
  file path, `jobStore` becomes a `SqliteJobStore` pointed at it, with no
  other code anywhere touched, since every function only ever depended on the
  `JobStore` interface, never a concrete class. Manually verified both paths
  directly against the real singleton (not just the class in isolation):
  `JOB_STORE_PATH` unset → `jobStore.constructor.name === "InMemoryJobStore"`;
  set → `"SqliteJobStore"`, and a real investigation created through it was
  immediately visible via `hasInvestigation()`.
- 16 new tests, including the one that actually proves the point: data
  written by one `SqliteJobStore` instance, closed, is read correctly by a
  *second* instance opened fresh against the same file path — this is
  literally what "survives a scale-to-zero cold start" means, and a test
  that only used one instance throughout would not have proven it.
- PostgreSQL for production (plan §16's stated preference) is not
  attempted — no database service exists in this deployment to point it at.

**Environment configuration**: `.env.example` — did not exist anywhere in
the repo despite several environment variables already being load-bearing.
Built from a real audit of every `process.env.*`/`process.env[...]` read
across `src/` (`llm.ts`'s dynamic `${prefix}_BASE_URL`/`${prefix}_MODEL`
construction needed checking by hand, not just a literal grep) and cross-
checked against `credential-vault.ts`'s `CREDENTIAL_PROVIDERS` registry,
which is the authoritative list of every credential this app can use, each
with its real env var name already documented there. Every value in the
file is empty — this documents names and what each unlocks, never a
plausible-looking placeholder secret. `.env`/`.env.*` were already
gitignored; added a `!.env.example` negation so the template itself doesn't
get swallowed by that same rule, and confirmed with `git check-ignore`/
`git status` that it now shows as trackable. Also added a `data/jobs.sqlite*`
gitignore entry (covering SQLite's `-wal`/`-shm` companion files, confirmed
they're actually created) for the new optional local store, matching
`credential-vault.ts`'s existing `data/`-file gitignore convention.

**Full suite:** 864/864 passing (16 new), `tsc --noEmit` clean, 151 core
exports unchanged, `fabrication-check` unchanged at 81, lint clean on every
touched/new file with zero new findings.

------------------------------------------------------------------------

# 22. Unified Investigation UI

Add a small extension to the existing UI.

Conceptually:

``` text
Target
[ John Smith ]

Optional fields
[ City ]
[ Email ]
[ Username ]
[ Domain ]

[ Start Investigation ]

Collectors
[x] Search
[x] Social
[x] News
[x] DNS
[x] crt.sh
[x] Shodan InternetDB
[ ] theHarvester
[ ] SpiderFoot
```

The UI should not expose internal implementation complexity to ordinary
users.

------------------------------------------------------------------------

# 23. Collector Health

Create:

``` text
collector-health.ts
```

or extend the existing collector-health utility.

Show:

``` text
DNS                 READY
RDAP                READY
crt.sh              READY
Shodan InternetDB   READY
theHarvester         READY
SpiderFoot           OFFLINE
```

If an external tool is unavailable:

``` text
SpiderFoot unavailable
Other collectors will continue.
```

This makes the application robust.

------------------------------------------------------------------------

# 24. Free Resource Policy

The core system must work without paid APIs.

## Always available/core

``` text
DNS
RDAP
crt.sh
Shodan InternetDB
Google Dork generation
RSS/public news
Existing Sentinel collectors
```

## Optional

``` text
theHarvester
SpiderFoot
Nmap
GDELT/API providers
```

## Never required

``` text
Full Shodan paid API
Paid people-search databases
Paid scraping services
Paid proxy services
Commercial breach databases
```

------------------------------------------------------------------------

# 25. Maltego Strategy

Priority: **P3**

Do not integrate Maltego first.

First make Sentinel's graph complete.

Later support:

``` text
Sentinel graph
    |
    v
JSON/CSV/graph export
    |
    v
Maltego-compatible workflow
```

Do not make Maltego a runtime dependency.

------------------------------------------------------------------------

# 26. Nmap Strategy

Priority: **P2/P3**

Only implement for authorized targets.

Do not automatically scan arbitrary IP addresses supplied by users.

If implemented:

``` text
Authorized target
      |
      v
Nmap worker
      |
      v
Open ports/services
      |
      v
Infrastructure entities
```

Keep it disabled by default unless authorization is established.

------------------------------------------------------------------------

# 27. Social Media Strategy

Do not promise unrestricted access to Instagram, Facebook, X/Twitter or
Telegram.

Use:

``` text
public-source discovery
public profile references
permitted APIs
existing Sentinel collectors
```

Results should say:

``` text
Possible public account
```

when identity is not independently verified.

Do not bypass:

-   authentication
-   privacy controls
-   rate limits
-   platform access restrictions

------------------------------------------------------------------------

# 28. Age/Phone Strategy

Age:

Use only publicly stated or sourced information.

Possible evidence:

``` text
public article
public profile
public biography
public document
```

Do not estimate exact age from a photograph.

Phone:

Use only authorized/public sources.

Do not implement private-data lookup systems as part of the free OSINT
project.

------------------------------------------------------------------------

# 29. Claude Code Workflow

Claude Code must be used in small bounded tasks.

## Prompt pattern

Each task should contain:

``` text
OBJECTIVE
FILES ALLOWED
FILES FORBIDDEN
CURRENT BEHAVIOR TO PRESERVE
IMPLEMENTATION REQUIREMENTS
TEST REQUIREMENTS
STOP CONDITION
```

Example:

``` text
OBJECTIVE:
Create the generic OSINT collector interface.

FILES:
Only create:
src/utils/collectors/*

DO NOT MODIFY:
existing routes
existing collectors
existing UI

REQUIREMENTS:
...
TEST:
bun test
tsc --noEmit

STOP:
Do not implement SpiderFoot or theHarvester.
```

This prevents uncontrolled refactoring.

------------------------------------------------------------------------

# 30. Antigravity Workflow

Use Antigravity primarily for:

-   browser testing
-   UI verification
-   investigation flow testing
-   regression checking
-   visual review
-   responsive behavior

Do not use it to make large architectural changes.

Recommended loop:

``` text
Claude Code
   |
   v
Backend implementation
   |
   v
Tests
   |
   v
Antigravity
   |
   v
Browser verification
   |
   v
Claude Code fixes
```

------------------------------------------------------------------------

# 31. Claude Code Task Order

Claude Code should execute tasks in this exact order.

## P0 --- Baseline

``` text
[x] Run existing tests            (653/653 pass, 2026-08-14)
[x] Run TypeScript check          (tsc --noEmit clean, 2026-08-14)
[x] Run export check              (151 exports verified, 2026-08-14)
[x] Run fabrication check         (FAILED at baseline: 81 pre-existing matches
                                    across 12 files, none in src/utils/collectors/.
                                    Inherited debt, out of scope for this phase —
                                    see the note at the end of this section.)
[x] Record baseline
```

**Fabrication-check baseline note (2026-08-14).** `bun scripts/fabrication-check.ts`
does not currently pass on `main`: 1 timestamp-invention, 35 string-literal-as-measurement
and 45 numeric-zero-flattening matches, spread across `src/utils/geo.ts`,
`imaging-client.ts`, `imaging.ts`, `investigations-store.ts`, `llm.ts`, `radiation.ts`,
`report-pdf.ts`, `social-credibility.ts`, `social-velocity.ts`, `social.ts`,
`youtube-collector.ts` and `routes/images.tsx`. This was true before any OSINT-plan work
started — it is not a regression introduced here. Fixing it is a separate, unrelated
cleanup task (most matches are likely loop accumulators/sort comparators the checker's
regex cannot distinguish from a real fabrication, per CLAUDE.md's own caveat that those
are fine — but each one needs to be read, not assumed). Every file added for P0 below was
checked and is clean against all three patterns.

## P0 --- Architecture

``` text
[x] Collector types                (src/utils/collectors/types.ts, 2026-08-14)
[x] InvestigationResult             (src/utils/collectors/result.ts, 2026-08-14)
[x] Collector registry              (src/utils/collectors/registry.ts, 2026-08-14)
[x] Collector errors                (src/utils/collectors/errors.ts, 2026-08-14)
[x] Collector execution metadata    (CollectorExecutionMeta in result.ts, 2026-08-14)
```

No collector adapters are registered yet — `registry.ts` exports an empty
`collectorRegistry`. Wiring the existing dorks/DNS/RDAP/crt.sh/Shodan/news/social
utilities into adapters that implement this contract is P1 ("Existing adapters"),
deliberately not started in this pass per Rule 3 (one architectural layer at a time).

## P1 --- Existing adapters

``` text
[x] Dork adapter               (src/utils/collectors/existing/dorks.ts, 2026-08-14)
[x] DNS adapter                (src/utils/collectors/existing/dns.ts, 2026-08-14)
[x] RDAP adapter               (src/utils/collectors/existing/rdap.ts, 2026-08-14)
[x] crt.sh adapter             (src/utils/collectors/existing/crtsh.ts, 2026-08-14)
[x] Shodan InternetDB adapter  (src/utils/collectors/existing/shodan-internetdb.ts, 2026-08-14)
[x] News adapter               (src/utils/collectors/existing/news.ts, 2026-08-14)
[x] Social adapter             (src/utils/collectors/existing/social.ts, 2026-08-14)
```

**What each wraps, and two P0-contract fixes made while building these.**

Six of seven wrap an existing exported function verbatim: crt.sh →
`collectCrtShSubdomains` (`recon-sources.ts`), DNS/Shodan InternetDB →
`resolveA`/`internetDb` (`attack-surface.ts`, additively exported — no
behavior change, `lookupAttackSurface` itself is untouched), Dorks →
`fetchNewsDorkHits` (extracted from `dorks.ts`'s `runNewsDork` the same way
`llm.ts` separates core logic from its `createServerFn` wrapper — again no
behavior change), News → `collectNewsGeo` (`geo-sources.ts`, chosen over
re-querying Google News RSS because it returns geo-tagged records), Social →
`fetchAuthorFeed`/`fetchTelegramChannel`/`fetchRedditSearch` (`social.ts`).

**RDAP is the one exception** — the project's only existing RDAP lookup
lives inline inside `routes/news.tsx`'s `fetchOSINT` handler, the same
un-exported, route-coupled anti-pattern crt.sh had before its own
extraction. Extracting it would mean editing a route file, which this pass
deliberately avoided (Rule 4). `existing/rdap.ts` instead queries the same
free `rdap.org` endpoint that route already validated, using the same
field-extraction approach — a second, independently-testable implementation
of the identical technique, not a novel one. `routes/news.tsx`'s WHOIS tab
is untouched.

**Two real defects in the P0 contract, found only by actually building
against it — fixed before any adapter code, not patched around per-adapter:**
1. `Collector.normalize()` originally took `raw: TRaw` alone, but
   `InvestigationResult.execution` (§8) has to come from somewhere, and only
   `execute()` computes it. Changed to `normalize(outcome: CollectorRunOutcome<TRaw>)`.
2. Every adapter needs the same "raw is null → empty result carrying the
   error" first step (Rule 5). Extracted once as `normalizeGuard()` in the
   new `existing/shared.ts`, alongside `startExecution`/`finishExecution`/`classifyError`.

**Modeling decisions worth a human sanity-check, not silently assumed
correct:** crt.sh's parent→subdomain edge uses `OWNS_DOMAIN` (closest fit in
§19's fixed vocabulary — read as "the domain's CT log encompasses this
hostname", not literal ownership); Shodan's ports/CPEs/vulns are kept as
IP-entity metadata rather than forcing them into `HAS_PORT` against a
nonexistent "service" entity type; Reddit search hits in the Social adapter
deliberately do NOT produce a `social_account` entity or `USES_USERNAME`
edge (unlike Bluesky/Telegram, which are direct handle/channel lookups) —
per §18, a search-term match is not an identity claim.

**Verified:** 47 new tests across 7 files (`tests/collectors-existing-*.test.ts`,
all passing); full suite 731/731; `tsc --noEmit` clean; `check-exports`
clean; `fabrication-check` unchanged at the pre-existing 81 (zero new
matches). crt.sh/DNS/Shodan/RDAP/News adapters are tested against both
`execute()`'s live-fetch path (via `globalThis.fetch` stubbing, this
project's existing convention — see `tests/recon.test.ts`) and
`normalize()`. Dorks and Social are tested at the validation-path and
`normalize()` level only: Dorks' network path goes through `rss-parser`,
which uses Node's `http`/`https` directly rather than global `fetch`
(confirmed by reading `node_modules/rss-parser/lib/parser.js`), and Social's
Reddit path already has dedicated OAuth/retry test coverage in
`tests/social-reddit.test.ts` that re-mocking here would only duplicate —
documented in each test file's own header rather than silently left thin.

**Not done:** adapters are not registered into `collectorRegistry` by
default (`registerExistingCollectors()` in `existing/index.ts` does it on
request) — auto-registering on import would make the registry
non-deterministic across test files that import adapters independently.
Wiring happens when the orchestrator (next, below) actually needs it.

## P1 --- Orchestrator

``` text
[x] Target detection    (src/utils/osint/query-planner.ts detectTargetType(), 2026-08-14)
[x] Query planner        (planInvestigation(), 2026-08-14)
[x] Collector selection  (registry.findByTargetType() per candidate type)
[x] Execution            (src/utils/osint/orchestrator.ts runInvestigation(), 2026-08-14)
[x] Normalization        (delegated to each collector's own normalize() — no separate step needed)
[x] Deduplication        (exact-id only — see the note below, this is NOT §17 entity resolution)
```

**Scope actually built, and what's deliberately still missing.** `runInvestigation()`
runs every planned collector synchronously in one call (`Promise.all`, no queue) and
merges their `InvestigationResult`s. Its "Deduplication" is exact-id dedup only: it
removes an entity appearing twice under the literal same id (e.g. matched via two
candidate target types), but does **not** merge `dns:domain:example.com` and
`rdap:domain:example.com` into one entity even though both name the same real
domain — each collector mints its own namespaced id, and cross-collector semantic
merging is exactly what the separate, not-yet-built "Entity correlation" task below
(§17) exists to do. Evidence is never deduplicated at all — every source's fact
stays independently inspectable per Rule 6, even when two collectors report the
same value. Collectors are not auto-registered: a caller against the global
registry must call `registerExistingCollectors()` first — `runInvestigation()`
deliberately doesn't do this itself, so a test (or future caller) supplying its own
isolated registry never gets real network-calling adapters silently added to it.

**Target detection** is a precedence-ordered regex classifier (IP → URL → email →
domain → phone → ambiguous bare word → ambiguous free text), returning a primary
type plus alternates for genuinely ambiguous input (a bare word is both a plausible
`username` and a plausible `person` mononym) rather than guessing a single type.
Phone-shaped input currently plans zero collectors — correct, not a bug: no P1
collector declares `phone` support, consistent with §28's "do not implement
private-data lookup systems."

**Verified:** 22 new tests (`tests/osint-query-planner.test.ts`,
`tests/osint-orchestrator.test.ts`) against isolated `CollectorRegistry` instances
with hand-built stub collectors — no real network call in either file, so this
can't regress into a slow or flaky suite by quietly hitting crt.sh/Shodan/GDELT.
Full suite 753/753 passing, `tsc --noEmit` clean, `fabrication-check` unchanged at
the pre-existing 81.

**Not done:** the Job system (§12 — everything above runs in-process with no queue,
polling or independent timeout), theHarvester/SpiderFoot workers, entity resolution
(§17), and any UI/route wiring (nothing calls `runInvestigation()` from a route or
server function yet).

## P1 --- Jobs

``` text
[x] Job model       (InvestigationJob, src/utils/osint/jobs.ts, 2026-08-14)
[x] Job status       (reuses the same 6-value ExecutionStatus vocabulary result.ts already defines)
[x] Start job         (startInvestigation() — plans, creates one job per collector, fires each without awaiting)
[x] Poll job           (pollInvestigation() — aggregates done jobs' entities/relationships/evidence)
[x] Timeout             (outer safety-net timeout, independent of a collector's own internal timeout; injectable for tests)
[x] Failure handling      (a hung/erroring collector fails the job with a real reason, never a silent empty result)
```

**What this is and isn't.** `jobs.ts` is the async, pollable sibling of `orchestrator.ts`'s
`runInvestigation()` — same query planner, same collector registry, same `./merge.ts` dedup,
different execution shape: `startInvestigation()` returns immediately with an id instead of
blocking until every collector finishes. Matches §12's sketched API (`POST /investigation` →
id, `GET /investigation/:id` → state) as plain functions; **neither is wired to an actual
route yet** — no UI or server function calls either one (that's P2).

Three deliberate, documented limits, not silent gaps:
1. **Persistence is in-memory only**, same acknowledged limitation as `llm.ts`'s response
   cache ("fine for a demo, needs Redis for real use") — a job would not survive a
   scale-to-zero cold start between `POST` and the next `GET`. §16's SQLite/PostgreSQL
   direction is a real infrastructure decision, not bundled into this task.
2. **"queued" is real but near-instant** for P1's built-in collectors — they run in-process
   with nothing to hand off to, so a job reaches "running" essentially synchronously. A
   genuine queue with backpressure only matters once theHarvester/SpiderFoot (external
   worker processes) exist.
3. **Cancellation cannot abort an in-flight request.** `Collector.execute()` (the P0
   contract) takes no `AbortSignal`. `cancelJob()` marks a job cancelled and
   `pollInvestigation()` stops reporting its result, but the underlying fetch a cancelled
   job was running still completes in the background with its result discarded — verified
   by a test (`tests/osint-jobs.test.ts`). Real cancellation needs an `AbortSignal` threaded
   through the collector contract, a P0 change not made here.

**Verified:** 9 new tests, including the cancellation-discards-late-result behavior and the
timeout path (an injectable timeout budget makes this fast — no test waits on the real
60-second default), run 3× to confirm no timing flakiness. Full suite 762/762 passing, `tsc
--noEmit` clean, `fabrication-check` unchanged at 81.

## P1 --- theHarvester

``` text
[ ] Worker           (NOT built — see the note below; genuinely out of scope this pass)
[x] Adapter          (src/utils/collectors/external/theharvester.ts, 2026-08-14)
[x] JSON parser        (asStringArray/parseHostEntry — defensive, degrades to "not reported" on an unexpected shape)
[x] Normalizer          (emails → HAS_EMAIL, hosts → domain(+ip via RESOLVES_TO), urls → url entities)
[x] Evidence               (every finding carries source/collector/collectedAt)
[x] Tests                    (14 tests, fetch-stubbed — no real theHarvester or worker)
```

**Read this before trusting "theHarvester" as a checked-off capability.** Only the
*adapter* — the Sentinel-side client — is built. The worker it calls
(`THEHARVESTER_WORKER_URL`, a small HTTP wrapper around the theHarvester CLI that
would need its own Dockerfile and a host to run it on) does **not exist** in this
deployment. `theHarvesterCollector.execute()` reports `unavailable` today, for
real, because nothing is configured — this is the honest current state, not a
placeholder. Standing up that worker is real infrastructure work, deliberately not
attempted here.

**Why this doesn't reopen the licensing question `recon-sources.ts`'s `RECON_NOTES`
already settled.** That note objects to *subprocessing the GPL-licensed
theHarvester binary inside Sentinel's own process* — a real licensing/linking
concern, plus the container has no persistent process to run a subprocess in
between requests anyway. This adapter does neither: it only makes an HTTP call to
an independently-deployed worker, the exact architecture plan §15 already
describes and the same pattern `ai-service/` established this session (separate
service, called over HTTP, versioned independently). `RECON_NOTES` is unmodified
and still accurately describes the deployed reality.

**JSON shape is unverified against a live instance.** The parser targets
theHarvester's own documented `-f json` export format from training-time
knowledge, not a real worker's output — there is no live worker to check field
names against. It's written defensively (unexpected/missing fields degrade to "not
reported," never thrown or fabricated), but the exact shape should be reverified
before this is trusted with real data. Recorded here rather than left implicit.

Uses the plan's own "Recommended first sources" (crt.sh, CertSpotter) as the
default, explicitly not `-b all`.

## P1 --- SpiderFoot

``` text
[ ] Worker           (NOT built — a real SpiderFoot instance needs its own long-running host; out of scope this pass)
[x] Adapter          (src/utils/collectors/external/spiderfoot.ts, 2026-08-14)
[x] Job integration    (fits the existing job system unchanged — see the note below on what "integration" means here)
[x] JSON parser          (start/poll/fetch against SpiderFoot's own documented HTTP API — unverified live, see the note)
[x] Normalizer             (partial event-type → entity map; unmapped types stay evidence-only, never dropped)
[x] Evidence                  (every event carries source/collector/collectedAt, mapped or not)
[x] Tests                       (13 tests, fetch-stubbed, run 3× to confirm no polling-loop flakiness)
```

**Same "adapter exists, worker doesn't" status as theHarvester** — see that section
just above for the full reasoning (this doesn't reopen `RECON_NOTES`'s SpiderFoot
entry either, for the identical reason: an HTTP call to an independent process is
not "hosting SpiderFoot"). `SPIDERFOOT_WORKER_URL` is unset by default;
`spiderFootCollector.execute()` reports `unavailable`, honestly, today.

**"Worker" here is a real SpiderFoot instance, not custom glue code** — unlike
theHarvester (a CLI needing a wrapper built), SpiderFoot ships its own web server
(`sf.py -l host:port`) with scan-control and JSON-result endpoints, so
`SPIDERFOOT_WORKER_URL` is meant to point directly at that.

**What makes this collector different from every other one in the codebase: real
scans take minutes, not seconds.** `execute()` starts a scan, then polls
SpiderFoot's own status endpoint (`SPIDERFOOT_POLL_INTERVAL_MS`, default 5s) until
`FINISHED`/`ERROR-*` or its own bounded wait (`SPIDERFOOT_MAX_WAIT_MS`, default 2
minutes) elapses. That 2-minute budget is a documented simplification, not a
hidden one — real non-passive scans can run considerably longer. A production
integration would more likely need the scan to survive across multiple job-system
polls rather than block one `execute()` call; that deeper decoupling is not built.
This is what "Job integration" means as checked off here: the collector fits the
*existing* job system (`jobs.ts`) exactly as built (its outer `JOB_TIMEOUT_MS`
already wraps a slow `execute()` the same as any other), not that a SpiderFoot-
specific job extension was added.

**Defaults to SpiderFoot's "passive" use-case**, never an active/intrusive scan
profile, matching this project's passive-only stance elsewhere and §26's Nmap
caution about needing explicit authorization for anything active.

**API shape is unverified against a live instance**, same caveat and same reason
as theHarvester's — `/startscan`, `/scanstatus`, `/scaneventresults`, the event
JSON's field names and the `usecase` param are from training-time knowledge, not a
checked live response. Reverify before trusting this with real data.

Event-type → entity mapping deliberately covers only a defensible subset
(SpiderFoot emits several hundred event types; most have no honest fit in §19's
fixed entity vocabulary) — an unmapped type still becomes evidence, listed by name
in a warning, never silently dropped.

## P1 --- Entity correlation

``` text
[x] Entity normalization  (src/utils/osint/entity-resolution.ts, 2026-08-14 — per-type: email/domain/username/url get a real rule, everything else trim+lowercase)
[x] Deduplication          (exact-value merge across collectors, e.g. dns:domain:x + rdap:domain:x + crtsh:domain:x → one entity — the merge orchestrator.ts/jobs.ts explicitly deferred to this file)
[x] Relationship creation    (relationship endpoints rewritten to merged ids; a resulting self-loop is dropped, not kept as a meaningless edge; re-dedup via the shared ./merge.ts)
[x] Confidence                 (plan §18: scores only on "multiple independent sources," always with reasons — never a bare number)
```

**This closes out everything in plan §31's P1 list** except the two items §31 itself
scopes elsewhere (Job model persistence — §16, a separate infrastructure decision;
theHarvester/SpiderFoot *workers* — real hosts, not this codebase's job). Every P1
*code* item — collector contract, existing adapters, orchestrator, job system,
theHarvester/SpiderFoot clients, entity resolution — is built and tested.

**§18's rule enforced structurally, not just followed as advice: "Do not infer
identity merely from a matching name."** `person` and `organization` entities are
**never merged by value equality here, at all** — not merged-with-a-low-confidence-
score, genuinely kept as separate entities via `NOT_MERGEABLE_BY_VALUE`. Two
different real "John Smith"s stay two entities. This is a stronger reading of §18
than "score it low": a low score attached to an already-merged entity is a weaker
safeguard than not merging in the first place, since the merge itself — one row
instead of two — is the part a reader skims past a caveat on. Everything else
(email, domain, ip, url, username, phone, location, article, image, video,
social_account) merges on exact value after type-specific normalization, because
those are precise identifiers, not fuzzy names — a materially different kind of
match than the one §18 warns about.

**Deliberately NOT wired into `orchestrator.ts`/`jobs.ts` automatically** — both
stay exact-id-only, exactly as their own headers already said. Call
`resolveInvestigationEntities()` on the result of `runInvestigation()`/
`pollInvestigation()` when semantic merging is wanted; nothing forces it, and
nothing in the existing orchestration code needed to change.

**Confidence is honestly narrow.** The only signal this file can compute is
"multiple independent sources" (one of §18's own listed signals) — it has no
access to the richer cross-entity-type correlation §18's worked example shows
("same organization" + "same location" + "matching username" as SEPARATE
corroborating facts about one person). Building that would mean correlating
different entities about the same subject, a larger task than merging same-type
same-value entities; not attempted here, and not implied by the checked box above.

**Verified:** 19 new tests, including the exact plan §17 worked example (three
collectors reporting the same email → one entity, three evidence items via the
untouched evidence array) and the person/organization non-merge guarantee. Found
and fixed one real bug while writing tests: `normalizeUrl("https://example.com/")`
was returning `https://example.com/` instead of `https://example.com` — the
trailing-slash strip had an off-by-one guard (`pathname.length > 1`) that
protected exactly the root-path case it was meant to also cover. Full suite
808/808 passing, `tsc --noEmit` clean, `fabrication-check` unchanged at 81.

## P2 --- UI

``` text
[x] Recon collector selection  (2026-08-14 — checkbox preview, checked by default, see §21d)
[x] Investigation start        (2026-08-14 — "Run Investigation" on /recon, see §21a)
[x] Progress                   (2026-08-14 — live per-collector status via job polling, see §21b)
[x] Collector status           (2026-08-14 — per-collector queued/running/completed/failed + reason badges, live-updating)
[x] Results                    (2026-08-14 — entity list with type + confidence, live-updating, capped at 200 rendered)
[x] Evidence                   (2026-08-14 — per-item inspector, collapsible, capped at 200 rendered, see §21c)
[x] Graph                      (2026-08-14 — real BFS-ring layout from an investigation snapshot, see §21e)
```

Every P2-UI checklist item is now done. See §21a/§21b/§21c/§21d/§21e for what
actually landed, the two real "built but unreachable" bugs browser-testing
caught (theHarvester/SpiderFoot never registered; the whole job system never
called), the real 3,461-entity scale
finding from testing against an actual large target, and all five live
verification runs.

## P2 --- Reports

``` text
[x] Include external collector results  (2026-08-14 — sourcesFromOsintEvidence covers every collector, external tools included, see §21f)
[x] Include evidence                    (2026-08-14 — same function; see §21f)
[x] Include relationships               (2026-08-14 — sourcesFromOsintRelationships, see §21f)
[x] Include timeline                    (2026-08-14 — EVENT_TIMELINE already sorts by publishedAt; OSINT evidence's real collectedAt slots in with no new code, see §21f)
```

Every P2-Reports item is now done. See §21f for what actually landed, the
real HTTP-413-shaped budget bug browser-testing caught before it shipped, and
the live verification run.

## P2 --- Deployment

``` text
[ ] Worker Dockerfile        (blocked — no worker exists to containerize, no Docker in this environment; see §21g)
[ ] Local docker-compose     (blocked — same reason)
[x] Environment configuration (2026-08-14 — .env.example, every real env var audited from source, see §21g)
[ ] Health checks            (not attempted — ambiguous scope; collector-health.ts already covers most non-OSINT sources for /crawlers, a deployment liveness endpoint is a different thing this TanStack Start version can't easily expose as JSON, see §21g)
[x] Persistent job storage    (2026-08-14 — SqliteJobStore, config-driven via JOB_STORE_PATH, see §21g)
[ ] Azure configuration      (blocked — touches real subscription resources, not attempted blind; see §21g)
```

Two of six done — see §21g for what actually landed and why the other four
were explicitly deferred rather than guessed at.

## P3 --- Optional

``` text
[ ] Nmap
[ ] Maltego export
[ ] Full Shodan API
[ ] More social providers
[ ] Continuous monitoring
```

------------------------------------------------------------------------

# 32. Definition of Done

The project is not finished when the tools execute.

It is finished when this workflow works:

``` text
User enters target
      |
      v
Sentinel detects target type
      |
      v
Query planner selects collectors
      |
      v
Collectors execute
      |
      v
Results are normalized
      |
      v
Duplicates are merged
      |
      v
Evidence is stored
      |
      v
Relationships are created
      |
      v
Graph updates
      |
      v
User sees results
      |
      v
User can inspect evidence
      |
      v
User can generate report
```

And:

``` text
SpiderFoot unavailable
      |
      v
Sentinel continues

theHarvester unavailable
      |
      v
Sentinel continues

Shodan unavailable
      |
      v
Other infrastructure collectors continue
```

------------------------------------------------------------------------

# 33. Regression Definition of Done

Every feature must finish with:

``` text
bun test
tsc --noEmit
bun scripts/check-exports.ts
bun scripts/fabrication-check.ts
```

and:

``` text
No existing route broken
No existing collector removed
No existing UI replaced unnecessarily
No credentials committed
No secrets in source
No external tool required for Sentinel startup
```

------------------------------------------------------------------------

# 34. Recommended Git Commit Strategy

Use small commits.

``` text
feat(osint): add collector contract
feat(osint): add collector registry
feat(osint): adapt existing dns collector
feat(osint): adapt crtsh collector
feat(osint): adapt shodan internetdb collector
feat(osint): add investigation orchestrator
feat(osint): add job model
feat(osint): add theharvester worker
feat(osint): add spiderfoot worker
feat(osint): add entity resolution
feat(osint): integrate evidence
feat(recon): add collector controls
feat(graph): integrate osint relationships
feat(reports): include osint evidence
```

Avoid:

``` text
feat: massive osint changes
```

------------------------------------------------------------------------

# 35. Master Progress Tracker

Update this section after every successful implementation.

## P0 Foundation

-   [x] Baseline tests recorded (2026-08-14 — see §31 P0 Baseline for detail,
    including the pre-existing fabrication-check failure that is out of scope here)
-   [x] Collector contract implemented (`src/utils/collectors/types.ts`)
-   [x] Common result model implemented (`src/utils/collectors/result.ts`, zod-validated)
-   [x] Registry implemented (`src/utils/collectors/registry.ts`, empty — no adapters registered yet)
-   [x] Error model implemented (`src/utils/collectors/errors.ts`)

31 new tests added (`tests/collectors-result.test.ts`, `tests/collectors-registry.test.ts`,
`tests/collectors-errors.test.ts`); full suite at 684/684 passing, `tsc --noEmit` clean,
export check clean. Nothing outside `src/utils/collectors/` and `tests/collectors-*.test.ts`
was touched — no existing route, collector, or UI changed.

## P1 Existing Collectors

-   [x] Dorks (2026-08-14 — `src/utils/collectors/existing/dorks.ts`)
-   [x] DNS (2026-08-14 — `src/utils/collectors/existing/dns.ts`)
-   [x] RDAP (2026-08-14 — `src/utils/collectors/existing/rdap.ts`, new implementation against the same free endpoint; see §31 P1 note)
-   [x] crt.sh (2026-08-14 — `src/utils/collectors/existing/crtsh.ts`)
-   [x] Shodan InternetDB (2026-08-14 — `src/utils/collectors/existing/shodan-internetdb.ts`)
-   [x] News (2026-08-14 — `src/utils/collectors/existing/news.ts`)
-   [x] Social (2026-08-14 — `src/utils/collectors/existing/social.ts`)

Not yet registered into `collectorRegistry` by default — see §31 P1 note.
47 new tests, full suite 731/731, `tsc --noEmit` clean, `fabrication-check`
unchanged at 81 pre-existing (zero new).

## P1 Orchestration

-   [x] Target detection (2026-08-14 — `src/utils/osint/query-planner.ts`)
-   [x] Query planner (2026-08-14)
-   [x] Collector selection (2026-08-14)
-   [x] Job model (2026-08-14 — `src/utils/osint/jobs.ts`)
-   [x] Job execution (2026-08-14 — `startInvestigation()`, in-memory, per-process)
-   [x] Status tracking (2026-08-14 — `pollInvestigation()`)
-   [x] Timeout handling (2026-08-14 — injectable outer timeout, independent of each collector's own)
-   [x] Failure handling (2026-08-14)

Execution + basic (exact-id only) deduplication also done — see §31 P1
Orchestrator note for exactly what "deduplication" does and doesn't mean here.
Job persistence is in-memory only (§16's SQLite/PostgreSQL direction not
started — a separate infrastructure decision), and cancellation cannot abort
an in-flight collector request (no `AbortSignal` in the P0 contract) — both
documented in `jobs.ts` and covered by tests, not silent gaps. Nothing routes
to either `runInvestigation()` or `startInvestigation()`/`pollInvestigation()`
yet — no UI wiring exists (P2).

## P1 External Tools

-   [ ] theHarvester worker (not built — real infra, out of scope; see §31 P1 theHarvester note)
-   [x] theHarvester parser (2026-08-14 — unverified against a live worker, see the note)
-   [x] theHarvester normalization (2026-08-14)
-   [ ] SpiderFoot worker (not built — real infra, out of scope; see §31 P1 SpiderFoot note)
-   [x] SpiderFoot parser (2026-08-14 — unverified against a live instance, see the note)
-   [x] SpiderFoot normalization (2026-08-14)

theHarvester adapter (`src/utils/collectors/external/theharvester.ts`) is built
and tested (14 tests, fetch-stubbed) but reports `unavailable` in every real
environment today, honestly, because no worker is deployed — this is not a
gap hidden by a checked box. SpiderFoot adapter
(`src/utils/collectors/external/spiderfoot.ts`) is in the identical state (13
tests) — the one collector in the codebase whose `execute()` polls a
long-running external process rather than making one request.

## P1 Intelligence

-   [x] Entity normalization (2026-08-14 — `src/utils/osint/entity-resolution.ts`)
-   [x] Deduplication (2026-08-14 — exact-value merge, person/organization excluded on purpose)
-   [x] Relationship builder (2026-08-14 — endpoint remapping + self-loop drop + re-dedup)
-   [x] Confidence scoring (2026-08-14 — "multiple independent sources" only, always with reasons)
-   [x] Evidence integration (never touched by this file — every source's fact stays independently inspectable; this was true of every collector already, entity resolution doesn't change it)
-   [x] Graph integration (2026-08-14 — `/graph` renders `pollInvestigation()`'s raw, id-deduped entities/relationships, not `resolveInvestigationEntities()`'s value-merged output; see §21e's live-verification note for the one visible consequence — two collectors independently reporting the same domain value currently render as two nodes)

This is the last item in plan §31's P1 list. Opt-in via `resolveInvestigationEntities()`,
not wired automatically into `runInvestigation()`/`pollInvestigation()` — see §31 P1
Entity correlation note for why. P1 is otherwise complete: P0 foundation, all 7
existing-collector adapters, orchestrator, job system, theHarvester/SpiderFoot
clients (both real, neither has a deployed worker), and now entity resolution.
Everything left across the whole plan is P2 (UI, persistence, deployment) and P3
(optional extras) — see §31.

## P2 UI

-   [x] Unified investigation input (2026-08-14 — reuses `/recon`'s existing target field; new "Run Investigation" panel, see §21a)
-   [x] Collector selection (2026-08-14 — checkbox preview per candidate collector, checked by default, see §21d)
-   [x] Job progress (2026-08-14 — live per-collector status via `jobs.ts` polling, see §21b)
-   [x] Results (2026-08-14 — entities, type + confidence, live-updating, capped at 200 rendered)
-   [x] Evidence (2026-08-14 — per-item inspector: collector, timestamp, source, confidence, normalized value, link; see §21c)
-   [x] Graph navigation (2026-08-14 — "View in Graph" hand-off from `/recon`, real BFS-ring layout replacing the fixed 10-node fixture, see §21e)
-   [x] Report generation (2026-08-14 — "Include OSINT investigation" on `/reports`, appends real collector evidence/relationships as citable sources, see §21f)

Every item in this block is now done.

**Two real bugs found by browser-testing this, not just `tsc`/`bun test`:**
(1) theHarvester and SpiderFoot were built and fully unit-tested but never
registered anywhere, so they could never be selected — fixed by adding
`collectors/external/index.ts` (mirroring `existing/index.ts`). (2) The whole
`jobs.ts` job-polling system was built and fully unit-tested in P1 but had zero
callers anywhere in the app — fixed by adding `startOsintInvestigationJob`/
`pollOsintInvestigationJob` and switching the panel to poll them. Both are the
same shape of bug: passing tests prove a unit works in isolation, not that
anything can reach it. **One real scale finding**: `cloudflare.com` returned
3,461 entities (real crt.sh subdomains, not a bug) — rendering all of them
uncapped is a genuine UX problem only an actual large target would surface;
capped display at 200 items, UI layer only. **Manual selection verified
end-to-end**: deselecting 2 of 8 collectors before running produced a live
status list showing exactly the 6 selected — the filter reaches execution, not
just checkbox state. **Graph navigation verified end-to-end**: empty state
before any investigation, real BFS-ring layout with real `RESOLVES_TO` edges
after "View in Graph," real node-detail data, real BFS shortest-path panel,
working filter — see §21e. **Report generation verified end-to-end**, and one
real bug caught before it shipped: appending OSINT sources initially bypassed
the existing token-budget trim, reproducing the exact HTTP-413 failure mode
already documented above for news/geo collection (`71 of 71 included`, no
trim applied) — fixed by computing remaining budget from the analyst's prior
selections before appending, confirmed live afterward (`12 of 82 included`,
correctly trimmed); real, honestly-surfaced collector failures (crt.sh 502,
GDELT 429, theHarvester/SpiderFoot unconfigured) rendered on screen rather
than swallowed; Generate correctly showed the pre-existing honest
"No LLM provider configured" message with no LLM configured in this
environment, rather than hanging — see §21f. See §21a/§21b/§21c/§21d/§21e/§21f
for detail and all six live verification runs against real free APIs.

## P2 Production

-   [x] Persistent job storage (2026-08-14 — `SqliteJobStore`, config-driven via `JOB_STORE_PATH`, in-memory unchanged by default, see §21g)
-   [ ] Worker Docker image (blocked — theHarvester/SpiderFoot have no deployed worker to containerize, and there is no Docker in this environment to build or verify one against)
-   [ ] Local Docker compose (blocked — same reason)
-   [x] Environment configuration (2026-08-14 — `.env.example`, every real env var audited from source and cross-checked against `credential-vault.ts`, see §21g)
-   [ ] Health checks (not attempted — ambiguous scope between the already-existing `collector-health.ts` probe and a deployment liveness endpoint this TanStack Start version can't easily expose as JSON; see §21g)
-   [ ] Azure deployment (blocked — touches real subscription resources, not attempted without explicit access/direction)
-   [ ] Error monitoring (not attempted — no bounded task defined for it yet)

## P3 Optional

-   [ ] Nmap
-   [ ] Maltego export
-   [ ] Full Shodan API
-   [ ] Additional public social sources
-   [ ] Continuous monitoring

------------------------------------------------------------------------

# 36. Final Architecture Rule

The most important rule for the entire project is:

``` text
EXISTING SENTINEL
        |
        +-- Keep existing functionality
        |
        +-- Add Collector abstraction
                    |
                    +-- Existing collectors
                    |
                    +-- theHarvester
                    |
                    +-- SpiderFoot
                    |
                    +-- Optional tools
                    |
                    v
              ORCHESTRATOR
                    |
                    v
               NORMALIZER
                    |
                    v
              ENTITY RESOLVER
                    |
                    +-- Evidence
                    |
                    +-- Graph
                    |
                    +-- Reports
```

Do not turn Sentinel into a collection of shell commands.

Turn Sentinel into an **OSINT orchestration and correlation platform**.

------------------------------------------------------------------------

# 37. How to use this file

This file should be committed to the repository as:

``` text
docs/OSINT-INTEGRATION-PLAN.md
```

Both Claude Code and Antigravity should be instructed to read this file
before making OSINT-related changes.

Claude Code should treat the priority and order in this document as
authoritative.

Antigravity should use the UI sections and Definition of Done for
verification.

When a task is completed, update the checklist in this document in the
same commit.

Never skip ahead to P2/P3 while P0/P1 work is incomplete unless there is
a documented reason.
