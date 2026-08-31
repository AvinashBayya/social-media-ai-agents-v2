import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe2, MapPin, Search, AlertTriangle, ExternalLink, FolderOpen } from "lucide-react";
import type { ExifReport, DuplicateReport } from "@/utils/imaging";
import { metadataGeoint, METADATA_CAVEATS } from "@/utils/geoint/metadata";
import {
  MATCH_CAVEATS,
  MATCH_TYPES,
  ManualMatchError,
  buildManualMatch,
  matchesFromDuplicateReport,
  summariseMatches,
  type ImageMatch,
  type MatchType,
} from "@/utils/geoint/image-match";
import {
  HYPOTHESIS_CAVEATS,
  HypothesisError,
  buildLocationHypothesis,
  describeHypothesis,
  type LocationHypothesis,
} from "@/utils/geoint/geolocation-hypothesis";
import { GEOINT_PROVIDERS, providersFor, type GeoIntProviderId } from "@/utils/geoint/providers";
import { geointGraph, type GeoIntGraph } from "@/utils/geoint/evidence";
import {
  ATTACH_CAVEATS,
  NOT_CASE_SCOPED,
  type AttachOutcome,
} from "@/utils/cases/case-geoint";
import { confidenceBandOf } from "@/utils/collectors/result";

/**
 * GEOINT panel (2026-08-31, ported from the teammate's fork).
 *
 * Mounted on `/images` BELOW the existing EXIF/GPS/C2PA/OCR sections and
 * replacing none of them. `/images` already extracts and displays EXIF; this
 * panel adds the two capabilities that did not exist — reverse-image match
 * recording and location hypotheses — and shows the metadata projection beside
 * them so an analyst sees one image's whole geospatial picture at once.
 *
 * THE RENDERING RULES THIS PANEL ENFORCES:
 *   - An OBSERVED metadata location and a HYPOTHESIS location never share a
 *     badge, a colour or a sentence.
 *   - A hypothesis is printed through `describeHypothesis()`, never composed
 *     here, so the "Visual geolocation hypothesis:" qualifier cannot be dropped.
 *   - Manual-only providers are shown as manual with the reason, and there is no
 *     control anywhere that would run one automatically.
 *   - Caveats sit under each section rather than behind a toggle.
 */

const FIELD =
  "h-7 rounded border-console-border bg-console-deep font-mono text-[10px] text-console-text placeholder:text-console-muted";

const CARD = "rounded border border-console-border bg-console-deep";
const DIM = "text-console-label";
const MUTED = "text-console-muted";

export function GeoIntPanel({
  imageRef,
  exif,
  duplicates,
  // LIFTED to `/images`. These lived in this component's own `useState`, and
  // the GEOINT card is `defaultOpen={false}` over a `Section` that renders
  // `{open && children}`: collapsing the card unmounted the panel and
  // silently destroyed every match and hypothesis the analyst had recorded.
  manualMatches,
  onAddMatch,
  hypotheses,
  onAddHypothesis,
  // Frozen per analysed image, not read per render. It used to be
  // `new Date().toISOString()` called in the render body, so `retrievedAt` — and
  // therefore `collectedAt` on every evidence record — changed on every
  // keystroke in either form.
  retrievedAt,
  cases,
  caseId,
  onSelectCase,
  onAttach,
  attachment,
}: {
  imageRef: string;
  exif: ExifReport | null;
  duplicates: DuplicateReport | null;
  manualMatches: ImageMatch[];
  onAddMatch: (m: ImageMatch) => void;
  hypotheses: LocationHypothesis[];
  onAddHypothesis: (h: LocationHypothesis) => void;
  retrievedAt: string;
  cases: { id: string; label: string }[];
  caseId: string;
  onSelectCase: (id: string) => void;
  onAttach: (graph: GeoIntGraph) => void;
  attachment: AttachOutcome | null;
}) {
  const [error, setError] = useState("");

  const metadata = metadataGeoint(imageRef, exif, retrievedAt);
  const autoMatches = matchesFromDuplicateReport(imageRef, duplicates, retrievedAt);
  const matches = [...autoMatches, ...manualMatches];
  const graph = geointGraph(imageRef, { metadata, matches, hypotheses });
  const matchSummary = summariseMatches(matches);

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
          <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
          <span className="text-[10px] leading-relaxed text-console-red">{error}</span>
        </div>
      )}

      {/* ── 0. Case association ───────────────────────────────────────────
          Deliberately FIRST. The scope of what follows changes what it means,
          and an analyst who reads the findings before learning they are held
          nowhere has already read them as case evidence. */}
      <div className={`${CARD} p-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-blue">
            <FolderOpen className="size-3" /> Case association
          </span>
          <Badge
            data-testid="geoint-scope-badge"
            className={
              caseId
                ? "h-4 rounded-none border-console-blue/30 bg-console-blue/10 px-1 text-[8px] text-console-blue"
                : "h-4 rounded-none border-console-amber/30 bg-console-amber/10 px-1 text-[8px] text-console-amber"
            }
          >
            {caseId ? "CASE-SCOPED" : "NOT CASE-SCOPED"}
          </Badge>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          <select
            aria-label="Case"
            data-testid="geoint-case-select"
            value={caseId}
            onChange={(e) => onSelectCase(e.target.value)}
            className={`${FIELD} min-w-[180px] flex-1 px-1`}
          >
            {/* The empty option is a real state, not a prompt: GEOINT genuinely
                works with no case, and the case is never inferred from what
                happens to be on screen. */}
            <option value="">No case — browser only</option>
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <Button
            data-testid="geoint-attach"
            disabled={!caseId || graph.evidence.length === 0}
            onClick={() => onAttach(graph)}
            className="h-7 rounded-none bg-console-blue px-3 text-[10px] font-bold text-console-accent-foreground hover:bg-console-blue/90 disabled:opacity-40"
          >
            Add to case
          </Button>
        </div>

        {!caseId && (
          <p
            data-testid="geoint-not-scoped"
            className={`mt-2 text-[9px] leading-relaxed ${DIM}`}
          >
            {NOT_CASE_SCOPED}
          </p>
        )}

        {attachment && (
          <div
            data-testid="geoint-attach-result"
            className={`mt-2 border-t border-console-border/40 pt-2 text-[9px] leading-relaxed ${
              attachment.attached ? "text-console-green" : "text-console-amber"
            }`}
          >
            {attachment.detail}
            {attachment.evidenceIds.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {attachment.evidenceIds.map((id) => (
                  <a
                    key={id}
                    href={`/vault?q=${encodeURIComponent(id)}`}
                    className="font-mono text-[8px] text-console-blue hover:underline"
                  >
                    {id}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 space-y-0.5 border-t border-console-border/40 pt-2">
          {ATTACH_CAVEATS.map((c) => (
            <p key={c} className={`text-[9px] leading-relaxed ${DIM}`}>
              {c}
            </p>
          ))}
        </div>
      </div>

      {/* ── 1. Metadata GEOINT ──────────────────────────────────────────── */}
      <div className={`${CARD} p-3`}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-green">
            <MapPin className="size-3" /> Metadata GEOINT
          </span>
          <Badge className="h-4 rounded-none border-console-green/30 bg-console-green/10 px-1 text-[8px] text-console-green">
            OBSERVED
          </Badge>
        </div>

        {!metadata.exifPresent ? (
          <p className={`mt-2 text-[10px] leading-relaxed ${DIM}`}>
            No EXIF present. Nothing about capture device, time or location can be established from
            this file — and that is the normal case for redistributed media, not evidence of
            manipulation.
          </p>
        ) : (
          <div className="mt-2 space-y-1">
            {metadata.location ? (
              <div className="text-[10px] text-console-green">
                GPS fix {metadata.location.lat.toFixed(6)}, {metadata.location.lon.toFixed(6)}
                {metadata.altitude !== null && ` · ${metadata.altitude} m`}
              </div>
            ) : (
              <div className={`text-[10px] ${DIM}`}>No usable GPS block in this file.</div>
            )}

            {/* Wall clock vs instant is stated, never blurred. */}
            {metadata.captureWallClock && (
              <div className={`text-[10px] ${MUTED}`}>
                Capture {metadata.captureWallClock}
                {metadata.captureOffset ? (
                  <span className="text-console-green"> {metadata.captureOffset} · absolute instant</span>
                ) : (
                  <span className="text-console-amber">
                    {" "}
                    · camera wall clock, no UTC offset recorded — not placed on the timeline
                  </span>
                )}
              </div>
            )}

            <div className={`text-[10px] ${DIM}`}>
              {metadata.observations.length} metadata observation
              {metadata.observations.length === 1 ? "" : "s"} ·{" "}
              {graph.evidence.length} evidence record{graph.evidence.length === 1 ? "" : "s"}
            </div>
          </div>
        )}

        {metadata.cannotDetermine.length > 0 && (
          <div className="mt-2 space-y-0.5 border-t border-console-border/40 pt-2">
            {metadata.cannotDetermine.map((c) => (
              <p key={c} className={`text-[9px] leading-relaxed ${DIM}`}>
                Cannot determine: {c}
              </p>
            ))}
          </div>
        )}
        <Caveats items={METADATA_CAVEATS} />
      </div>

      {/* ── 2. Reverse-image / image match ──────────────────────────────── */}
      <div className={`${CARD} p-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-blue">
            <Search className="size-3" /> Reverse-image / image match ({matchSummary.total})
          </span>
          <span className={`text-[9px] ${DIM}`}>
            {matchSummary.automated} local · {matchSummary.manual} analyst-recorded
          </span>
        </div>

        <ProviderNotice capability="reverse-image" />

        {matches.length === 0 ? (
          <p className={`mt-2 text-[10px] leading-relaxed ${DIM}`}>
            No matches recorded. Local matching compares against images analysed in this browser
            only — it is not a search of the open web, so finding nothing here means nothing.
          </p>
        ) : (
          <div className="mt-2 max-h-56 overflow-y-auto rounded border border-console-border">
            {matches.map((m) => (
              <div key={m.matchId} className="space-y-1 border-b border-console-border/50 px-2 py-1.5 last:border-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge className="h-4 rounded-none border-console-blue/30 bg-console-blue/10 px-1 text-[8px] text-console-blue">
                    {m.matchType}
                  </Badge>
                  <Badge className="h-4 rounded-none border-console-label/30 bg-console-label/10 px-1 text-[8px] text-console-muted">
                    {m.discoveredBy === "MANUAL_ASSISTED" ? "analyst" : m.provider}
                  </Badge>
                  <Badge className="h-4 rounded-none border-console-purple/30 bg-console-purple/10 px-1 text-[8px] text-console-purple">
                    {m.claimClass}
                  </Badge>
                  {m.confidence.value !== null && (
                    <span className={`text-[9px] ${DIM}`}>{Math.round(m.confidence.value * 100)}%</span>
                  )}
                </div>
                <div className={`text-[10px] ${MUTED}`}>{m.description}</div>
                <div className={`flex flex-wrap gap-2 text-[9px] ${DIM}`}>
                  <span>{m.evidenceRef ?? m.matchId.slice(0, 42)}</span>
                  <span>{m.observedAt ? m.observedAt.slice(0, 10) : "no observed time"}</span>
                  {m.matchedUrl && (
                    <a
                      href={m.matchedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-console-blue hover:underline"
                    >
                      <ExternalLink className="size-2.5" /> open
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <ManualMatchForm
          imageRef={imageRef}
          retrievedAt={retrievedAt}
          onAdd={(m) => {
            setError("");
            onAddMatch(m);
          }}
          onError={setError}
        />
        <Caveats items={MATCH_CAVEATS} />
      </div>

      {/* ── 3. Visual geolocation hypothesis ────────────────────────────── */}
      <div className={`${CARD} p-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-amber">
            <Globe2 className="size-3" /> Visual geolocation ({hypotheses.length})
          </span>
          <Badge className="h-4 rounded-none border-console-amber/30 bg-console-amber/10 px-1 text-[8px] text-console-amber">
            ALWAYS HYPOTHESIS
          </Badge>
        </div>

        <ProviderNotice capability="visual-geolocation" />

        {hypotheses.length === 0 ? (
          <p className={`mt-2 text-[10px] leading-relaxed ${DIM}`}>
            No location hypotheses recorded.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {hypotheses.map((h) => (
              <div key={h.hypothesisId} className="rounded border border-console-amber/25 bg-console-amber/5 p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge className="h-4 rounded-none border-console-amber/30 bg-console-amber/10 px-1 text-[8px] text-console-amber">
                    {h.classification}
                  </Badge>
                  <Badge className="h-4 rounded-none border-console-label/30 bg-console-label/10 px-1 text-[8px] text-console-muted">
                    {h.provider}
                  </Badge>
                  {/* Band comes from the shared engine, which forces HYPOTHESIS. */}
                  <span className={`text-[9px] ${DIM}`}>
                    band {confidenceBandOf(h.confidence, h.claimClass) ?? "unscored"}
                    {h.confidence.value !== null && ` · provider ${Math.round(h.confidence.value * 100)}%`}
                  </span>
                </div>
                {/* Composed centrally so the qualifier can never be dropped. */}
                <div className="mt-1 text-[10px] text-console-text">{describeHypothesis(h)}</div>
                <div className={`mt-0.5 text-[9px] leading-relaxed ${DIM}`}>Reasoning: {h.reasoning}</div>
              </div>
            ))}
          </div>
        )}

        <HypothesisForm
          imageRef={imageRef}
          retrievedAt={retrievedAt}
          onAdd={(h) => {
            setError("");
            onAddHypothesis(h);
          }}
          onError={setError}
        />
        <Caveats items={HYPOTHESIS_CAVEATS} />
      </div>
    </div>
  );
}

function Caveats({ items }: { items: string[] }) {
  return (
    <div className="mt-2 space-y-0.5 border-t border-console-border/40 pt-2">
      {items.map((c) => (
        <p key={c} className={`text-[9px] leading-relaxed ${DIM}`}>
          {c}
        </p>
      ))}
    </div>
  );
}

/** Names every provider and why it is manual. An unexplained "manual" reads as laziness. */
function ProviderNotice({ capability }: { capability: "reverse-image" | "visual-geolocation" }) {
  const list = providersFor(capability);
  return (
    <div className="mt-2 space-y-1">
      {list.map((p) => (
        <div key={p.id} className="flex flex-wrap items-start gap-1.5 text-[9px] leading-relaxed">
          <Badge
            className={`h-4 shrink-0 rounded-none px-1 text-[8px] ${
              p.mode === "AUTOMATED_PROVIDER"
                ? "border-console-green/30 bg-console-green/10 text-console-green"
                : "border-console-amber/30 bg-console-amber/10 text-console-amber"
            }`}
          >
            {p.mode === "AUTOMATED_PROVIDER" ? "AUTOMATED" : "MANUAL"}
          </Badge>
          <span className={MUTED}>{p.name}</span>
          <span className={DIM}>{p.reason}</span>
          {p.manualUrl && (
            <a
              href={p.manualUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-console-blue hover:underline"
            >
              open provider
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

function ManualMatchForm({
  imageRef,
  retrievedAt,
  onAdd,
  onError,
}: {
  retrievedAt: string;
  imageRef: string;
  onAdd: (m: ImageMatch) => void;
  onError: (e: string) => void;
}) {
  const [provider, setProvider] = useState<GeoIntProviderId>("google-lens");
  const [matchType, setMatchType] = useState<MatchType>("VISUAL_SIMILARITY");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");

  const submit = () => {
    try {
      onAdd(
        buildManualMatch(
          { imageRef, provider, matchType, matchedUrl: url, description },
          retrievedAt,
        ),
      );
      setUrl("");
      setDescription("");
    } catch (err) {
      onError(err instanceof ManualMatchError ? err.message : String(err));
    }
  };

  return (
    <div className="mt-2 space-y-1.5 border-t border-console-border/40 pt-2">
      <p className={`text-[9px] font-bold uppercase tracking-wider ${DIM}`}>
        Record a reverse-image match
      </p>
      <div className="flex flex-wrap gap-1.5">
        <select
          aria-label="Provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as GeoIntProviderId)}
          className={`${FIELD} px-1`}
        >
          {GEOINT_PROVIDERS.filter((p) => p.capability === "reverse-image").map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Match type"
          value={matchType}
          onChange={(e) => setMatchType(e.target.value as MatchType)}
          className={`${FIELD} px-1`}
        >
          {MATCH_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <Input
        aria-label="Matched URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Matched URL (optional)"
        className={FIELD}
      />
      <Input
        aria-label="What you saw"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What the provider showed you (required)"
        className={FIELD}
      />
      <Button
        size="sm"
        onClick={submit}
        className="h-6 rounded bg-console-blue px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-blue/90"
      >
        Add match
      </Button>
    </div>
  );
}

function HypothesisForm({
  imageRef,
  retrievedAt,
  onAdd,
  onError,
}: {
  imageRef: string;
  retrievedAt: string;
  onAdd: (h: LocationHypothesis) => void;
  onError: (e: string) => void;
}) {
  /**
   * This was hardcoded `provider: "geospy"` with no selector, so an analyst's
   * own reading of a photograph was recorded as
   * `source: "geospy · visual geolocation"` and keyed `hypothesis:geospy:…` —
   * attributing their work to a paid provider this project has never called
   * (declared-not-enabled). This form is what would have made that false
   * attribution durable and citable in a case report.
   *
   * Defaults to `analyst`, which is what actually happened. An analyst who did
   * consult a provider manually can say so.
   */
  const [provider, setProvider] = useState<GeoIntProviderId>("analyst");
  const [candidate, setCandidate] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");

  const submit = () => {
    try {
      const latN = lat.trim() ? Number(lat) : null;
      const lonN = lon.trim() ? Number(lon) : null;
      onAdd(
        buildLocationHypothesis(
          {
            imageRef,
            provider,
            candidateLocation: candidate,
            reasoning,
            // Only passed when the analyst actually typed them.
            latitude: latN !== null && Number.isFinite(latN) ? latN : null,
            longitude: lonN !== null && Number.isFinite(lonN) ? lonN : null,
          },
          retrievedAt,
        ),
      );
      setCandidate("");
      setReasoning("");
      setLat("");
      setLon("");
    } catch (err) {
      onError(err instanceof HypothesisError ? err.message : String(err));
    }
  };

  return (
    <div className="mt-2 space-y-1.5 border-t border-console-border/40 pt-2">
      <p className={`text-[9px] font-bold uppercase tracking-wider ${DIM}`}>
        Record a location hypothesis
      </p>
      <select
        aria-label="Hypothesis source"
        value={provider}
        onChange={(e) => setProvider(e.target.value as GeoIntProviderId)}
        className={`${FIELD} w-full px-1`}
      >
        {providersFor("visual-geolocation").map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Input
        aria-label="Candidate location"
        value={candidate}
        onChange={(e) => setCandidate(e.target.value)}
        placeholder="Candidate location (required)"
        className={FIELD}
      />
      <Input
        aria-label="Reasoning"
        value={reasoning}
        onChange={(e) => setReasoning(e.target.value)}
        placeholder="Reasoning — what in the image supports this (required)"
        className={FIELD}
      />
      <div className="flex gap-1.5">
        <Input
          aria-label="Latitude"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          placeholder="lat (only if provided)"
          className={FIELD}
        />
        <Input
          aria-label="Longitude"
          value={lon}
          onChange={(e) => setLon(e.target.value)}
          placeholder="lon (only if provided)"
          className={FIELD}
        />
      </div>
      <Button
        size="sm"
        onClick={submit}
        className="h-6 rounded bg-console-amber px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-amber/90"
      >
        Add hypothesis
      </Button>
    </div>
  );
}
