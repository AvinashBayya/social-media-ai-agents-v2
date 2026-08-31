/**
 * Source capability matrix, server side — ported from a teammate's parallel fork
 * alongside `passive-policy.ts`, `wayback.ts` and `sherlock.ts`.
 *
 * Thin `createServerFn` wrapper over `capabilityMatrix()` in `passive-policy.ts`,
 * following the pattern the rest of this codebase uses: the logic lives in a plain
 * exported function that `bun test` can call directly, and the server function is
 * only the transport. Server functions cannot execute outside the Start runtime, so
 * keeping them thin is what keeps the logic testable.
 *
 * WHY A SERVER FUNCTION AND NOT A CLIENT-SIDE IMPORT. The capability declarations
 * are static data, so in principle the browser could read them — but reaching them
 * means importing every collector module, and those import `createServerFn` and
 * server-only utilities. Pulling that graph into the browser bundle is the failure
 * this project has already shipped twice (`bun:sqlite` in the client bundle, then in
 * an SSR chunk on the Node runtime). The registry stays server-side.
 *
 * ⚠️ `/crawlers` is precisely the route that returned HTTP 500 the last time a
 * module edge re-chunked something unloadable into it. The collector graph must be
 * checked in a REAL BROWSER against a REAL BUILD after any change here — `bun test`
 * and `tsc --noEmit` cannot see a bundling defect.
 *
 * `registerPersonCollectors()` is called here alongside the other two, matching
 * `orchestrator.ts`/`jobs.ts`'s own convention — it is a no-op unless
 * `PERSON_INVESTIGATION_ENABLED=true`, so the matrix shows the person/* collectors
 * only when that feature is actually active, never as dead rows.
 */

import { createServerFn } from "@tanstack/react-start";
import { collectorRegistry } from "./registry";
import { registerExistingCollectors } from "./existing";
import { registerExternalCollectors } from "./external";
import { registerPersonCollectors } from "./person";
import type { CapabilityMatrixRow } from "./passive-policy";
import { capabilityMatrix } from "./passive-policy";

export interface CapabilityReport {
  rows: CapabilityMatrixRow[];
  /** Counts, so a reader sees the shape of the estate without tallying rows themselves. */
  totals: {
    declared: number;
    passive: number;
    refused: number;
    activeCapableGated: number;
  };
  /**
   * Stated on the page. A matrix that lists only what is declared can read as a
   * complete inventory of what the system can reach, which it is not.
   */
  caveats: string[];
}

export const CAPABILITY_CAVEATS: string[] = [
  "This table describes what each collector DECLARES, not whether it is currently working. Live reachability comes from the probe above and is a separate measurement.",
  "A collector with no capability declaration is refused by the orchestrator and shown here as refused — absence of a declaration is never read as permission.",
  "Passive means this system sends the target nothing. It does not mean the upstream provider never did: provider datasets (Shodan InternetDB, IVRE) are records of someone else's earlier collection.",
];

/** Pure, directly testable. The server function below is only transport. */
export function buildCapabilityReport(): CapabilityReport {
  registerExistingCollectors();
  registerExternalCollectors();
  registerPersonCollectors();
  const rows = capabilityMatrix(collectorRegistry.list()).sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  );

  return {
    rows,
    totals: {
      declared: rows.length,
      passive: rows.filter((r) => r.passive).length,
      refused: rows.filter((r) => !r.passive).length,
      activeCapableGated: rows.filter((r) => r.activeCapable && r.authorisationGated).length,
    },
    caveats: CAPABILITY_CAVEATS,
  };
}

export const capabilityReport = createServerFn({ method: "GET" }).handler(async () => {
  return buildCapabilityReport();
});
