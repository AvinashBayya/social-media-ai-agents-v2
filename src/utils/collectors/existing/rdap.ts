/**
 * RDAP adapter — OSINT-INTEGRATION-PLAN.md §5 "DNS/RDAP" (RDAP half) / §31 P1.
 *
 * Unlike the other adapters in this directory, this is NOT a wrap of an
 * existing exported utility function — the project's only RDAP lookup lives
 * inline inside `routes/news.tsx`'s `fetchOSINT` handler, un-exported and
 * coupled to that route's own state, the same anti-pattern the header
 * comment in `src/utils/recon-sources.ts` documents crt.sh having had before
 * it was extracted. Extracting it would mean editing a route file, which
 * this pass deliberately avoids (plan Rule 4).
 *
 * This queries the same free, keyless `rdap.org` endpoint `news.tsx` already
 * validated works, using the same field-extraction approach (registrar via
 * `entities[].roles.includes("registrar")` → vcard `fn` → `handle`; created/
 * expiration via `events[]`; nameservers via `nameservers[].ldhName`) — so
 * it is a second, independently-testable implementation of the identical
 * technique, not a novel one. `routes/news.tsx`'s own WHOIS tab is untouched
 * and keeps working exactly as it did.
 */

import { toHostname } from "../../attack-surface";
import { CollectorError } from "../errors";
import type { CollectorEvidence } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

const RDAP_TIMEOUT_MS = 10_000;

export interface RdapRaw {
  domain: string;
  registered: boolean;
  registrar: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  nameservers: string[];
  payload: unknown;
}

/** Narrows one array element to a plain object so its fields can be read without `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractRegistrar(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  const registrarEntity = entities
    .map(asRecord)
    .find((e) => Array.isArray(e?.roles) && (e!.roles as unknown[]).includes("registrar"));
  if (!registrarEntity) return null;

  const vcard = Array.isArray(registrarEntity.vcardArray) ? registrarEntity.vcardArray[1] : null;
  if (Array.isArray(vcard)) {
    const fn = vcard
      .map((row) => (Array.isArray(row) ? row : null))
      .find((row) => row?.[0] === "fn");
    if (fn && typeof fn[3] === "string" && fn[3].trim()) return fn[3].trim();
  }
  if (typeof registrarEntity.handle === "string" && registrarEntity.handle.trim()) {
    return registrarEntity.handle.trim();
  }
  return null;
}

function extractEventDate(events: unknown, action: string): string | null {
  if (!Array.isArray(events)) return null;
  const event = events.map(asRecord).find((e) => e?.eventAction === action);
  const eventDate = event?.eventDate;
  return typeof eventDate === "string" && eventDate.trim() ? eventDate : null;
}

function extractNameservers(nameservers: unknown): string[] {
  if (!Array.isArray(nameservers)) return [];
  return nameservers
    .map(asRecord)
    .map((ns) => (typeof ns?.ldhName === "string" ? ns.ldhName.trim().toLowerCase() : null))
    .filter((v): v is string => Boolean(v));
}

async function queryRdap(domain: string): Promise<RdapRaw> {
  let res: Response;
  try {
    res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json" },
      signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`RDAP request failed for ${domain}: ${message}`);
  }

  if (res.status === 404) {
    return {
      domain,
      registered: false,
      registrar: null,
      createdAt: null,
      expiresAt: null,
      nameservers: [],
      payload: null,
    };
  }
  if (res.status === 429) {
    throw new Error(`RDAP rate-limited the request for ${domain} (HTTP 429). Wait and retry.`);
  }
  if (!res.ok) {
    throw new Error(`RDAP returned HTTP ${res.status} for ${domain}.`);
  }

  const json: unknown = await res.json();
  const record = asRecord(json);
  return {
    domain,
    registered: true,
    registrar: extractRegistrar(record?.entities),
    createdAt: extractEventDate(record?.events, "registration"),
    expiresAt: extractEventDate(record?.events, "expiration"),
    nameservers: extractNameservers(record?.nameservers),
    payload: json,
  };
}

export const rdapCollector: Collector<RdapRaw> = {
  id: "rdap",
  name: "RDAP (rdap.org)",
  category: "infrastructure",
  supportedTargetTypes: ["domain"],
  requiresCredentials: false,
  isOptional: false,

  capability: {
    sourceId: "rdap",
    name: "RDAP",
    collectionMode: "PASSIVE_API",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: false,
    apiAvailable: true,
    notes: "Registry records held by the registrar. No contact with the target.",
  },

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<RdapRaw>> {
    const clock = startExecution();
    const hostname = toHostname(target.value);
    if (!hostname) {
      const err = new CollectorError(
        "rdap",
        "invalid-target",
        `Could not read a domain from "${target.value}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }
    try {
      const record = await queryRdap(hostname);
      return { execution: finishExecution(clock, "completed", 1), raw: record };
    } catch (err) {
      const classified = classifyError("rdap", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const record = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const domainId = `rdap:domain:${record.domain}`;
    const evidence: CollectorEvidence[] = [
      {
        source: "RDAP (rdap.org)",
        sourceUrl: `https://rdap.org/domain/${encodeURIComponent(record.domain)}`,
        collector: "rdap",
        collectedAt,
        rawValue: record.payload,
        normalizedValue: {
          registered: record.registered,
          registrar: record.registrar,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          nameservers: record.nameservers,
        },
        confidence: null,
        metadata: {},
      },
    ];

    const warnings: string[] = [];
    if (!record.registered) warnings.push(`${record.domain} is not registered (RDAP 404).`);
    else if (!record.registrar)
      warnings.push(`${record.domain}: RDAP record present but no registrar entity reported.`);

    return InvestigationResultSchema.parse({
      entities: [
        {
          id: domainId,
          type: "domain",
          value: record.domain,
          displayName: record.domain,
          source: "rdap",
          confidence: UNSCORED,
          metadata: {
            registered: record.registered,
            registrar: record.registrar,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            nameservers: record.nameservers,
          },
        },
      ],
      relationships: [],
      evidence,
      warnings,
      errors: [],
      metadata: { domain: record.domain },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await queryRdap("github.com");
      return { state: "ready", detail: "rdap.org answered a known-good domain", checkedAt };
    } catch (err) {
      return { state: "unavailable", detail: classifyError("rdap", err).message, checkedAt };
    }
  },
};
