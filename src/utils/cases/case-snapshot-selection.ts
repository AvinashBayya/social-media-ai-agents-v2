import { EVICTED_MESSAGE, caseSnapshotState, type CaseScopeVerdict, type CaseSnapshotState, type MaybeScoped } from "./case-scope";

/**
 * What a case selector on `/graph` and `/timeline` should actually render
 * (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A PURE FUNCTION AND NOT LOGIC INSIDE THE ROUTES.
 *
 * Case scoping closed the silent-contamination bug in the stores, then a
 * browser test found the same class of bug one route further out: `/graph`
 * read the last-write-wins slot and named no case, so an analyst on case A saw
 * case B's graph. The lesson is that the *decision* — show this, or say why
 * not — is the part worth testing, and it cannot be tested while it lives
 * inside a component that needs a DOM and a router.
 *
 * So both routes ask this function and render its answer. Two routes, one rule.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RULE, IN ONE SENTENCE.
 *
 * A selected case shows its OWN snapshot or an empty state — never another
 * case's, and never the unscoped slot as a stand-in.
 *
 * `getGraphForCase()` deliberately falls back to the unscoped slot and reports
 * the mismatch in its verdict, because the case *panel* needs to say "there is
 * something here and it is not yours". A case selector needs the opposite: the
 * analyst asked for case A, so anything that is not case A's is not an answer.
 * That is why this requires `verdict.result === "MATCH"` rather than merely a
 * non-null snapshot. The fallback is not silent either way — here it simply
 * isn't shown.
 */

/**
 * The sentinel selection meaning "the most recent run, whatever it was".
 *
 * A reserved string rather than `""` or `null`, because an empty selection is
 * indistinguishable from "nothing chosen yet" and this is a deliberate choice
 * the analyst makes. It cannot collide with a real id: `createInvestigation`
 * mints `INV-1001` upward.
 */
export const UNSCOPED_SELECTION = "__unscoped__";

export type SnapshotScope = "CASE" | "UNSCOPED";

export type SnapshotDisplay<T> =
  | {
      show: true;
      snapshot: T;
      /** Which slot it came from — NOT a claim about the snapshot's own provenance. */
      scope: SnapshotScope;
      /**
       * Set when the latest-run slot happens to hold a case run's snapshot.
       * Rendered as a note, because "Unscoped / Latest Recon" would otherwise
       * imply the data belongs to no case when its own metadata says it does.
       */
      note: string | null;
    }
  | {
      show: false;
      reason: string;
      /** WHY there is nothing, so the UI need not re-derive it from the wording. */
      state: CaseSnapshotState;
    };

/** Wording is fixed here so the two routes cannot drift apart. */
export function noSnapshotMessage(noun: "graph" | "timeline"): string {
  return `No ${noun} available for this case.`;
}

export function noUnscopedMessage(noun: "graph" | "timeline"): string {
  return `No ${noun} snapshot has been handed over yet.`;
}

/**
 * Decides what a selection renders.
 *
 * @param selection      `UNSCOPED_SELECTION`, or a case id.
 * @param scoped         The result of `getGraphForCase` / `getTimelineForCase`.
 *                       Ignored entirely when the selection is unscoped.
 * @param unscoped       The result of `readGraphSnapshot` / `readTimelineSnapshot`.
 * @param noun           Which message wording to use.
 */
export function resolveSnapshotSelection<T extends MaybeScoped>(
  selection: string,
  scoped: { snapshot: T | null; verdict: CaseScopeVerdict } | null,
  unscoped: T | null,
  noun: "graph" | "timeline",
  /**
   * Case ids the storage layer actually evicted. Optional, and an empty list is
   * not "nothing was evicted", it is "no eviction data supplied"; either way a
   * case falls back to the plain no-snapshot message, which understates what we
   * know rather than overstating it.
   */
  evicted: readonly string[] = [],
): SnapshotDisplay<T> {
  if (selection === UNSCOPED_SELECTION) {
    // The latest-run slot is not a case, so it is never "evicted" — it is
    // overwritten, and there is nothing to distinguish.
    if (!unscoped) return { show: false, reason: noUnscopedMessage(noun), state: "NO_SNAPSHOT" };
    // The latest-run slot is written by BOTH /recon and case runs, so it can
    // legitimately hold a case's snapshot. Say so rather than letting the option
    // label imply otherwise — the snapshot's own metadata is authoritative.
    const note = unscoped.caseId
      ? `This is the most recent run overall, and it belongs to case ${unscoped.caseId}. It is not filtered to a case.`
      : null;
    return { show: true, snapshot: unscoped, scope: "UNSCOPED", note };
  }

  // A named case. Only that case's own snapshot is an answer.
  if (!scoped || !scoped.snapshot || scoped.verdict.result !== "MATCH") {
    // Say WHY there is nothing. An evicted case and a never-run case both have
    // no key, and they call for opposite responses: one is a finding, the
    // other is a re-run. Note this branch is reached with another case's
    // snapshot sitting in `scoped.snapshot` behind a MISMATCH verdict — it is
    // still refused, evicted or not.
    return {
      show: false,
      reason: evicted.includes(selection) ? EVICTED_MESSAGE : noSnapshotMessage(noun),
      state: evicted.includes(selection) ? "EVICTED" : "NO_SNAPSHOT",
    };
  }
  return { show: true, snapshot: scoped.snapshot, scope: "CASE", note: null };
}

/** An option in the selector. Kept plain so the pure layer owns the list, not the component. */
export interface CaseSnapshotOption {
  value: string;
  label: string;
  /** True for the unscoped sentinel, so the UI can style/annotate it apart. */
  unscoped: boolean;
  /** Whether a snapshot exists for this option, so the analyst can see it before choosing. */
  hasSnapshot: boolean;
  /**
   * Why, when there is none. `hasSnapshot` is kept alongside it rather than
   * replaced: it is an existing export with existing callers, and
   * `state === "HAS_SNAPSHOT"` is exactly equivalent.
   */
  state: CaseSnapshotState;
}

/** Suffix shown in the native dropdown, which cannot carry a badge. */
export function optionSuffix(state: CaseSnapshotState): string {
  if (state === "HAS_SNAPSHOT") return "";
  if (state === "EVICTED") return " (evicted)";
  return " (case with no snapshot)";
}

/**
 * Builds the option list.
 *
 * **Cases with no snapshot are listed, not hidden.** Hiding them would make an
 * un-run case indistinguishable from a case that does not exist, and the
 * analyst would have no way to learn that the run never produced one. The
 * option carries `hasSnapshot: false` and the empty state explains it.
 */
export function buildSnapshotOptions(
  cases: Array<{ id: string; target: string }>,
  scopedCaseIds: string[],
  hasUnscoped: boolean,
  /** Case ids the storage layer actually evicted. Optional and additive. */
  evictedCaseIds: readonly string[] = [],
): CaseSnapshotOption[] {
  return [
    {
      value: UNSCOPED_SELECTION,
      label: "Unscoped / Latest Recon",
      unscoped: true,
      hasSnapshot: hasUnscoped,
      // The latest-run slot is overwritten, never evicted — there is no case to
      // attribute an eviction to.
      state: hasUnscoped ? "HAS_SNAPSHOT" : "NO_SNAPSHOT",
    },
    ...cases.map((c) => {
      const state = caseSnapshotState(c.id, scopedCaseIds, evictedCaseIds);
      return {
        value: c.id,
        label: `${c.id} — ${c.target}`,
        unscoped: false,
        hasSnapshot: state === "HAS_SNAPSHOT",
        state,
      };
    }),
  ];
}
