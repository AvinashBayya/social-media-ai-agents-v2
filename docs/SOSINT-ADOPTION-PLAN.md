# Adopting from `brevitech/sosint` (N8RA) into Sentinel — GIS + Data Sources

## What sosint actually is (grounded)

- **Stack:** vanilla JS/HTML/CSS, client-side only. "No dependencies" philosophy.
- **GIS:** Leaflet 1.9.4 + Leaflet.markercluster + CARTO `dark_all` basemap tiles (OSM data).
- **News:** RSS fetched **client-side via a public CORS proxy** (`api.allorigins.win/raw?url=`). ~4 feeds wired (BBC/NYT/Al Jazeera Middle East, Google News RSS).
- **Most "modules":** static canned JSON (military-assets, incidents, air-traffic, telegram-osint, sanctions…) — hardcoded US-Iran demo data, **not live**.
- **License:** no LICENSE file present → treat as all-rights-reserved. **Reimplement the patterns; do not copy their code.** (Leaflet + RSS aggregation are standard techniques, so this is easy.)

## Hard constraints when adopting (Sentinel rules)

- **No canned/fabricated data.** Use their JSON files only as *schema examples*; every value in Sentinel must come from a real, provenanced source or show an explicit empty/error state.
- **Self-host the RSS fetch.** Do NOT use `allorigins.win` (third-party egress breaks air-gap + sovereignty). Your backend already exists — fetch RSS **server-side** (feedparser / a fetch route); no CORS proxy needed.
- **Self-hostable map tiles for air-gap.** CARTO/OSM tiles are hosted. For the networked build use Mappls (India) or CARTO; for air-gap, self-host OSM tiles. Make the tile URL config-driven.
- **No Telegram scraping.** Ignore the `telegram-osint.json` ingestion — same rule as Meta scraping (ToS/DPDP).
- **Structured failures + provenance** on every feed/layer (a dead feed = `error`, never a silent empty).

---

## Module triage — take / generalize / skip

| # | Module | Verdict | Why / how to use it |
|---|---|---|---|
| 01 | Live Intelligence Feed | **TAKE** | RSS/news aggregation → your M2/M3 open-source content. Self-host the fetch; use the curated feed list below. |
| 02 | Theater Map | **TAKE (core of your GIS module)** | Leaflet + markercluster + dark basemap. Pluggable layers fed by *your* collectors. |
| 04 | Threat Level Matrix | **GENERALIZE** | Escalation gauge + timeline UI → a **credibility/threat panel** for reports (M1/M5). Real, provenanced scores only. |
| 05 | Strait of Hormuz Monitor | **GENERALIZE** | → generic **maritime chokepoint / AIS layer** on the map. Optional; needs an AIS feed. |
| 09 | Air Defense Networks | **GENERALIZE** | → generic **coverage/range overlay** layer (circles/polygons) on the map engine. |
| 10 | Naval Forces Tracker | **GENERALIZE** | → generic **asset/track layer** (points + movement). Air/marine tracking optional feeds below. |
| 12 | Timeline & Escalation History | **TAKE** | Event chronology component for reports — driven by GDELT/news events, not canned. |
| 03 | Military Assets Comparison | skip | US-Iran content, not a reusable feature. |
| 06 | Sanctions & Economic | skip | Niche; out of PS-18 scope. |
| 07 | Nuclear Program Status | skip | Theater content. |
| 08 | Regional Allies & Proxies | skip | Theater content. |
| 11 | Cyber Operations | skip (content) | A cyber-threat RSS feed can just join the feed list instead. |

**Net:** two real capabilities to adopt — **(A) a reusable Leaflet GIS engine with pluggable layers**, and **(B) a server-side RSS/news aggregation service** — plus **(C) GDELT** as an event+geo source that feeds both the map and the timeline.

---

## Data sources to add (news / RSS / events / geo)

Legend: **Free/Open** · ⚖️ sovereignty/air-gap note.

### News / RSS (server-side fetch → feedparser)
| Source | Feed | Note |
|---|---|---|
| Reuters / AP / AFP | wire RSS | general |
| BBC / Al Jazeera | world RSS | general |
| Google News RSS | `news.google.com/rss/search?q=…` | query-driven, great for entity/topic |
| Indian gov | **PIB**, **MEA**, PRS RSS | ⚖️ India-relevant, sovereign |
| Defense press | Defense One, USNI, Breaking Defense | domain feeds |

### Events + geolocation (feed the MAP and the TIMELINE)
| Source | What | Free? | Note |
|---|---|---|---|
| **GDELT 2.0** | global events w/ lat-long + tone, 15-min updates | Free/Open | best single add — geolocated events → map pins + timeline |
| **ACLED** | armed-conflict events (incl. South Asia) | Free (key, academic/eval) | ⚖️ verify current terms |
| **ReliefWeb API** | humanitarian/incident reports | Free | UN OCHA, geo-tagged |

### Optional track layers (networked only)
| Source | What | Free? | Note |
|---|---|---|---|
| **OpenSky Network** | ADS-B aircraft tracks | Free tier | air layer |
| **AISStream / AIS** | maritime vessel tracks | Free tier | chokepoint layer |

### Map tiles
| Option | Use |
|---|---|
| **Mappls (MapMyIndia)** | networked, India sovereign (your earlier choice) |
| **CARTO dark / OSM** | networked fallback |
| **Self-hosted OSM tiles** | air-gap delivery |

---

## CLAUDE CODE PROMPT

```
Read and follow: docs/OSINT-INTEGRATION-PLAN.md and docs/SOSINT-ADOPTION-PLAN.md

Enhance Sentinel's GIS module and add a news/events aggregation capability, adapting
PATTERNS (not code) from the sosint/N8RA dashboard. Reuse existing Sentinel collectors,
Evidence store, and provenance. Do NOT rewrite working features. Do NOT copy sosint code
(no license) — reimplement with standard Leaflet + server-side RSS.

ANALYSIS FIRST (no code changes; write docs/GIS-DATASOURCE-ANALYSIS.md):
- Locate the current GIS module + map component (file paths + line ranges) and how it gets
  coordinates today. Confirm the collector/Evidence interfaces to plug into.
- End with Assumptions & unknowns. STOP for approval before building.

THEN, on approval, behind a feature flag:

A) GIS ENGINE (generalize sosint Module 02/05/09/10)
   - Leaflet + markercluster. Config-driven tile URL: default Mappls (networked) with an
     OSM/self-hosted fallback for air-gap. NO hardcoded third-party tile lock-in.
   - Pluggable LAYERS, each fed by an existing collector/Evidence query, NEVER canned data:
       * incidents/events (points, clustered)
       * assets/tracks (points, optional movement)
       * coverage/zones (circles/polygons)
   - Each map feature carries provenance {source, fetchedAt, ref}; an empty/failed layer shows
     an explicit "no data / source error" state, not a blank pretend-empty map.

B) NEWS/RSS AGGREGATION (adopt sosint Module 01, but server-side)
   - A backend collector that fetches a CONFIGURABLE list of RSS feeds SERVER-SIDE
     (feedparser / fetch), parses to {title, link, source, publishedAt, summary}.
     NO public CORS proxy (no allorigins) — server fetch only. Passive, read-only.
   - Seed feed list from docs (Reuters/AP/BBC/Al Jazeera/Google News RSS + India: PIB/MEA).
   - Structured-failure envelope per feed (ok|error|timeout|skipped); dedupe by normalized URL.

C) GDELT EVENTS (new source feeding BOTH map + timeline)
   - Query GDELT 2.0 for geolocated events; map -> map pins, chronology -> timeline component.
   - Provenance + confidence; no fabricated coordinates (drop events without geo, don't invent).

D) TIMELINE component (adopt Module 12): render a chronology from real events (GDELT/news),
   each entry linking to its source. No canned history.

CONSTRAINTS:
- No fabricated/canned data anywhere (sosint JSON is schema reference only).
- Self-hostable tiles + server-side RSS (air-gap capable). No Telegram/social scraping.
- Optional OpenSky/AIS track layers behind config, networked-only, clearly optional.
- Preserve provenance; failed sources report structured errors.
- Keep changes modular, reversible, flag-gated.

After each unit: bun test ; tsc --noEmit ; bun scripts/check-exports.ts ;
bun scripts/fabrication-check.ts . Do not proceed if existing tests fail.
```
