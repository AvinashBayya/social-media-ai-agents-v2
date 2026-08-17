/**
 * OSINT orchestration layer — barrel export.
 *
 * See docs/OSINT-INTEGRATION-PLAN.md §10-12 + §17. Target detection,
 * planning, synchronous execution (`orchestrator.ts`), async/pollable
 * execution (`jobs.ts`) and cross-collector entity resolution
 * (`entity-resolution.ts`) are all here. `entity-resolution.ts` is opt-in —
 * call `resolveInvestigationEntities()` on an `Investigation`/
 * `InvestigationPoll` when semantic merging is wanted; neither
 * `orchestrator.ts` nor `jobs.ts` calls it automatically.
 */

export * from "./query-planner";
export * from "./merge";
export * from "./orchestrator";
export * from "./jobs";
export * from "./entity-resolution";
