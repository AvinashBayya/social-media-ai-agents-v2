/**
 * Query planner — OSINT-INTEGRATION-PLAN.md §10.
 *
 * Turns a raw target string into an execution plan: what type of thing it
 * looks like, and which registered collectors apply. Deliberately synchronous
 * and I/O-free — it only reads the registry's already-registered collector
 * metadata (`supportedTargetTypes`/`isOptional`/`requiresCredentials`), never
 * calls a collector or checks a live credential. Verifying a `requiresCredentials`
 * collector's credential is actually configured is async I/O (the same shape
 * of work `collector-health.ts` already does elsewhere) and is out of scope
 * for a planning step that must stay fast and side-effect-free.
 *
 * Plan §10's six responsibilities, and where each lives here:
 *   1. Detect target type       → `detectTargetType()`
 *   2. Available input fields   → not yet meaningful: P1 collectors take one
 *                                  target string each, not the multi-field
 *                                  form §22 sketches (city/email/username/
 *                                  domain alongside a name) — that form isn't
 *                                  built yet (P2 UI).
 *   3. Select collectors        → `registry.findByTargetType()` per candidate type
 *   4. Avoid irrelevant ones    → falls out of (3): a domain-only collector
 *                                  never matches a "person" target type
 *   5. Free-resource policy     → every P1 collector is free/keyless already;
 *                                  nothing to filter yet (see §24) — the hook
 *                                  exists (`excluded`) for when a paid-tier
 *                                  collector is ever added
 *   6. Safety/authorization     → same: no collector needs it yet (Nmap, when
 *                                  it exists, is where this becomes real — §26)
 */

import type { CollectorRegistry } from "../collectors/registry";
import { collectorRegistry } from "../collectors/registry";
import type { TargetType } from "../collectors/types";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

function isIpv4(value: string): boolean {
  const m = value.match(IPV4_RE);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

export interface DetectionResult {
  /** Best single guess. */
  primaryType: TargetType;
  /**
   * Other plausible types collectors may also match against. Non-empty only
   * for genuinely ambiguous input (a bare word is a plausible username AND
   * a plausible mononym; free text is a plausible person-name search AND a
   * plausible username query) — never guessed away to a single type when
   * the input doesn't actually disambiguate it.
   */
  alternateTypes: TargetType[];
}

/**
 * Deterministic, precedence-ordered pattern match — an unambiguous shape
 * (IP, URL, email, domain, phone) wins outright; anything left over is
 * genuinely ambiguous between "person" and "username" and is returned as
 * both rather than picked arbitrarily.
 */
export function detectTargetType(rawInput: string): DetectionResult {
  const input = rawInput.trim();
  if (!input) return { primaryType: "person", alternateTypes: [] };

  if (isIpv4(input)) return { primaryType: "ip", alternateTypes: [] };
  if (URL_RE.test(input)) return { primaryType: "url", alternateTypes: ["domain"] };
  if (EMAIL_RE.test(input)) return { primaryType: "email", alternateTypes: [] };
  if (!input.includes(" ") && DOMAIN_RE.test(input))
    return { primaryType: "domain", alternateTypes: [] };
  if (PHONE_RE.test(input) && input.replace(/\D/g, "").length >= 7) {
    return { primaryType: "phone", alternateTypes: [] };
  }
  if (!input.includes(" ") && input.length <= 30) {
    return { primaryType: "username", alternateTypes: ["person"] };
  }
  return { primaryType: "person", alternateTypes: ["username"] };
}

export interface PlannedCollector {
  collectorId: string;
  /** Which of the detected candidate types this collector was matched on. */
  targetType: TargetType;
  isOptional: boolean;
  requiresCredentials: boolean;
  reason: string;
}

export interface OsintPlan {
  input: string;
  detected: DetectionResult;
  collectors: PlannedCollector[];
  /** Matched-by-type but not planned, and why. Empty for every P1 collector today — see the file header. */
  excluded: { collectorId: string; reason: string }[];
}

export function planInvestigation(
  rawInput: string,
  registry: CollectorRegistry = collectorRegistry,
): OsintPlan {
  const input = rawInput.trim();
  const detected = detectTargetType(input);

  if (!input) {
    return { input, detected, collectors: [], excluded: [] };
  }

  const candidateTypes: TargetType[] = [detected.primaryType, ...detected.alternateTypes];
  const seen = new Set<string>();
  const collectors: PlannedCollector[] = [];

  for (const targetType of candidateTypes) {
    for (const collector of registry.findByTargetType(targetType)) {
      if (seen.has(collector.id)) continue;
      seen.add(collector.id);
      collectors.push({
        collectorId: collector.id,
        targetType,
        isOptional: collector.isOptional,
        requiresCredentials: collector.requiresCredentials,
        reason: collector.requiresCredentials
          ? `supports target type "${targetType}" (requires credentials — may still fail at execution if unconfigured)`
          : `supports target type "${targetType}"`,
      });
    }
  }

  return { input, detected, collectors, excluded: [] };
}
