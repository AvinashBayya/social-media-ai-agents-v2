import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Ban, ChevronDown, ChevronRight, Scale } from "lucide-react";
import { NOT_IMPLEMENTED, type Gap } from "@/utils/imaging";

/**
 * What Module 4 explicitly does NOT do.
 *
 * This panel is a deliverable, not a disclaimer. The problem statement asks for
 * identification of "artificially generated content / deep fake content", and
 * the honest answer with no GPU and no budget is that we detect DECLARED
 * generation cryptographically and cannot detect undeclared generation at all.
 *
 * Stating that, with what each capability would require and what it would still
 * get wrong, is a stronger position than shipping a classifier we cannot stand
 * behind. An evaluator who knows this field will trust the rest of the system
 * more precisely because it did not overclaim here.
 *
 * Collapsed by default (2026-08-20, at the user's request, to declutter the
 * page) — but never removed and never hidden behind a control that isn't
 * obviously there. The header (title + gap count) is always visible; only the
 * body — the actual per-capability disclosure — is what collapses. Same
 * open/close pattern as images.tsx's own `Section` component.
 */
interface NotImplementedPanelProps {
  /** Defaults to Module 4's imaging gaps — pass a different list (same Gap shape) for another module's disclosure. */
  gaps?: Gap[];
  title?: string;
  description?: string;
}

export function NotImplementedPanel({
  gaps = NOT_IMPLEMENTED,
  title = "Not implemented — and why",
  description = "These capabilities are absent by decision, not oversight. Each entry states what it " +
    "would require and what it would still get wrong if we had it. Nothing in this system " +
    "produces a deepfake score, because a score we cannot stand behind is worse than a " +
    "stated gap.",
}: NotImplementedPanelProps = {}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-console-amber/30 bg-console-surface">
      <CardContent className="p-4">
        <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 text-left">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-console-label" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-console-label" />
          )}
          <Ban className="size-3.5 shrink-0 text-console-amber" />
          <h3 className="text-xs font-bold uppercase text-console-text">{title}</h3>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-console-label">{gaps.length}</span>
        </button>
        {open && (
          <>
            <p className="mt-1.5 text-[10px] leading-relaxed text-console-muted">{description}</p>

            <div className="mt-3 space-y-2">
              {gaps.map((gap) => (
                <div
                  key={gap.capability}
                  className="rounded border border-console-border bg-console-deep/60 p-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold text-console-text">{gap.capability}</span>
                    <Badge
                      variant="outline"
                      className="border-console-label/40 bg-console-label/10 text-[9px] font-normal text-console-muted"
                    >
                      not implemented
                    </Badge>
                  </div>
                  <dl className="mt-1 space-y-1 text-[10px] leading-relaxed">
                    <div>
                      <dt className="inline font-semibold text-console-muted">Would require: </dt>
                      <dd className="inline text-console-muted">{gap.requires}</dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-console-muted">Known limitation: </dt>
                      <dd className="inline text-console-muted">{gap.limitation}</dd>
                    </div>
                    {gap.licence && (
                      <div className="mt-1 flex items-start gap-1.5 rounded border border-console-red/30 bg-console-red/5 p-1.5">
                        <Scale className="mt-px size-3 shrink-0 text-console-red" />
                        <span className="text-console-red">{gap.licence}</span>
                      </div>
                    )}
                  </dl>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
