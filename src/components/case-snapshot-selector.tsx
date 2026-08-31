import { FolderOpen } from "lucide-react";
import { optionSuffix, type CaseSnapshotOption } from "@/utils/cases/case-snapshot-selection";

/**
 * The case selector for `/graph` and `/timeline` (2026-08-30, ported from the
 * teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT SELECTS. IT DOES NOT INFER.
 *
 * There is no persisted "active case" in this codebase and this component does
 * not invent one. It renders the cases that exist (`getInvestigations()`, the
 * existing store — no second case store) and reports what the analyst picked.
 * Nothing else on the page, and nothing another route left behind, changes which
 * snapshot is shown.
 *
 * The default is the unscoped / latest slot, deliberately: that is what both
 * routes showed before case scoping, and it is what `/recon`'s "View in Graph"
 * hand-off lands on. Defaulting to a case would silently break that hand-off.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CASES WITH NO SNAPSHOT STAY IN THE LIST.
 *
 * Marked, not hidden. A hidden case is indistinguishable from a case that does
 * not exist, and the analyst would have no way to find out that the run never
 * produced one.
 *
 * The marker distinguishes two different facts:
 *
 *   (case with no snapshot)  this case has never produced one
 *   (evicted)                it produced one and storage discarded it
 *
 * Those call for opposite responses — the first is a finding about the run, the
 * second is a reason to re-run — so collapsing them into one label, as a single
 * "(no snapshot)" marker would, hides something the analyst needed.
 */

export function CaseSnapshotSelector({
  options,
  value,
  onChange,
  label,
}: {
  options: CaseSnapshotOption[];
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 font-mono text-[10px] text-console-muted">
      <FolderOpen className="size-3 text-console-cyan" />
      <span className="uppercase tracking-wider text-console-label">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 max-w-[16rem] truncate rounded border border-console-border bg-console-deep px-1.5 font-mono text-[10px] text-console-text outline-none focus:border-console-blue"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {/* The marker is part of the option text so it survives into the
                native dropdown, which cannot carry styling or a badge.
                "(evicted)" and "(case with no snapshot)" are different facts
                and must not collapse into one label. */}
            {o.label}
            {optionSuffix(o.state)}
          </option>
        ))}
      </select>
    </label>
  );
}
