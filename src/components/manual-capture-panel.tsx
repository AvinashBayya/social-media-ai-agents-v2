/**
 * Manual capture panel — the only route by which Instagram and Facebook content
 * enters the system.
 *
 * This is the operational half of the `manual-only` policy row. The legal half
 * lives in `collection-policy.ts`; this is what an analyst actually does about
 * it: open a public post, capture it, and attest to the capture.
 *
 * Everything here is written so that an attested capture can never be mistaken
 * for a collected post. It carries the analyst as its source, it is refused
 * without attribution, and it states on screen why the provenance checks a
 * reviewer will run against it are all going to come back empty.
 */

import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { UploadCloud, ShieldCheck, AlertTriangle, Loader2, FileWarning } from "lucide-react";
import { sha256OfFile, HASH_MEANING, EvidenceIntegrityError } from "@/utils/evidence";
import {
  buildAttestedCapture,
  AttestationError,
  CAPTURE_CAVEATS,
  CAPTURE_PLATFORM_LABELS,
  ATTRIBUTION_LIMITATION,
  type CapturePlatform,
} from "@/utils/manual-evidence";
import { getInvestigations, pinToInvestigation } from "@/utils/investigations-store";
import { appendEvidence, type EvidenceRecord } from "@/utils/evidence-store";

/*
 * The record shape and the write both moved to utils/evidence-store.ts.
 *
 * This file used to declare its own `EVIDENCE_KEY`, its own `StoredEvidence`
 * interface and its own `appendEvidence`, with the comment "Local mirror of
 * vault.tsx's stored shape. Same key, same reader." Two writers over one key,
 * each with its own idea of the shape, is how the two ends drift apart — which
 * is the same reason `sha256OfFile` was extracted into utils/evidence.ts.
 */
type StoredEvidence = EvidenceRecord;

export function ManualCapturePanel() {
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<CapturePlatform>("instagram");
  const [sourceUrl, setSourceUrl] = useState("");
  const [capturedBy, setCapturedBy] = useState("");
  /**
   * `datetime-local` reads and writes LOCAL wall-clock time.
   *
   * This seeded it with `new Date().toISOString().slice(0,16)` — a UTC wall
   * clock. The input then displayed that as a local time, and submit ran
   * `new Date(value)`, which parses a bare `datetime-local` string as local and
   * converts back to UTC — subtracting the offset a second time. At IST every
   * attested capture was therefore stamped 5h30m before it was taken, and the
   * vault row labelled that instant "UTC". On a record whose entire purpose is
   * to say when a screen was observed, that is the one field that must be right.
   *
   * Shifting by the offset here means the input shows real local time, and the
   * round trip on submit is exact.
   */
  const [capturedAt, setCapturedAt] = useState(() => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [note, setNote] = useState("");
  const [caseId, setCaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Read AFTER mount, not during render. A useMemo over localStorage returns []
  // on the server and the real list on the client, so the <select> rendered two
  // different option sets and React logged a hydration mismatch on every load
  // of /social.
  const [cases, setCases] = useState<{ id: string }[]>([]);
  useEffect(() => setCases(getInvestigations()), []);

  const submit = async () => {
    setError(null);
    if (!file) {
      setError({ field: "file", message: "Select or drop the capture file first." });
      return;
    }

    setBusy(true);
    try {
      // Hash first. If this fails there is no record at all — an evidence entry
      // whose integrity cannot be established later is worse than none.
      const sha256 = await sha256OfFile(file);

      // Pass the raw field through. Converting here ran
      // `new Date("").toISOString()` when the analyst cleared the field, which
      // throws RangeError BEFORE buildAttestedCapture can validate — so its
      // field-specific "a valid capture time is required, and it is the time of
      // capture, not the time the post was published" message was unreachable
      // dead code, and the generic "Invalid time value" landed in the unattached
      // error blob with no indication of which field was wrong.
      const capture = buildAttestedCapture({
        platform,
        sourceUrl,
        capturedBy,
        capturedAt,
        note,
        sha256,
        filename: file.name,
        fileSize: file.size,
        // pHash needs the image decoded in a canvas. It is computed on the
        // Images page when the analyst sends this asset for provenance
        // analysis; null here is honest rather than a placeholder.
        phash: null,
      });

      let pinned = false;
      if (caseId) {
        pinned = pinToInvestigation(caseId, {
          kind: "note",
          title: `${CAPTURE_PLATFORM_LABELS[capture.platform]} capture — ${capture.filename}`,
          source: `Analyst capture by ${capture.capturedBy}`,
          // The post address, carried explicitly. Omitting it left
          // PinnedEvidence.url as "", which dropped the URL from every generated
          // citation — the one field buildAttestedCapture refuses a capture
          // without, because "the capture cannot be traced back to what it
          // depicts" — and left the store's duplicate guard, which keys on url,
          // inert for captures so the same one pinned repeatedly.
          url: capture.sourceUrl,
          publishedAt: capture.capturedAt,
          excerpt: capture.note || `Captured from ${capture.sourceUrl}`,
          credibility: null,
          credibilityRationale:
            "Analyst-attested capture, not collected data. The analyst is the source of this " +
            "record. Its SHA-256 shows the file is unaltered since upload; nothing about the " +
            "depicted post has been verified.",
          data: capture,
        });
      }

      // Written AFTER the pin, and carrying the case id only if the pin really
      // landed. Storing the requested id regardless made /vault show the capture
      // as belonging to a case that has no record of it.
      appendEvidence({
        id: capture.id,
        title: `${CAPTURE_PLATFORM_LABELS[capture.platform]} capture — ${capture.filename}`,
        type: file.type.includes("pdf") ? "PDF" : "Screenshot",
        timestamp: capture.capturedAt.replace("T", " ").slice(0, 19) + " UTC",
        source: `Analyst capture by ${capture.capturedBy} — ${capture.sourceUrl}`,
        hash: capture.sha256,
        geo: "Not established",
        entities: [],
        caseId: pinned ? caseId : "",
        // Never auto-scored. An analyst rates it or it stays unrated, matching
        // the rule the evidence vault already follows.
        risk: null,
        tags: ["analyst-capture", capture.platform, "manual-only"],
        fileSize: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
      });

      // pinToInvestigation returns false without throwing when the case no
      // longer exists or the URL is already pinned. Dropping that return and
      // toasting success regardless reported a pin that had not happened — a
      // fabricated success in the one panel whose purpose is not asserting more
      // than the evidence supports.
      if (!caseId) {
        toast.success(`Capture ${capture.id} recorded as analyst-attested evidence.`);
      } else if (pinned) {
        toast.success(`Capture ${capture.id} recorded and pinned to ${caseId}.`);
      } else {
        toast.warning(
          `Capture ${capture.id} was recorded in the evidence vault, but NOT pinned to ${caseId} — ` +
            `that case no longer exists, or this source URL is already pinned to it.`,
        );
      }
      setFile(null);
      // Clearing state alone leaves the <input type="file"> holding the old
      // selection, so re-picking the same file fires no change event and the
      // drop zone reads "no file" while the element still has one.
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSourceUrl("");
      setNote("");
    } catch (err: any) {
      if (err instanceof AttestationError) setError({ field: err.field, message: err.message });
      else if (err instanceof EvidenceIntegrityError)
        setError({ field: "file", message: err.message });
      else setError({ field: "", message: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (name: string) =>
    error?.field === name ? (
      <p className="mt-1 text-[9px] leading-relaxed text-console-red">{error.message}</p>
    ) : null;

  return (
    <Card className="border-console-amber/30 bg-console-surface">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <UploadCloud className="size-4 text-console-amber" />
          <h3 className="text-xs font-bold uppercase text-console-text">
            Manual capture — Meta and other
          </h3>
          <Badge
            variant="outline"
            className="h-4 border-console-amber/40 bg-console-amber/10 px-1.5 text-[8px] font-normal text-console-amber"
          >
            analyst-attested
          </Badge>
        </div>

        <p className="text-[10px] leading-relaxed text-console-muted">
          Instagram and Facebook are not collected — Meta&apos;s terms prohibit it and bulk
          collection would process personal data without a lawful basis under the DPDP Act 2023. A
          public post still enters here, as a capture an analyst makes and stands behind. It is
          stored as evidence, never counted as a collected post.
        </p>

        {/* File */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
          className={`flex min-h-[70px] cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed p-3 text-center transition-colors ${
            dragging
              ? "border-console-amber bg-console-amber/5"
              : "border-console-border hover:border-console-amber/50"
          }`}
        >
          <label className="cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="font-mono text-[10px] text-console-green">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </span>
            ) : (
              <span className="text-[10px] text-console-label">
                Drop the screenshot or PDF here, or click to choose
              </span>
            )}
          </label>
        </div>
        {fieldError("file")}

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-[9px] font-semibold uppercase text-console-label">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as CapturePlatform)}
              className="mt-0.5 h-7 w-full rounded border border-console-border bg-console-deep px-2 text-[10px] text-console-text"
            >
              {(Object.keys(CAPTURE_PLATFORM_LABELS) as CapturePlatform[]).map((p) => (
                <option key={p} value={p}>
                  {CAPTURE_PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[9px] font-semibold uppercase text-console-label">
              Link to case (optional)
            </label>
            <select
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              className="mt-0.5 h-7 w-full rounded border border-console-border bg-console-deep px-2 text-[10px] text-console-cyan"
            >
              <option value="">— none —</option>
              {cases.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[9px] font-semibold uppercase text-console-label">
            Public URL of the post <span className="text-console-red">*</span>
          </label>
          <Input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://www.instagram.com/p/…"
            className="mt-0.5 h-7 border-console-border bg-console-deep text-[10px] text-console-text"
          />
          {fieldError("sourceUrl")}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-[9px] font-semibold uppercase text-console-label">
              Captured by <span className="text-console-red">*</span>
            </label>
            <Input
              value={capturedBy}
              onChange={(e) => setCapturedBy(e.target.value)}
              placeholder="Analyst name or callsign"
              className="mt-0.5 h-7 border-console-border bg-console-deep text-[10px] text-console-text"
            />
            {fieldError("capturedBy")}
          </div>
          <div>
            <label className="text-[9px] font-semibold uppercase text-console-label">
              Captured at <span className="text-console-red">*</span>
            </label>
            <input
              type="datetime-local"
              value={capturedAt}
              onChange={(e) => setCapturedAt(e.target.value)}
              className="mt-0.5 h-7 w-full rounded border border-console-border bg-console-deep px-2 text-[10px] text-console-text"
            />
            {fieldError("capturedAt")}
          </div>
        </div>

        <div>
          <label className="text-[9px] font-semibold uppercase text-console-label">
            What this shows, and how it was obtained
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="e.g. Public post by @handle, visible without login, captured from a browser at the stated time. Post timestamp legible as 14:02 IST."
            className="mt-0.5 w-full rounded border border-console-border bg-console-deep px-2 py-1 text-[10px] leading-relaxed text-console-text"
          />
        </div>

        {error && !error.field && (
          <p className="text-[9px] leading-relaxed text-console-red">{error.message}</p>
        )}

        <Button
          onClick={() => void submit()}
          disabled={busy}
          className="h-8 w-full gap-1.5 bg-console-amber text-[10px] font-bold uppercase text-console-accent-foreground hover:bg-console-amber/90"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="size-3.5" />
          )}
          {busy ? "Hashing and recording…" : "Record attested capture"}
        </Button>

        {/* The caveats are not boilerplate — each names a wrong inference this
            panel would otherwise invite. */}
        <div className="space-y-1.5 rounded border border-console-border bg-console-deep p-2.5">
          <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase text-console-amber">
            <AlertTriangle className="size-3" /> What this record does and does not establish
          </div>
          <ul className="space-y-1">
            {CAPTURE_CAVEATS.map((c) => (
              <li key={c} className="flex gap-1.5 text-[9px] leading-relaxed text-console-muted">
                <span className="text-console-label">·</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
          <p className="flex gap-1.5 border-t border-console-border/60 pt-1.5 text-[9px] leading-relaxed text-console-label">
            <FileWarning className="mt-px size-3 shrink-0" />
            {ATTRIBUTION_LIMITATION}
          </p>
          <p className="text-[9px] leading-relaxed text-console-label">{HASH_MEANING}</p>
        </div>
      </CardContent>
    </Card>
  );
}
