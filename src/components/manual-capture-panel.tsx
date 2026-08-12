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

import { useMemo, useState } from "react";
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

const EVIDENCE_KEY = "sentinel_evidence";

/** Local mirror of vault.tsx's stored shape. Same key, same reader. */
interface StoredEvidence {
  id: string;
  title: string;
  type: string;
  timestamp: string;
  source: string;
  hash: string | null;
  geo: string;
  entities: string[];
  caseId: string;
  risk: number | null;
  tags: string[];
  fileSize?: string | null;
}

function appendEvidence(item: StoredEvidence): void {
  if (typeof window === "undefined") return;
  let list: StoredEvidence[] = [];
  try {
    const raw = window.localStorage.getItem(EVIDENCE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    // A corrupt store must not silently discard the analyst's new record, but
    // it also must not be overwritten wholesale — prepending to an empty list
    // is the least destructive option and the vault page will show the result.
    list = [];
  }
  list.unshift(item);
  window.localStorage.setItem(EVIDENCE_KEY, JSON.stringify(list));
}

export function ManualCapturePanel() {
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<CapturePlatform>("instagram");
  const [sourceUrl, setSourceUrl] = useState("");
  const [capturedBy, setCapturedBy] = useState("");
  const [capturedAt, setCapturedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [note, setNote] = useState("");
  const [caseId, setCaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  const cases = useMemo(() => (typeof window === "undefined" ? [] : getInvestigations()), []);

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

      const capture = buildAttestedCapture({
        platform,
        sourceUrl,
        capturedBy,
        capturedAt: new Date(capturedAt).toISOString(),
        note,
        sha256,
        filename: file.name,
        fileSize: file.size,
        // pHash needs the image decoded in a canvas. It is computed on the
        // Images page when the analyst sends this asset for provenance
        // analysis; null here is honest rather than a placeholder.
        phash: null,
      });

      appendEvidence({
        id: capture.id,
        title: `${CAPTURE_PLATFORM_LABELS[capture.platform]} capture — ${capture.filename}`,
        type: file.type.includes("pdf") ? "PDF" : "Screenshot",
        timestamp: capture.capturedAt.replace("T", " ").slice(0, 19) + " UTC",
        source: `Analyst capture by ${capture.capturedBy} — ${capture.sourceUrl}`,
        hash: capture.sha256,
        geo: "Not established",
        entities: [],
        caseId,
        // Never auto-scored. An analyst rates it or it stays unrated, matching
        // the rule the evidence vault already follows.
        risk: null,
        tags: ["analyst-capture", capture.platform, "manual-only"],
        fileSize: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
      });

      if (caseId) {
        pinToInvestigation(caseId, {
          kind: "note",
          title: `${CAPTURE_PLATFORM_LABELS[capture.platform]} capture — ${capture.filename}`,
          source: `Analyst capture by ${capture.capturedBy}`,
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

      toast.success(
        `Capture ${capture.id} recorded as analyst-attested evidence${caseId ? ` and pinned to ${caseId}` : ""}.`,
      );
      setFile(null);
      setSourceUrl("");
      setNote("");
    } catch (err: any) {
      if (err instanceof AttestationError) setError({ field: err.field, message: err.message });
      else if (err instanceof EvidenceIntegrityError) setError({ field: "file", message: err.message });
      else setError({ field: "", message: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (name: string) =>
    error?.field === name ? (
      <p className="mt-1 text-[9px] leading-relaxed text-[#EF4444]">{error.message}</p>
    ) : null;

  return (
    <Card className="border-[#F59E0B]/30 bg-[#111827]">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <UploadCloud className="size-4 text-[#F59E0B]" />
          <h3 className="text-xs font-bold uppercase text-white">Manual capture — Meta and other</h3>
          <Badge
            variant="outline"
            className="h-4 border-[#F59E0B]/40 bg-[#F59E0B]/10 px-1.5 text-[8px] font-normal text-[#F59E0B]"
          >
            analyst-attested
          </Badge>
        </div>

        <p className="text-[10px] leading-relaxed text-[#94A3B8]">
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
            dragging ? "border-[#F59E0B] bg-[#F59E0B]/5" : "border-[#263548] hover:border-[#F59E0B]/50"
          }`}
        >
          <label className="cursor-pointer">
            <input
              type="file"
              className="hidden"
              accept="image/*,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="font-mono text-[10px] text-[#10B981]">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </span>
            ) : (
              <span className="text-[10px] text-[#64748B]">
                Drop the screenshot or PDF here, or click to choose
              </span>
            )}
          </label>
        </div>
        {fieldError("file")}

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-[9px] font-semibold uppercase text-[#64748B]">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as CapturePlatform)}
              className="mt-0.5 h-7 w-full rounded border border-[#263548] bg-[#0B1220] px-2 text-[10px] text-white"
            >
              {(Object.keys(CAPTURE_PLATFORM_LABELS) as CapturePlatform[]).map((p) => (
                <option key={p} value={p}>
                  {CAPTURE_PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[9px] font-semibold uppercase text-[#64748B]">
              Link to case (optional)
            </label>
            <select
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              className="mt-0.5 h-7 w-full rounded border border-[#263548] bg-[#0B1220] px-2 text-[10px] text-[#06B6D4]"
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
          <label className="text-[9px] font-semibold uppercase text-[#64748B]">
            Public URL of the post <span className="text-[#EF4444]">*</span>
          </label>
          <Input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://www.instagram.com/p/…"
            className="mt-0.5 h-7 border-[#263548] bg-[#0B1220] text-[10px] text-white"
          />
          {fieldError("sourceUrl")}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="text-[9px] font-semibold uppercase text-[#64748B]">
              Captured by <span className="text-[#EF4444]">*</span>
            </label>
            <Input
              value={capturedBy}
              onChange={(e) => setCapturedBy(e.target.value)}
              placeholder="Analyst name or callsign"
              className="mt-0.5 h-7 border-[#263548] bg-[#0B1220] text-[10px] text-white"
            />
            {fieldError("capturedBy")}
          </div>
          <div>
            <label className="text-[9px] font-semibold uppercase text-[#64748B]">
              Captured at <span className="text-[#EF4444]">*</span>
            </label>
            <input
              type="datetime-local"
              value={capturedAt}
              onChange={(e) => setCapturedAt(e.target.value)}
              className="mt-0.5 h-7 w-full rounded border border-[#263548] bg-[#0B1220] px-2 text-[10px] text-white"
            />
            {fieldError("capturedAt")}
          </div>
        </div>

        <div>
          <label className="text-[9px] font-semibold uppercase text-[#64748B]">
            What this shows, and how it was obtained
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="e.g. Public post by @handle, visible without login, captured from a browser at the stated time. Post timestamp legible as 14:02 IST."
            className="mt-0.5 w-full rounded border border-[#263548] bg-[#0B1220] px-2 py-1 text-[10px] leading-relaxed text-white"
          />
        </div>

        {error && !error.field && (
          <p className="text-[9px] leading-relaxed text-[#EF4444]">{error.message}</p>
        )}

        <Button
          onClick={() => void submit()}
          disabled={busy}
          className="h-8 w-full gap-1.5 bg-[#F59E0B] text-[10px] font-bold uppercase text-black hover:bg-[#F59E0B]/90"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          {busy ? "Hashing and recording…" : "Record attested capture"}
        </Button>

        {/* The caveats are not boilerplate — each names a wrong inference this
            panel would otherwise invite. */}
        <div className="space-y-1.5 rounded border border-[#263548] bg-[#0B1220] p-2.5">
          <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase text-[#F59E0B]">
            <AlertTriangle className="size-3" /> What this record does and does not establish
          </div>
          <ul className="space-y-1">
            {CAPTURE_CAVEATS.map((c) => (
              <li key={c} className="flex gap-1.5 text-[9px] leading-relaxed text-[#94A3B8]">
                <span className="text-[#64748B]">·</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
          <p className="flex gap-1.5 border-t border-[#263548]/60 pt-1.5 text-[9px] leading-relaxed text-[#64748B]">
            <FileWarning className="mt-px size-3 shrink-0" />
            {ATTRIBUTION_LIMITATION}
          </p>
          <p className="text-[9px] leading-relaxed text-[#64748B]">{HASH_MEANING}</p>
        </div>
      </CardContent>
    </Card>
  );
}
