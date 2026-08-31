import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ChevronDown, ChevronRight, FileWarning, ImageIcon, Save, ShieldQuestion } from "lucide-react";
import {
  FILE_PROVENANCE_NOT_IMPLEMENTED,
  assessFileProvenance,
  type FileProvenanceReport,
  type PdfSignatureCertificatePair,
  type ProvenanceField,
} from "@/utils/file-provenance";
import { interpretRevocationChecks, type RevocationCheckResult } from "@/utils/pdf-revocation";
import { checkCertificateRevocation } from "@/utils/pdf-revocation-client";
import { NotImplementedPanel } from "@/components/not-implemented";

const STATUS_STYLE: Record<string, string> = {
  present: "text-console-text",
  absent: "text-console-label italic",
  unreadable: "text-console-amber",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timestampLine(t: { local: string | null; offset: string | null; absolute: string | null; raw: string }): string {
  if (t.local === null) return `Not parseable — recorded as "${t.raw}"`;
  if (t.offset && t.absolute) return `${t.local} ${t.offset} (absolute: ${t.absolute})`;
  return `${t.local} — as recorded, no UTC offset in the file`;
}

export interface FileProvenanceItem {
  id: string;
  file: File;
  status: "pending" | "running" | "done" | "failed";
  report: FileProvenanceReport | null;
  error: string | null;
}

interface Props {
  items: FileProvenanceItem[];
  onContinueInImageIntelligence?: (item: FileProvenanceItem) => void;
  onAddToVault?: (item: FileProvenanceItem) => void;
  vaultSavedIds?: Set<string>;
}

export function FileProvenanceReportList({ items, onContinueInImageIntelligence, onAddToVault, vaultSavedIds }: Props) {
  if (items.length === 0) {
    return (
      <p className="p-4 text-[11px] leading-relaxed text-console-label">
        Attach a PDF, Word document, image, or video to read its embedded provenance metadata —
        who created it, what tool wrote it, and when. Nothing is uploaded anywhere; this runs
        entirely inside this browser tab.
      </p>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {items.map((item) => (
        <FileProvenanceCard
          key={item.id}
          item={item}
          onContinueInImageIntelligence={onContinueInImageIntelligence}
          onAddToVault={onAddToVault}
          saved={vaultSavedIds?.has(item.id) ?? false}
        />
      ))}
    </div>
  );
}

function FileProvenanceCard({
  item,
  onContinueInImageIntelligence,
  onAddToVault,
  saved,
}: {
  item: FileProvenanceItem;
  onContinueInImageIntelligence?: (item: FileProvenanceItem) => void;
  onAddToVault?: (item: FileProvenanceItem) => void;
  saved: boolean;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const { file, report, status, error } = item;

  return (
    <Card className="border-console-border bg-console-surface">
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-console-text">{file.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-console-muted">{formatBytes(file.size)}</span>
        </div>

        {status === "pending" || status === "running" ? (
          <p className="text-[10px] text-console-label">Reading embedded metadata…</p>
        ) : status === "failed" ? (
          <div className="flex items-start gap-1.5 rounded border border-console-red/30 bg-console-red/5 p-2">
            <FileWarning className="mt-0.5 size-3.5 shrink-0 text-console-red" />
            <p className="text-[10px] leading-relaxed text-console-red">{error ?? "Could not be read."}</p>
          </div>
        ) : report ? (
          <ReportBody report={report} />
        ) : null}

        {report && report.container.mismatch && (
          <div className="flex items-start gap-1.5 rounded border border-console-amber/30 bg-console-amber/5 p-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-console-amber" />
            <p className="text-[10px] leading-relaxed text-console-amber">{report.container.mismatchNote}</p>
          </div>
        )}

        {report && report.raw.length > 0 && (
          <div>
            <button
              onClick={() => setRawOpen(!rawOpen)}
              className="flex items-center gap-1 text-[10px] text-console-blue hover:underline"
            >
              {rawOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Raw metadata ({report.raw.length})
            </button>
            {rawOpen && (
              <div className="mt-1 space-y-1.5">
                {report.raw.map((r) => (
                  <div key={r.label} className="rounded border border-console-border bg-console-deep/60 p-2">
                    <p className="mb-1 font-mono text-[9px] font-bold text-console-label">{r.label}</p>
                    <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[9px] text-console-muted">
                      {r.text.slice(0, 4000)}
                      {r.text.length > 4000 ? "\n… truncated for display, view-only, not persisted." : ""}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {report && report.kind !== "unsupported" && (
          <p className="text-[9px] leading-relaxed text-console-label">
            This file was analysed entirely inside this browser tab. Nothing was uploaded.
          </p>
        )}

        {report && (report.kind === "pdf" || report.kind === "ooxml" || report.kind === "odf" || report.kind === "video" || report.kind === "image") && (
          <NotImplementedPanel
            gaps={FILE_PROVENANCE_NOT_IMPLEMENTED}
            title="What this cannot establish"
            description="Nothing in this report is cryptographically verified — every field is self-reported by the writing application. These are the specific things this tool does not check at all."
          />
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {report?.kind === "image" && onContinueInImageIntelligence && (
            <Button
              size="sm"
              onClick={() => onContinueInImageIntelligence(item)}
              className="h-7 rounded bg-console-cyan px-2 font-mono text-[9px] font-bold text-console-accent-foreground hover:bg-console-cyan/90"
            >
              <ImageIcon className="mr-1 size-3" /> Continue in Image Intelligence
            </Button>
          )}
          {report && report.kind !== "unsupported" && onAddToVault && (
            <Button
              size="sm"
              disabled={saved}
              onClick={() => onAddToVault(item)}
              className="h-7 rounded bg-console-elevated px-2 font-mono text-[9px] font-bold text-console-text hover:bg-console-border disabled:opacity-50"
            >
              <Save className="mr-1 size-3" /> {saved ? "Saved to Vault" : "Add to Evidence Vault"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ReportBody({ report }: { report: FileProvenanceReport }) {
  const assessment = assessFileProvenance(report);

  if (report.kind === "unsupported") {
    return (
      <div className="space-y-1.5">
        <p className="font-mono text-[10px] text-console-label">
          Container detected: <span className="text-console-text">{report.container.kind}</span>
        </p>
        {report.errors.map((e, i) => (
          <p key={i} className="text-[10px] leading-relaxed text-console-amber">
            {e}
          </p>
        ))}
      </div>
    );
  }

  const notable = report.fields.filter((f) => f.severity === "notable");
  const other = report.fields.filter((f) => f.severity !== "notable");

  return (
    <div className="space-y-2">
      <p className="text-[10px] leading-relaxed text-console-muted">{assessment.summary}</p>

      {report.errors.map((e, i) => (
        <div key={i} className="rounded border border-console-red/30 bg-console-red/5 p-1.5">
          <p className="text-[9px] leading-relaxed text-console-red">{e}</p>
        </div>
      ))}

      <div className="space-y-1">
        {[...notable, ...other].map((f) => (
          <FieldCard key={f.id} f={f} />
        ))}
      </div>

      {report.signatureCertificates && report.signatureCertificates.length > 0 && (
        <div className="space-y-1.5">
          {report.signatureCertificates.map((pair) => (
            <SignatureRevocationCheck key={pair.signatureIndex} pair={pair} />
          ))}
        </div>
      )}

      {report.timestamps.length > 0 && (
        <div className="space-y-1">
          {report.timestamps.map((t) => (
            <div key={t.id} className="rounded border border-console-border bg-console-deep/60 p-1.5">
              <span className="text-[10px] font-semibold text-console-text">{t.label}</span>
              <p className="font-mono text-[9px] text-console-cyan">{timestampLine(t)}</p>
              <p className="mt-0.5 text-[9px] leading-relaxed text-console-muted">{t.note}</p>
            </div>
          ))}
        </div>
      )}

      <details className="text-[9px] text-console-label">
        <summary className="cursor-pointer hover:text-console-muted">What this cannot determine</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-relaxed">
          {assessment.cannotDetermine.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function FieldCard({ f }: { f: ProvenanceField }) {
  return (
    <div
      className={`rounded border p-1.5 ${
        f.severity === "notable" ? "border-console-amber/30 bg-console-amber/5" : "border-console-border bg-console-deep/60"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold text-console-text">{f.label}</span>
        <span className={`font-mono text-[9px] ${STATUS_STYLE[f.status]}`}>
          {f.status === "absent" ? "not embedded" : f.status === "unreadable" ? f.note : f.value}
        </span>
      </div>
      {f.status !== "unreadable" && <p className="mt-0.5 text-[9px] leading-relaxed text-console-muted">{f.note}</p>}
    </div>
  );
}

type RevocationCheckState = { status: "idle" } | { status: "running" } | { status: "done"; results: RevocationCheckResult[] } | { status: "failed"; message: string };

/**
 * The one opt-in action anywhere in file-provenance that makes a real
 * network call (through a server-side proxy — see pdf-revocation-server.ts
 * for why OCSP/CRL endpoints can't be reached directly from a browser tab).
 * Deliberately NOT run automatically alongside everything else in this
 * report, unlike every other field here.
 */
function SignatureRevocationCheck({ pair }: { pair: PdfSignatureCertificatePair }) {
  const [state, setState] = useState<RevocationCheckState>({ status: "idle" });

  const run = async () => {
    setState({ status: "running" });
    try {
      const results = await checkCertificateRevocation(pair.leafDer, pair.issuerDer);
      setState({ status: "done", results });
    } catch (err: any) {
      setState({ status: "failed", message: err?.message ?? String(err) });
    }
  };

  return (
    <div className="rounded border border-console-border bg-console-deep/40 p-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-console-text">Signature {pair.signatureIndex + 1} — revocation check (OCSP/CRL)</span>
        <Button
          size="sm"
          disabled={state.status === "running"}
          onClick={run}
          className="h-6 rounded bg-console-elevated px-2 font-mono text-[9px] font-bold text-console-text hover:bg-console-border disabled:opacity-50"
        >
          <ShieldQuestion className="mr-1 size-3" />
          {state.status === "running" ? "Checking…" : state.status === "done" ? "Re-check" : "Check revocation"}
        </Button>
      </div>
      {state.status === "idle" && (
        <p className="mt-0.5 text-[9px] leading-relaxed text-console-label">
          Not run automatically — this is the one check in this report that leaves the browser tab (through this
          app's own server, to the certificate's real OCSP responder / CRL distribution point). Only the
          certificate's own serial and issuer bytes are sent, never the file's content.
        </p>
      )}
      {state.status === "failed" && <p className="mt-0.5 text-[9px] leading-relaxed text-console-red">{state.message}</p>}
      {state.status === "done" && (
        <div className="mt-1 space-y-1">
          {interpretRevocationChecks(state.results).map((f) => (
            <FieldCard key={f.id} f={f} />
          ))}
        </div>
      )}
    </div>
  );
}
