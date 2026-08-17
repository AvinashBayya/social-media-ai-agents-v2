/**
 * SpiderFoot adapter — OSINT-INTEGRATION-PLAN.md §14.
 *
 * **Same status as `theharvester.ts`: this is a client for a worker that
 * does not exist in this deployment.** `SPIDERFOOT_WORKER_URL` is unset by
 * default, and `execute()` reports `unavailable` when it is — the honest
 * current state, not a placeholder. Standing up a SpiderFoot instance
 * (its own long-running server process, needing a host to run continuously
 * on — genuinely different from theHarvester's one-shot CLI) is real
 * infrastructure work, not attempted here. Plan §14: "SpiderFoot failure
 * must not prevent Sentinel from functioning" — `isOptional: true` plus the
 * orchestrator/job system already handling each collector's failure
 * independently satisfies this the same way it does for every other
 * `isOptional` collector.
 *
 * **"Worker" here means a running SpiderFoot instance itself, not a custom
 * wrapper.** Unlike theHarvester (a CLI tool with no HTTP interface of its
 * own, needing a wrapper built), SpiderFoot ships with its own web
 * server (`sf.py -l host:port`) exposing scan control and JSON results
 * directly — so `SPIDERFOOT_WORKER_URL` is expected to point at that
 * server, not at bespoke glue code. Plan §14's "SpiderFoot Worker" box is
 * that server; "independently restartable" is an operational property of
 * deploying it, not something this client-side file can enforce.
 *
 * **Scans take real time — minutes, not seconds — unlike every other
 * collector in this codebase**, which is why `execute()` here doesn't just
 * make one request: it starts a scan, then polls SpiderFoot's own status
 * endpoint until `FINISHED` (or an `ERROR-*` status, or its own bounded
 * wait elapses), then fetches results. `SPIDERFOOT_MAX_WAIT_MS` (default 2
 * minutes) is a real, documented simplification, not a hidden one — actual
 * SpiderFoot scans, especially non-passive ones, can run considerably
 * longer. A production integration would likely need the scan to survive
 * across multiple job-system polls rather than one blocking `execute()`
 * call; that decoupling is not built here.
 *
 * **Defaults to SpiderFoot's "passive" use-case**, not an active/intrusive
 * scan profile — consistent with this project's passive-only OSINT stance
 * elsewhere (`recon-sources.ts`'s own header, plan §26's Nmap caution about
 * needing explicit authorization for anything active).
 *
 * **API shape (`/startscan`, `/scanstatus`, `/scaneventresults`, the event
 * JSON's field names, the `usecase` param) is from training-time knowledge
 * of SpiderFoot, not verified against a live instance** — same caveat as
 * `theharvester.ts`'s JSON parser, for the same reason (no live worker to
 * check it against). Reverify before trusting this with real data.
 */

import { CollectorError, collectorUnavailable } from "../errors";
import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
  EntityType,
} from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";
import { toHostname } from "../../attack-surface";

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 120_000;

/** Passive: reads third-party records about the target, never contacts it directly. See the file header. */
const DEFAULT_USE_CASE = "passive";

const TERMINAL_STATUSES = new Set(["FINISHED", "ABORTED"]);

function isErrorStatus(status: string): boolean {
  return status.startsWith("ERROR");
}

interface SpiderFootEvent {
  type: string;
  data: string;
  module: string;
  source: string | null;
}

export interface SpiderFootRaw {
  target: string;
  scanId: string;
  status: string;
  events: SpiderFootEvent[];
}

function workerUrlFromEnv(): string | null {
  const url = process.env.SPIDERFOOT_WORKER_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`SpiderFoot worker request failed: ${message}`);
  }
  if (res.status === 429) {
    throw new Error(`SpiderFoot worker rate-limited the request (HTTP 429). Wait and retry.`);
  }
  if (!res.ok) {
    throw new Error(`SpiderFoot worker returned HTTP ${res.status} for ${url}.`);
  }
  return res.json();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function startScan(workerUrl: string, target: string, useCase: string): Promise<string> {
  const json = await requestJson(`${workerUrl}/startscan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scanname: `sentinel-${target}`, scantarget: target, usecase: useCase }),
  });
  const record = asRecord(json);
  const scanId = record?.id ?? record?.scan_id;
  if (typeof scanId !== "string" || !scanId) {
    throw new Error("SpiderFoot worker did not return a scan id from /startscan.");
  }
  return scanId;
}

async function pollScanStatus(workerUrl: string, scanId: string): Promise<string> {
  const json = await requestJson(`${workerUrl}/scanstatus?id=${encodeURIComponent(scanId)}`);
  const record = asRecord(json);
  const status = record?.status;
  return typeof status === "string" && status ? status : "UNKNOWN";
}

async function fetchScanEvents(workerUrl: string, scanId: string): Promise<SpiderFootEvent[]> {
  const json = await requestJson(
    `${workerUrl}/scaneventresults?id=${encodeURIComponent(scanId)}&eventType=ALL`,
  );
  if (!Array.isArray(json)) return [];
  return json
    .map(asRecord)
    .filter((e): e is Record<string, unknown> => e !== null)
    .map((e) => ({
      type: typeof e.type === "string" ? e.type : "UNKNOWN",
      data: typeof e.data === "string" ? e.data : "",
      module: typeof e.module === "string" ? e.module : "unknown",
      source: typeof e.source === "string" ? e.source : null,
    }))
    .filter((e) => e.data !== "");
}

async function runScan(
  workerUrl: string,
  target: string,
  pollIntervalMs: number,
  maxWaitMs: number,
): Promise<SpiderFootRaw> {
  const useCase = process.env.SPIDERFOOT_USE_CASE?.trim() || DEFAULT_USE_CASE;
  const scanId = await startScan(workerUrl, target, useCase);

  const deadline = Date.now() + maxWaitMs;
  let status = "STARTING";
  while (Date.now() < deadline) {
    status = await pollScanStatus(workerUrl, scanId);
    if (TERMINAL_STATUSES.has(status) || isErrorStatus(status)) break;
    await sleep(pollIntervalMs);
  }

  if (isErrorStatus(status)) {
    throw new Error(`SpiderFoot scan ${scanId} for ${target} failed with status ${status}.`);
  }
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(
      `SpiderFoot scan ${scanId} for ${target} did not finish within ${maxWaitMs}ms (last status: ${status}).`,
    );
  }

  const events = await fetchScanEvents(workerUrl, scanId);
  return { target, scanId, status, events };
}

/**
 * A deliberately partial map of SpiderFoot's several hundred event types to
 * the common entity model — every type SpiderFoot can emit is not worth
 * covering here (many have no fit in §19's fixed entity vocabulary). An
 * unmapped type still becomes evidence, never silently dropped; it just
 * doesn't get its own entity.
 */
const EVENT_TYPE_TO_ENTITY: Record<string, EntityType | undefined> = {
  EMAILADDR: "email",
  IP_ADDRESS: "ip",
  IPV6_ADDRESS: "ip",
  DOMAIN_NAME: "domain",
  DOMAIN_NAME_PARENT: "domain",
  INTERNET_NAME: "domain",
  PHONE_NUMBER: "phone",
  USERNAME: "username",
  HUMAN_NAME: "person",
  SOCIAL_MEDIA: "social_account",
  LINKED_URL_INTERNAL: "url",
  LINKED_URL_EXTERNAL: "url",
};

export const spiderFootCollector: Collector<SpiderFootRaw> = {
  id: "spiderfoot",
  name: "SpiderFoot (external worker)",
  category: "external",
  supportedTargetTypes: ["domain"],
  requiresCredentials: false,
  /** Plan §14: "SpiderFoot failure must not prevent Sentinel from functioning." No instance deployed by default — see the file header. */
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<SpiderFootRaw>> {
    const clock = startExecution();
    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      const err = collectorUnavailable(
        "spiderfoot",
        "SPIDERFOOT_WORKER_URL is not configured — no SpiderFoot instance is deployed for this environment.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const hostname = toHostname(target.value);
    if (!hostname) {
      const err = new CollectorError(
        "spiderfoot",
        "invalid-target",
        `Could not read a domain from "${target.value}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const pollIntervalMs = envInt("SPIDERFOOT_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
    const maxWaitMs = envInt("SPIDERFOOT_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS);

    try {
      const raw = await runScan(workerUrl, hostname, pollIntervalMs, maxWaitMs);
      return { execution: finishExecution(clock, "completed", raw.events.length), raw };
    } catch (err) {
      const classified = classifyError("spiderfoot", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const raw = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const targetId = `spiderfoot:domain:${raw.target}`;
    const entities: CollectorEntity[] = [
      {
        id: targetId,
        type: "domain",
        value: raw.target,
        displayName: raw.target,
        source: "spiderfoot",
        confidence: UNSCORED,
        metadata: { scanId: raw.scanId, status: raw.status },
      },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];
    const unmappedTypes = new Set<string>();

    for (const event of raw.events) {
      const entityType = EVENT_TYPE_TO_ENTITY[event.type];
      if (entityType) {
        const entityId = `spiderfoot:${entityType}:${event.data.toLowerCase()}`;
        if (!entities.some((e) => e.id === entityId)) {
          entities.push({
            id: entityId,
            type: entityType,
            value: event.data,
            displayName: event.data,
            source: "spiderfoot",
            confidence: UNSCORED,
            metadata: { module: event.module, spiderfootType: event.type },
          });
        }
        if (entityType === "email") {
          relationships.push({
            sourceEntity: targetId,
            relationshipType: "HAS_EMAIL",
            targetEntity: entityId,
            confidence: UNSCORED,
            source: "spiderfoot",
          });
        }
      } else {
        unmappedTypes.add(event.type);
      }

      evidence.push({
        source: `spiderfoot:${event.module}`,
        sourceUrl: event.source,
        collector: "spiderfoot",
        collectedAt,
        rawValue: event,
        normalizedValue: { type: event.type, data: event.data, module: event.module },
        confidence: null,
        metadata: {},
      });
    }

    const warnings: string[] = [];
    if (raw.events.length === 0) {
      warnings.push(`SpiderFoot scan ${raw.scanId} finished with zero events for ${raw.target}.`);
    }
    if (unmappedTypes.size > 0) {
      warnings.push(
        `${unmappedTypes.size} SpiderFoot event type(s) had no entity mapping and are evidence-only: ${[...unmappedTypes].sort().join(", ")}.`,
      );
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: {
        target: raw.target,
        scanId: raw.scanId,
        status: raw.status,
        eventCount: raw.events.length,
      },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      return {
        state: "unavailable",
        detail: "SPIDERFOOT_WORKER_URL is not configured.",
        checkedAt,
      };
    }
    try {
      const res = await fetch(`${workerUrl}/scanlist`, { signal: AbortSignal.timeout(5_000) });
      return res.ok
        ? { state: "ready", detail: `HTTP ${res.status}`, checkedAt }
        : { state: "degraded", detail: `HTTP ${res.status}`, checkedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "unavailable", detail: message, checkedAt };
    }
  },
};
