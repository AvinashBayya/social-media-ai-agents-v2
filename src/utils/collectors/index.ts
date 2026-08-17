/**
 * OSINT collector framework — barrel export.
 *
 * See docs/OSINT-INTEGRATION-PLAN.md. This is the P0 foundation only
 * (contract, result model, registry, errors) — no collector adapters are
 * registered here yet. That is P1 (§31 "P1 — Existing adapters").
 */

export * from "./types";
export * from "./result";
export * from "./errors";
export * from "./registry";
