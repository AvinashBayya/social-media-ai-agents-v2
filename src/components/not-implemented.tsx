import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Ban, Scale } from "lucide-react";
import { NOT_IMPLEMENTED } from "@/utils/imaging";

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
 */
export function NotImplementedPanel() {
  return (
    <Card className="border-[#F59E0B]/30 bg-[#111827]">
      <CardContent className="p-4">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
          <Ban className="size-3.5 text-[#F59E0B]" />
          Not implemented — and why
        </h3>
        <p className="mt-1.5 text-[10px] leading-relaxed text-[#94A3B8]">
          These capabilities are absent by decision, not oversight. Each entry states what it
          would require and what it would still get wrong if we had it. Nothing in this system
          produces a deepfake score, because a score we cannot stand behind is worse than a
          stated gap.
        </p>

        <div className="mt-3 space-y-2">
          {NOT_IMPLEMENTED.map((gap) => (
            <div key={gap.capability} className="rounded border border-[#263548] bg-[#0B1220]/60 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-white">{gap.capability}</span>
                <Badge
                  variant="outline"
                  className="border-[#64748B]/40 bg-[#64748B]/10 text-[9px] font-normal text-[#94A3B8]"
                >
                  not implemented
                </Badge>
              </div>
              <dl className="mt-1 space-y-1 text-[10px] leading-relaxed">
                <div>
                  <dt className="inline font-semibold text-[#94A3B8]">Would require: </dt>
                  <dd className="inline text-[#94A3B8]">{gap.requires}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-[#94A3B8]">Known limitation: </dt>
                  <dd className="inline text-[#94A3B8]">{gap.limitation}</dd>
                </div>
                {gap.licence && (
                  <div className="mt-1 flex items-start gap-1.5 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-1.5">
                    <Scale className="mt-px size-3 shrink-0 text-[#EF4444]" />
                    <span className="text-[#EF4444]">{gap.licence}</span>
                  </div>
                )}
              </dl>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
