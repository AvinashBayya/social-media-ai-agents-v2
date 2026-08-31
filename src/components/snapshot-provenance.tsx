import { Badge } from "@/components/ui/badge";
import { FolderOpen, HelpCircle, Scissors } from "lucide-react";
import type { SnapshotTruncation } from "@/utils/cases/case-scope";

/**
 * Which case a displayed snapshot came from (2026-08-30, ported from the
 * teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS EVEN THOUGH PER-CASE KEYS ALREADY LANDED.
 *
 * `/graph` and `/timeline` also read the UNSCOPED slot
 * (`readGraphSnapshot()` / `readTimelineSnapshot()`), which is still
 * single-slot and last-write-wins — deliberately, because both routes are
 * also reachable straight from `/recon` with no case in play at all.
 *
 * That is fine as a mechanism and fatal as a *silent* one: run case A then
 * case B, and the unscoped slot holds B's data. The case panel correctly
 * shows A its own snapshot, but an analyst who then clicks through to
 * `/graph` with no case selected would see B's graph with nothing on the
 * page saying so. Same class of bug, one route further out.
 *
 * So the snapshot states its own origin wherever it renders.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not compare against "the case the analyst was last looking at".
 * There is no persisted active case, and inventing one from UI state would be
 * the precise fabrication this closes: the case on screen is not evidence of
 * where data came from. It reports the snapshot's OWN recorded `caseId`, or
 * says plainly that there isn't one.
 */

export function SnapshotProvenanceLine({
  caseId,
  truncation,
}: {
  caseId?: string | null;
  truncation?: SnapshotTruncation;
}) {
  return (
    <>
      {caseId ? (
        <Badge className="h-4 rounded-none border border-console-blue/30 bg-console-blue/10 px-1 text-[8px] uppercase text-console-blue">
          <FolderOpen className="mr-0.5 size-2.5" />
          Case {caseId}
        </Badge>
      ) : (
        // Absence is reported as absence. A snapshot with no case is a real,
        // legitimate state (a Recon run), not a defect — but it is never
        // allowed to read as belonging to whatever case is open elsewhere.
        <Badge
          className="h-4 rounded-none border border-console-amber/30 bg-console-amber/10 px-1 text-[8px] uppercase text-console-amber"
          title="This snapshot records no case. It came from a Recon run or predates case scoping, and is not attributed to any case."
        >
          <HelpCircle className="mr-0.5 size-2.5" />
          Not case-scoped
        </Badge>
      )}
      {truncation?.truncated && (
        <Badge
          className="h-4 rounded-none border border-console-amber/30 bg-console-amber/10 px-1 text-[8px] uppercase text-console-amber"
          title={`The run produced ${truncation.totalRecords} records; ${truncation.storedRecords} were stored. A capped snapshot must not read as a complete one.`}
        >
          <Scissors className="mr-0.5 size-2.5" />
          Capped {truncation.storedRecords}/{truncation.totalRecords}
        </Badge>
      )}
    </>
  );
}
