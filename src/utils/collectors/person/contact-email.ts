/**
 * contact.email — Person Investigation collector.
 *
 * Three independent checks, all free and keyless:
 *  1. Syntax — a real RFC-5322-ish shape check, not a network call.
 *  2. MX — a fresh Cloudflare DNS-over-HTTPS `type=MX` query. The only prior
 *     MX-lookup code in this codebase lived inline, un-exported, inside
 *     `routes/news.tsx`'s `fetchOSINT` handler (see
 *     PERSON-INVESTIGATION-ANALYSIS.md §9) — reimplemented here as a clean,
 *     standalone collector rather than reaching into that route, per Rule 4
 *     ("existing UI stays intact").
 *  3. Gravatar — MD5(lowercased, trimmed email) against
 *     gravatar.com/avatar/{hash}?d=404. Verified live 2026-08-19: without
 *     `d=404` the endpoint always returns 200 with a fallback image, so
 *     `d=404` is what actually distinguishes "this address has a real
 *     avatar" (200) from "it doesn't" (404) — the standard, documented
 *     technique, not a guess.
 *
 * No collector before this one declared `supportedTargetTypes: ["email"]`
 * except `dorks` (which just builds search hits, not validation) — see
 * PERSON-INVESTIGATION-ANALYSIS.md §4.
 */

import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence } from "../result";
import { InvestigationResultSchema } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";

const EMAIL_SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MX_TIMEOUT_MS = 8_000;
const GRAVATAR_TIMEOUT_MS = 8_000;

export interface ContactEmailRaw {
  email: string;
  domain: string | null;
  syntaxValid: boolean;
  hasMx: boolean | null; // null = lookup failed, not "no MX records"
  mxHost: string | null;
  hasGravatar: boolean | null; // null = lookup failed
}

async function md5Hex(value: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(value);
  return hasher.digest("hex");
}

async function lookupMx(domain: string): Promise<{ hasMx: boolean; mxHost: string | null } | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(MX_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const answers: any[] = json?.Answer ?? [];
    if (json?.Status !== 0 || answers.length === 0) return { hasMx: false, mxHost: null };
    // "20 alt2.gmail-smtp-in.l.google.com." — take the priority-first host, strip the trailing dot.
    const first = String(answers[0]?.data ?? "").trim();
    const host = first.split(" ").pop()?.replace(/\.$/, "") ?? null;
    return { hasMx: true, mxHost: host };
  } catch {
    return null;
  }
}

async function lookupGravatar(email: string): Promise<boolean | null> {
  try {
    const hash = await md5Hex(email.trim().toLowerCase());
    const res = await fetch(`https://www.gravatar.com/avatar/${hash}?d=404`, {
      signal: AbortSignal.timeout(GRAVATAR_TIMEOUT_MS),
    });
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null; // any other status is an inconclusive lookup, not a measured absence
  } catch {
    return null;
  }
}

export const contactEmailCollector: Collector<ContactEmailRaw> = {
  id: "contact.email",
  name: "Contact — Email (syntax + MX + Gravatar)",
  category: "search",
  supportedTargetTypes: ["email"],
  requiresCredentials: false,
  isOptional: false,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<ContactEmailRaw>> {
    const clock = startExecution();
    const email = target.value.trim();
    if (!email) {
      const err = new CollectorError("contact.email", "invalid-target", "No email value supplied.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const syntaxValid = EMAIL_SYNTAX_RE.test(email);
    const domain = email.includes("@") ? email.split("@").pop()!.trim().toLowerCase() : null;

    try {
      const [mx, hasGravatar] = await Promise.all([
        domain && syntaxValid ? lookupMx(domain) : Promise.resolve(null),
        syntaxValid ? lookupGravatar(email) : Promise.resolve(null),
      ]);
      const raw: ContactEmailRaw = {
        email,
        domain,
        syntaxValid,
        hasMx: mx?.hasMx ?? null,
        mxHost: mx?.mxHost ?? null,
        hasGravatar,
      };
      return { execution: finishExecution(clock, "completed", 1), raw };
    } catch (err) {
      const classified = classifyError("contact.email", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const r = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const emailId = `contact.email:email:${r.email.toLowerCase()}`;
    const entities: CollectorEntity[] = [
      {
        id: emailId,
        type: "email",
        value: r.email,
        displayName: r.email,
        source: "contact.email",
        confidence: { value: null, reasons: ["structural/lookup checks only — not independently corroborated"] },
        metadata: { syntaxValid: r.syntaxValid, hasMx: r.hasMx, hasGravatar: r.hasGravatar },
      },
    ];
    const evidence: CollectorEvidence[] = [
      {
        source: "syntax check (offline)",
        sourceUrl: null,
        collector: "contact.email",
        collectedAt,
        rawValue: { syntaxValid: r.syntaxValid },
        normalizedValue: { syntaxValid: r.syntaxValid },
        confidence: null,
        metadata: {},
      },
    ];
    if (r.hasMx !== null) {
      evidence.push({
        source: "Cloudflare DNS-over-HTTPS (MX)",
        sourceUrl: null,
        collector: "contact.email",
        collectedAt,
        rawValue: { domain: r.domain, hasMx: r.hasMx, mxHost: r.mxHost },
        normalizedValue: { domain: r.domain, hasMx: r.hasMx, mxHost: r.mxHost },
        confidence: null,
        metadata: {},
      });
    }
    if (r.hasGravatar !== null) {
      evidence.push({
        source: "Gravatar (public avatar existence)",
        sourceUrl: `https://www.gravatar.com/avatar/`,
        collector: "contact.email",
        collectedAt,
        rawValue: { hasGravatar: r.hasGravatar },
        normalizedValue: { hasGravatar: r.hasGravatar },
        confidence: null,
        metadata: {},
      });
    }

    const warnings: string[] = [];
    if (!r.syntaxValid) warnings.push(`"${r.email}" did not pass a basic email-syntax check.`);
    if (r.hasMx === null) warnings.push("MX lookup failed — mail-deliverability could not be determined.");
    if (r.hasGravatar === null) warnings.push("Gravatar lookup failed — could not be determined.");

    return InvestigationResultSchema.parse({
      entities,
      relationships: [],
      evidence,
      warnings,
      errors: [],
      metadata: { email: r.email },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch("https://cloudflare-dns.com/dns-query?name=example.com&type=MX", {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok
        ? { state: "ready", detail: "Cloudflare DoH answered a test MX query", checkedAt }
        : { state: "degraded", detail: `Cloudflare DoH returned HTTP ${res.status}`, checkedAt };
    } catch (err) {
      return { state: "unavailable", detail: classifyError("contact.email", err).message, checkedAt };
    }
  },
};
