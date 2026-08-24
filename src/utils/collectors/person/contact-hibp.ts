/**
 * contact.hibp — Person Investigation collector.
 *
 * Have I Been Pwned breach-exposure check. Deliberately narrow, per the
 * task spec this was built against: returns ONLY a boolean exposure flag
 * plus a breach count — never breach names, dates, or any other breach
 * content, even though HIBP's own `breachedaccount` API returns full
 * breach objects by default. `normalize()` and `execute()` below discard
 * everything except `{ exposed, breachCount }` before it ever reaches
 * `rawValue`/`normalizedValue` — there is no code path in this file that
 * stores a breach name.
 *
 * Key-gated via `credential-vault.ts`'s "hibp" provider (added alongside
 * this collector — HIBP has no free tier, so `resolveCredential("hibp")`
 * returning null is the ordinary, expected state in every environment that
 * hasn't paid for a key, reported honestly as `no-credential`, never as
 * "zero breaches found").
 *
 * "Analyst-supplied email only": this collector is registered like any
 * other, but the Person Investigation UI must not auto-select it by
 * default the way the other collectors are — running a breach check is
 * itself a sensitive act on the subject's data, distinct from passively
 * reading what's already public. See the collector-selection UI in
 * `osint.tsx`'s Person panel for where that default lives.
 */

import { recordCredentialUse, resolveCredential } from "../../credential-vault";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";

const HIBP_TIMEOUT_MS = 10_000;

/** Deliberately just this — see the file header. Never add a `breaches: string[]` field here. */
export interface ContactHibpRaw {
  email: string;
  exposed: boolean;
  breachCount: number;
}

export const contactHibpCollector: Collector<ContactHibpRaw> = {
  id: "contact.hibp",
  name: "Contact — HaveIBeenPwned (exposure flag only)",
  category: "search",
  supportedTargetTypes: ["email"],
  requiresCredentials: true,
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<ContactHibpRaw>> {
    const clock = startExecution();
    const email = target.value.trim();
    if (!email) {
      const err = new CollectorError("contact.hibp", "invalid-target", "No email value supplied.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const cred = await resolveCredential("hibp");
    if (!cred) {
      const err = new CollectorError(
        "contact.hibp",
        "no-credential",
        "No HIBP API key configured (HIBP_API_KEY, or add one on the Settings page). HIBP has " +
          "no free tier — this is the one Person Investigation collector that genuinely needs " +
          "a paid key. No exposure check was run; this is a missing credential, not a finding " +
          "that the email is unexposed.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    try {
      const res = await fetch(
        `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
        {
          headers: { "hibp-api-key": cred.secret, "user-agent": "SentinelAI-PersonInvestigation" },
          signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
        },
      );
      await recordCredentialUse("hibp", cred.entryId);

      if (res.status === 404) {
        // HIBP's documented "not found in any breach" response.
        return {
          execution: finishExecution(clock, "completed", 1),
          raw: { email, exposed: false, breachCount: 0 },
        };
      }
      if (res.status === 429) {
        const err = new CollectorError("contact.hibp", "rate-limited", "HIBP rate-limited this request (HTTP 429).");
        return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
      }
      if (res.status === 401) {
        const err = new CollectorError("contact.hibp", "no-credential", "HIBP rejected the API key (HTTP 401).");
        return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
      }
      if (!res.ok) {
        const err = new CollectorError("contact.hibp", "upstream-error", `HIBP returned HTTP ${res.status}.`);
        return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
      }

      // `truncateResponse=true` already limits the payload to breach names,
      // but even that name list is discarded here — only the count survives.
      const body: unknown = await res.json();
      const breachCount = Array.isArray(body) ? body.length : 0;
      return {
        execution: finishExecution(clock, "completed", 1),
        raw: { email, exposed: breachCount > 0, breachCount },
      };
    } catch (err) {
      const classified = classifyError("contact.hibp", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const r = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const emailId = `contact.hibp:email:${r.email.toLowerCase()}`;
    const entities: CollectorEntity[] = [
      {
        id: emailId,
        type: "email",
        value: r.email,
        displayName: r.email,
        source: "contact.hibp",
        confidence: UNSCORED,
        metadata: { exposed: r.exposed, breachCount: r.breachCount },
      },
    ];
    const evidence: CollectorEvidence[] = [
      {
        source: "Have I Been Pwned",
        sourceUrl: "https://haveibeenpwned.com/",
        collector: "contact.hibp",
        collectedAt,
        // Deliberately just { exposed, breachCount } — see file header.
        rawValue: { exposed: r.exposed, breachCount: r.breachCount },
        normalizedValue: { exposed: r.exposed, breachCount: r.breachCount },
        confidence: null,
        metadata: {},
      },
    ];

    return InvestigationResultSchema.parse({
      entities,
      relationships: [],
      evidence,
      warnings: r.exposed
        ? [`This email appears in ${r.breachCount} known breach(es) — exposure flag only, no breach details retained.`]
        : [],
      errors: [],
      metadata: { email: r.email },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const cred = await resolveCredential("hibp");
    if (!cred) {
      return { state: "no-credential", detail: "HIBP_API_KEY is not configured (no free tier).", checkedAt };
    }
    return { state: "ready", detail: "HIBP API key is configured.", checkedAt };
  },
};
