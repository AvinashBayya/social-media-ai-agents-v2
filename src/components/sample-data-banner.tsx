import { FlaskConical } from "lucide-react";

/**
 * Marks a view whose contents are demonstration data, not collected intelligence.
 *
 * Several routes ship seed records ("Vector-17", "Aster Motors", INV-2041 and
 * friends) so the UI has something to render before any collection has run.
 * That is legitimate for a demonstrator — what is not legitimate is letting an
 * evaluator mistake it for output. Labelled sample data is defensible; unlabelled
 * sample data reads as fabrication.
 *
 * Remove the banner from a route only when that route stops rendering seed data.
 */
export function SampleDataBanner({ detail }: { detail?: string }) {
  return (
    <div className="mx-6 mt-4 flex items-start gap-2 rounded border border-console-amber/30 bg-console-amber/5 px-3 py-2">
      <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-console-amber" />
      <div className="font-mono text-[10px] leading-relaxed text-console-amber">
        <span className="font-bold uppercase tracking-wider">Sample data</span> — this view renders
        seeded demonstration records, not collected intelligence.
        {detail ? ` ${detail}` : ""}
      </div>
    </div>
  );
}
