/**
 * contact.phone — Person Investigation collector.
 *
 * `libphonenumber-js` metadata only: valid/country/type, derived purely
 * from the number's own structure. Deliberately NO lookup of any kind — no
 * carrier database, no reverse lookup, no external call at all. This
 * matches PERSON-INVESTIGATION-ANALYSIS.md §9: no phone-parsing library was
 * a dependency before this collector, and no collector declared
 * `supportedTargetTypes: ["phone"]` at all — a phone-typed target used to
 * plan to zero collectors.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence } from "../result";
import { InvestigationResultSchema } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";

export interface ContactPhoneRaw {
  input: string;
  valid: boolean;
  country: string | null;
  type: string | null;
  e164: string | null;
}

export const contactPhoneCollector: Collector<ContactPhoneRaw> = {
  id: "contact.phone",
  name: "Contact — Phone metadata (libphonenumber)",
  category: "search",
  supportedTargetTypes: ["phone"],
  requiresCredentials: false,
  isOptional: false,

  capability: {
    sourceId: "contact.phone",
    name: "Contact — Phone metadata",
    collectionMode: "LOCAL_FILE_ANALYSIS",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: false,
    apiAvailable: false,
    notes:
      "libphonenumber-js metadata only, derived purely from the number's own structure. No carrier database, no reverse lookup, no external call at all.",
  },

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<ContactPhoneRaw>> {
    const clock = startExecution();
    const raw = target.value.trim();
    if (!raw) {
      const err = new CollectorError("contact.phone", "invalid-target", "No phone value supplied.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    try {
      const parsed = parsePhoneNumberFromString(raw);
      const result: ContactPhoneRaw = parsed
        ? {
            input: raw,
            valid: parsed.isValid(),
            country: parsed.country ?? null,
            // getType() needs extended metadata not always bundled — null is
            // "not determinable from this number's structure", not "not a phone".
            type: parsed.getType() ?? null,
            e164: parsed.number,
          }
        : { input: raw, valid: false, country: null, type: null, e164: null };
      return { execution: finishExecution(clock, "completed", 1), raw: result };
    } catch (err) {
      const classified = classifyError("contact.phone", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const parsed = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const phoneId = `contact.phone:phone:${parsed.input}`;
    const entities: CollectorEntity[] = [
      {
        id: phoneId,
        type: "phone",
        value: parsed.e164 ?? parsed.input,
        displayName: parsed.e164 ?? parsed.input,
        source: "contact.phone",
        // Structural validity, not corroboration by another source — stays
        // UNSCORED-shaped (null) so it never reads as cross-source confirmation.
        confidence: { value: null, reasons: ["structural validity only — not independently corroborated"] },
        metadata: { valid: parsed.valid, country: parsed.country, type: parsed.type },
      },
    ];
    const evidence: CollectorEvidence[] = [
      {
        source: "libphonenumber-js (offline metadata, no lookup)",
        sourceUrl: null,
        collector: "contact.phone",
        collectedAt,
        rawValue: parsed,
        normalizedValue: parsed,
        confidence: null,
        metadata: {},
      },
    ];

    const warnings: string[] = [];
    if (!parsed.valid) {
      warnings.push(
        `"${parsed.input}" did not parse as a structurally valid phone number — metadata is limited.`,
      );
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships: [],
      evidence,
      warnings,
      errors: [],
      metadata: { input: parsed.input },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    // No network dependency — this collector either has the library loaded
    // (it does, it's a direct import) or the whole app failed to build.
    return { state: "ready", detail: "Offline metadata parser — no external dependency to probe", checkedAt };
  },
};
