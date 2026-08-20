/**
 * IVRE adapter — self-hosted network reconnaissance data.
 *
 * WHY IVRE AND NOT SHODAN. Shodan's paid search API cannot be made free: the
 * product *is* their proprietary scan dataset, and nothing self-hosted
 * replicates it. IVRE is the honest alternative — an open-source framework that
 * stores and queries scan results you generated yourself. It has no quota
 * because there is no vendor: the data is yours, and it covers exactly the
 * hosts you were authorised to scan and nothing else.
 *
 * That last clause is the whole point, and it is why this file is the only
 * collector in the codebase that cannot run on the analyst's say-so.
 *
 * THIS IS THE FIRST NON-PASSIVE COLLECTOR IN SENTINEL.
 *
 * Every other Module 2 collector reads a third-party record *about* a target —
 * Certificate Transparency, RDAP, Shodan InternetDB — and never sends the target
 * a packet. `recon-sources.ts` opens by calling that property "load-bearing",
 * because it is what makes those collectors usable with no engagement
 * authorisation. IVRE's data comes from Nmap. Packets reach the target.
 *
 * So **every call here passes through `assertScanAuthorised()` first**
 * (`scan-authorization.ts`), which denies by default, requires a named
 * authorising officer and a written reference, enforces a mandatory expiry, and
 * refuses RFC1918/loopback/link-local addresses unless explicitly opted in.
 * There is deliberately no bypass flag and no "just this once" path: a gate with
 * an override is a suggestion.
 *
 * READ VERSUS SCAN. `execute()` only ever READS results already in the IVRE
 * database. Launching a new scan is a separate, separately-authorised action and
 * is not implemented here — an adapter that could start scans as a side effect
 * of an investigation is precisely how an unauthorised scan happens by accident.
 *
 * FRAMING OF THE OUTPUT. Port and service findings are reported as an
 * **unverified candidate for analyst review**, matching how this project already
 * frames `/ai/detect` (Grounding DINO's confident false positives) and EXIF GPS.
 * A service banner is what a host claimed at scan time, not proof of what runs
 * there now — the scan may be days old and banners are trivially forged.
 *
 * API SHAPE IS UNVERIFIED. IVRE's HTTP layer (`/cgi/scans`, `/cgi/view`) is
 * addressed here from documentation-level knowledge, with no live instance to
 * check against — the same honest caveat `theharvester.ts` and `spiderfoot.ts`
 * carry. The parser is defensive, so a wrong field name degrades to "not
 * reported" rather than throwing, which means a mismatch fails QUIETLY. Verify
 * against a running instance before trusting a result.
 */

import { CollectorError, collectorUnavailable } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";
import type { ScanAuditEntry, ScanAuthorisation } from "../../scan-authorization";
import {
  ScanNotAuthorisedError,
  assertScanAuthorised,
  scanAuditEntry,
} from "../../scan-authorization";

const TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 8_000;
const MAX_HOSTS = 200;

export interface IvrePort {
  port: number;
  protocol: string;
  state: string;
  /** Service name IVRE recorded, or null when it recorded none. */
  service: string | null;
  /** Product/version banner as reported at scan time. null when absent. */
  product: string | null;
}

export interface IvreHost {
  addr: string;
  hostnames: string[];
  ports: IvrePort[];
  /**
   * When this host was last SCANNED, as IVRE recorded it. Null when it carried
   * no timestamp — never defaulted to the collection time, because "we scanned
   * this a year ago" and "we scanned this just now" are different findings.
   */
  lastSeen: string | null;
}

export interface IvreRaw {
  target: string;
  hosts: IvreHost[];
  /** The authorisation that permitted this read. Travels with the result. */
  audit: ScanAuditEntry;
}

function baseUrlFromEnv(): string | null {
  const url = process.env.IVRE_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

/**
 * Authorisation records, from the environment.
 *
 * Stored as JSON rather than a file path so a deployment that never sets it has
 * literally no authorisations and therefore scans nothing — the safe default is
 * the empty one. A parse failure yields an empty list, not a permissive one:
 * malformed configuration must never widen permission.
 */
export function readScanAuthorisations(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = console.warn,
): ScanAuthorisation[] {
  const raw = env.SCAN_AUTHORISATIONS?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      warn("scan-authorization: SCAN_AUTHORISATIONS is not a JSON array. No target is authorised.");
      return [];
    }
    return parsed.filter(
      (r): r is ScanAuthorisation =>
        !!r &&
        typeof r === "object" &&
        typeof (r as ScanAuthorisation).target === "string" &&
        typeof (r as ScanAuthorisation).authorisedBy === "string" &&
        typeof (r as ScanAuthorisation).reference === "string" &&
        typeof (r as ScanAuthorisation).expiresAt === "string" &&
        ((r as ScanAuthorisation).scope === "active" ||
          (r as ScanAuthorisation).scope === "passive"),
    );
  } catch {
    warn(
      "scan-authorization: SCAN_AUTHORISATIONS is not valid JSON. No target is authorised — a " +
        "malformed authorisation list is treated as empty, never as permissive.",
    );
    return [];
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseIvrePorts(value: unknown): IvrePort[] {
  if (!Array.isArray(value)) return [];
  const out: IvrePort[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const port = Number(record.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) continue;
    out.push({
      port,
      protocol: asString(record.protocol) || "tcp",
      state: asString(record.state_state) || asString(record.state) || "unknown",
      service: asString(record.service_name) || null,
      product: asString(record.service_product) || null,
    });
  }
  return out;
}

export function parseIvreHosts(value: unknown): IvreHost[] {
  if (!Array.isArray(value)) return [];
  const out: IvreHost[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const addr = asString(record.addr);
    if (!addr) continue;
    const hostnames = Array.isArray(record.hostnames)
      ? record.hostnames
          .map((h) =>
            h && typeof h === "object" ? asString((h as Record<string, unknown>).name) : asString(h),
          )
          .filter((h) => h !== "")
      : [];
    out.push({
      addr,
      hostnames,
      ports: parseIvrePorts(record.ports),
      lastSeen: asString(record.endtime) || asString(record.starttime) || null,
    });
  }
  return out;
}

export const ivreCollector: Collector<IvreRaw> = {
  id: "ivre",
  name: "IVRE (self-hosted scan data)",
  category: "infrastructure",
  supportedTargetTypes: ["ip", "domain"],
  requiresCredentials: false,
  /** Rule 5: everything else must still work when this is absent. */
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<IvreRaw>> {
    const clock = startExecution();
    const base = baseUrlFromEnv();
    if (!base) {
      const err = collectorUnavailable(
        "ivre",
        "IVRE_URL is not configured — no IVRE instance is running for this environment.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    // ─── THE GATE. Nothing below this line runs unauthorised. ───────────────
    let authorisation: ScanAuthorisation;
    try {
      authorisation = assertScanAuthorised(
        target.value,
        readScanAuthorisations(),
        Date.now(),
        "active",
      );
    } catch (err) {
      if (err instanceof ScanNotAuthorisedError) {
        // Its own reason, verbatim: the operator needs to know WHICH of the
        // three refusal causes applied, because they need different responses.
        const refusal = new CollectorError("ivre", "invalid-target", err.message, err);
        return { execution: finishExecution(clock, "failed", 0, refusal.toInfo()), raw: null };
      }
      throw err;
    }

    const audit = scanAuditEntry(target.value, authorisation, "ivre", Date.now());
    // No audit sink exists in this build yet, so the record is logged and also
    // travels on the result. Stated rather than implied: this is not durable.
    console.info("[scan-audit]", JSON.stringify(audit));

    const url = `${base}/cgi/view?q=${encodeURIComponent(audit.target)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const classified = classifyError("ivre", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }

    if (!res.ok) {
      const err = new CollectorError(
        "ivre",
        res.status === 429 ? "rate-limited" : "upstream-error",
        `IVRE returned HTTP ${res.status} for ${audit.target}.`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const json = await res.json().catch(() => null);
    if (json === null) {
      const err = new CollectorError(
        "ivre",
        "upstream-error",
        "IVRE responded with a payload that could not be read as JSON.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const hosts = parseIvreHosts(json).slice(0, MAX_HOSTS);
    const raw: IvreRaw = { target: audit.target, hosts, audit };
    const count = hosts.reduce((n, h) => n + h.ports.length, 0);
    return { execution: finishExecution(clock, "completed", count), raw };
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const raw = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const entities: CollectorEntity[] = [];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const host of raw.hosts) {
      const ipId = `ivre:ip:${host.addr}`;
      if (!entities.some((e) => e.id === ipId)) {
        entities.push({
          id: ipId,
          type: "ip",
          value: host.addr,
          displayName: host.addr,
          source: "ivre",
          confidence: UNSCORED,
          metadata: host.lastSeen ? { lastScanned: host.lastSeen } : {},
        });
      }

      for (const hostname of host.hostnames) {
        const domainId = `ivre:domain:${hostname}`;
        if (!entities.some((e) => e.id === domainId)) {
          entities.push({
            id: domainId,
            type: "domain",
            value: hostname,
            displayName: hostname,
            source: "ivre",
            confidence: UNSCORED,
            metadata: {},
          });
        }
        relationships.push({
          sourceEntity: domainId,
          relationshipType: "RESOLVES_TO",
          targetEntity: ipId,
          confidence: {
            value: null,
            reasons: ["IVRE-recorded at scan time, not independently re-resolved"],
          },
          source: "ivre",
        });
      }

      for (const port of host.ports) {
        evidence.push({
          source: "IVRE (self-hosted scan data)",
          sourceUrl: null,
          collector: "ivre",
          collectedAt,
          rawValue: port,
          normalizedValue: {
            address: host.addr,
            port: port.port,
            protocol: port.protocol,
            state: port.state,
            service: port.service,
            product: port.product,
            scannedAt: host.lastSeen,
          },
          confidence: null,
          metadata: {
            // Provenance of the permission, carried with the evidence itself.
            authorisationReference: raw.audit.reference,
            authorisedBy: raw.audit.authorisedBy,
          },
        });
      }
    }

    const warnings: string[] = [
      "IVRE reports what a host answered WHEN IT WAS SCANNED, which may be days or months ago. " +
        "Service banners are self-reported by the host and are trivially forged. Treat every port " +
        "and service below as an unverified candidate for analyst review, not a confirmed finding.",
    ];
    if (raw.hosts.length === 0) {
      warnings.push(
        `IVRE holds no scan record for ${raw.target}. That is an absence of DATA, not a finding ` +
          `that the host has no open ports — it may simply never have been scanned.`,
      );
    }
    if (raw.hosts.some((h) => h.lastSeen === null)) {
      warnings.push(
        "At least one host carried no scan timestamp, so the age of its data is unknown.",
      );
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: { target: raw.target, audit: raw.audit },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const base = baseUrlFromEnv();
    if (!base) {
      return { state: "unavailable", detail: "IVRE_URL is not configured.", checkedAt };
    }
    const authorisations = readScanAuthorisations();
    try {
      const res = await fetch(`${base}/cgi/config`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!res.ok) return { state: "degraded", detail: `HTTP ${res.status}`, checkedAt };
      if (authorisations.length === 0) {
        // Reachable but unusable, and saying "ready" would be a lie.
        return {
          state: "degraded",
          detail:
            "IVRE is reachable, but SCAN_AUTHORISATIONS is empty so every target is refused. " +
            "Active scanning requires a written authorisation naming the target, the authorising " +
            "officer and an expiry.",
          checkedAt,
        };
      }
      return {
        state: "ready",
        detail: `HTTP ${res.status}; ${authorisations.length} scan authorisation(s) configured.`,
        checkedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "unavailable", detail: message, checkedAt };
    }
  },
};
