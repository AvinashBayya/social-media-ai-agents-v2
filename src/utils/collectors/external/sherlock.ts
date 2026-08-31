/**
 * Sherlock adapter — ported from a teammate's parallel fork
 * (`social-media-ai-agents-2.3-main/`), which built this against a "Passive OSINT
 * Platform" spec this project's own `docs/` does not carry. Ported for the
 * collector itself, which stands on its own merits regardless of that spec's
 * adoption status here.
 *
 * **Read this before assuming Sherlock is "wired up."** Like `theharvester.ts`
 * and `spiderfoot.ts`, this is a CLIENT for a worker that is not deployed by
 * default. It calls `SHERLOCK_WORKER_URL` (unset unless the operator stands the
 * container up) and honestly reports `unavailable` otherwise.
 *
 * Sherlock is a Python CLI with no HTTP interface, exactly like theHarvester, so
 * the same thin FastAPI wrapper pattern applies. It is never subprocessed inside
 * Sentinel: the app holds no long-running process, and shelling out to a
 * third-party tool from the request path is the architecture this project
 * already rejected once.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE.
 *
 * **A Sherlock hit is not evidence that an account belongs to anyone.**
 *
 * All Sherlock does is ask "does a profile page exist at this platform's URL for
 * this handle?" A 200 answers that and nothing else. Handles collide constantly;
 * a handle resembling a person's name is not evidence they registered it; and a
 * squatted or impersonating account returns exactly the same 200 as a genuine
 * one.
 *
 * So the adapter splits the claim in two, and the split is visible in the data:
 *
 *   1. **The provider observation** — "a public profile exists at URL X for
 *      handle Y". That is a real measurement and carries a real confidence.
 *   2. **The identity relationship** — "this account belongs to the person under
 *      investigation". That is `UNSCORED` and rides a `CANDIDATE_ACCOUNT` edge,
 *      never `USES_USERNAME`. Sherlock contributes NO evidence toward it.
 *
 * `entity-resolution.ts` is what may later raise that second claim, if other
 * collectors independently supply a matching email, organisation, site or
 * biography. This adapter never does it, and never emits a `person` entity at
 * all — an entity that does not exist cannot be accidentally linked.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PASSIVE. Sherlock issues ordinary unauthenticated GETs to public profile URLs.
 * The worker refuses anything else: no login, no credential testing, no CAPTCHA
 * handling, no private-profile access.
 *
 * The response parser targets Sherlock's documented `--json` shape from
 * training-time knowledge, not a live instance — there is no deployed worker to
 * verify field names against. It is deliberately defensive: anything unexpected
 * degrades to "not reported" rather than throwing or inventing a value. **Verify
 * against a real worker before trusting the exact shape.**
 *
 * `claimClass`/`evidenceId` (the source fork's OBSERVED/DERIVED/CORRELATED/
 * INFERRED taxonomy and a per-evidence identifier) were NOT ported — both belong
 * to a larger, separate subsystem on `CollectorEvidence` this project's
 * `result.ts` does not have. `CANDIDATE_ACCOUNT` WAS ported onto
 * `RELATIONSHIP_TYPES` (additive, per that enum's own note) since the edge
 * itself needs no supporting subsystem and is the whole point of this file.
 */

import { CollectorError, collectorUnavailable } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";

const TIMEOUT_MS = 60_000;

/** One platform Sherlock reported a profile on. */
export interface SherlockHit {
  platform: string;
  url: string;
  /** HTTP status the worker observed, when it reported one. Null otherwise — never assumed 200. */
  httpStatus: number | null;
}

export interface SherlockRaw {
  username: string;
  hits: SherlockHit[];
  /** Platforms Sherlock could not check — timeouts, blocks, unreachable. Reported, never silently dropped. */
  errors: { platform: string; reason: string }[];
  /** How many platforms the worker attempted. Null when it did not say. */
  platformsChecked: number | null;
  /** True when the worker returned before finishing every platform. */
  partial: boolean;
}

// ─── Input ──────────────────────────────────────────────────────────────────

/**
 * Sherlock takes a handle, not a name.
 *
 * Refuses anything with whitespace or an @, rather than "helpfully" stripping it
 * into a guess. Turning "John Smith" into "johnsmith" invents a handle nobody
 * observed and then searches for it — the search would succeed somewhere, and
 * the result would look like a finding.
 */
export function normaliseUsername(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/\s/.test(value)) return null;
  if (value.includes("@")) return null;
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(value)) return null;
  return value;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads the worker's payload defensively.
 *
 * Sherlock's own JSON is keyed by platform name with a `status`/`url_user`
 * object per entry; the worker flattens that into `hits`. Both shapes are
 * tolerated so a worker-side change degrades rather than throws.
 */
export function parseSherlockPayload(json: unknown, username: string): SherlockRaw {
  const record = asRecord(json) ?? {};
  const hits: SherlockHit[] = [];
  const errors: { platform: string; reason: string }[] = [];

  const rawHits = Array.isArray(record.hits) ? record.hits : [];
  for (const entry of rawHits) {
    const hit = asRecord(entry);
    if (!hit) continue;
    const platform = typeof hit.platform === "string" ? hit.platform.trim() : "";
    const url = typeof hit.url === "string" ? hit.url.trim() : "";
    // A hit with no platform or no URL is not usable evidence — dropped rather
    // than rendered with a blank the analyst has to interpret.
    if (!platform || !/^https?:\/\//i.test(url)) continue;
    hits.push({
      platform,
      url,
      httpStatus: typeof hit.http_status === "number" ? hit.http_status : null,
    });
  }

  const rawErrors = Array.isArray(record.errors) ? record.errors : [];
  for (const entry of rawErrors) {
    const e = asRecord(entry);
    if (!e) continue;
    const platform = typeof e.platform === "string" ? e.platform.trim() : "";
    const reason = typeof e.reason === "string" ? e.reason.trim() : "";
    if (platform) errors.push({ platform, reason: reason || "not reported" });
  }

  return {
    username,
    // Deduplicated by platform: Sherlock occasionally lists a site twice under
    // aliases, and two rows for one platform would read as two findings.
    hits: dedupeByPlatform(hits),
    errors,
    platformsChecked:
      typeof record.platforms_checked === "number" ? record.platforms_checked : null,
    partial: record.partial === true,
  };
}

function dedupeByPlatform(hits: SherlockHit[]): SherlockHit[] {
  const seen = new Map<string, SherlockHit>();
  for (const h of hits) {
    const key = h.platform.toLowerCase();
    if (!seen.has(key)) seen.set(key, h);
  }
  return [...seen.values()].sort((a, b) => a.platform.localeCompare(b.platform));
}

function workerUrlFromEnv(): string | null {
  const url = process.env.SHERLOCK_WORKER_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

async function queryWorker(workerUrl: string, username: string): Promise<SherlockRaw> {
  let res: Response;
  try {
    res = await fetch(`${workerUrl}/sherlock`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Sherlock worker request failed: ${message}`);
  }

  if (res.status === 429) {
    throw new Error(
      `Sherlock worker rate-limited the request for "${username}" (HTTP 429). Wait and retry.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Sherlock worker returned HTTP ${res.status} for "${username}".`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("Sherlock worker returned a body that is not valid JSON.");
  }
  return parseSherlockPayload(json, username);
}

// ─── Confidence ─────────────────────────────────────────────────────────────

/**
 * Confidence in **the observation**, not in ownership.
 *
 * A profile page that returned 200 is a real measurement, so it scores. Every
 * reason string says out loud what the number does and does not cover, because
 * a bare 0.9 beside a social account is exactly what a reader turns into
 * "confirmed account".
 */
export function observationConfidence(hit: SherlockHit) {
  const measured = hit.httpStatus === 200;
  return {
    value: measured ? 0.9 : null,
    reasons: measured
      ? [
          `Sherlock observed HTTP 200 at ${hit.url}.`,
          "Scores that a public profile EXISTS at this handle. It is not evidence that the account belongs to the person under investigation.",
        ]
      : [
          "The worker did not report a confirmed HTTP status, so the existence of the profile is unmeasured.",
        ],
  };
}

/**
 * Confidence in **the identity link**. Always unscored, by construction.
 *
 * Do not automatically equate matching usernames with the same person. Sherlock
 * supplies zero evidence of ownership, so there is no honest number to put here
 * — and a placeholder low score would still render as a score.
 * `entity-resolution.ts` may raise this later from independent signals.
 */
export function identityConfidence() {
  return {
    value: null,
    reasons: [
      "UNSCORED: a handle existing on a platform is not evidence that it belongs to the person under investigation.",
      "Handles collide, and squatted or impersonating accounts return the same response as genuine ones.",
      "Raising this requires independent corroboration — a matching public email, organisation, site or biography — which entity resolution evaluates, not this collector.",
    ],
  };
}

export const CANDIDATE_ACCOUNT_CAVEATS: string[] = [
  "Every account here is a CANDIDATE. Sherlock checked whether a profile page exists for this handle — nothing more.",
  "A matching username is not proof of identity. Do not treat a hit as a confirmed account without independent corroboration.",
  "Platforms that failed or were unreachable are listed separately. A missing platform is not evidence the handle is absent there.",
  "Sherlock issues ordinary unauthenticated requests to public profile URLs. It never logs in and never accesses a private account.",
];

// ─── Collector ──────────────────────────────────────────────────────────────

export const sherlockCollector: Collector<SherlockRaw> = {
  id: "sherlock",
  name: "Sherlock (external worker)",
  category: "social",
  /**
   * `username` ONLY, deliberately. A name must not be silently transformed into
   * a handle. The planner's `detectTargetType` already returns `username` (with
   * `person` as an alternate) for a bare word, so a handle-shaped target selects
   * this collector as an explicit planning decision — while a domain, email, IP
   * or URL target never does.
   */
  supportedTargetTypes: ["username"],
  requiresCredentials: false,
  isOptional: true,

  disciplines: ["SOCMINT"],

  capability: {
    sourceId: "sherlock",
    name: "Sherlock",
    collectionMode: "PASSIVE_PUBLIC_WEB",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: true,
    apiAvailable: true,
    notes:
      "Checks whether public profile pages exist for a handle, behind a self-hosted HTTP worker. Unauthenticated GETs only — no login, no credential testing, no private-account access. Reports unavailable until SHERLOCK_WORKER_URL is set; no worker is deployed by default. A hit is a CANDIDATE account, never a confirmed identity.",
  },

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<SherlockRaw>> {
    const clock = startExecution();

    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      const err = collectorUnavailable(
        "sherlock",
        "SHERLOCK_WORKER_URL is not configured — no worker is deployed for this environment.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const username = normaliseUsername(target.value);
    if (!username) {
      const err = new CollectorError(
        "sherlock",
        "invalid-target",
        `"${target.value}" is not a usable handle. Sherlock takes a username, and a personal name is deliberately not converted into one — that would invent a handle nobody observed.`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    try {
      const raw = await queryWorker(workerUrl, username);
      // A partial run is `partial`, not `completed`: some platforms were never
      // checked, and reporting it clean would overstate the coverage.
      const status = raw.partial || raw.errors.length > 0 ? "partial" : "completed";
      return { execution: finishExecution(clock, status, raw.hits.length), raw };
    } catch (err) {
      const classified = classifyError("sherlock", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;

    const raw = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const usernameId = `sherlock:username:${raw.username.toLowerCase()}`;
    const entities: CollectorEntity[] = [
      {
        id: usernameId,
        type: "username",
        value: raw.username,
        displayName: raw.username,
        source: "sherlock",
        confidence: UNSCORED,
        metadata: { platformsChecked: raw.platformsChecked, partial: raw.partial },
      },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];
    const warnings: string[] = [];

    // NOTE: no `person` entity is created anywhere in this function. There is
    // deliberately nothing for a person→account edge to attach to.

    for (const hit of raw.hits) {
      const accountId = `sherlock:social_account:${hit.platform.toLowerCase()}:${raw.username.toLowerCase()}`;
      entities.push({
        id: accountId,
        type: "social_account",
        value: hit.url,
        displayName: `${hit.platform} / ${raw.username}`,
        source: "sherlock",
        confidence: observationConfidence(hit),
        metadata: {
          platform: hit.platform,
          username: raw.username,
          profileUrl: hit.url,
          httpStatus: hit.httpStatus,
          // Read by the UI so "CANDIDATE" cannot be forgotten at render time.
          status: "CANDIDATE",
        },
      });

      relationships.push({
        sourceEntity: usernameId,
        // Never USES_USERNAME — see the relationship type's own comment.
        relationshipType: "CANDIDATE_ACCOUNT",
        targetEntity: accountId,
        // Unscored on purpose: ownership is unestablished.
        confidence: identityConfidence(),
        source: "sherlock",
      });

      evidence.push({
        source: `Sherlock · ${hit.platform}`,
        sourceUrl: hit.url,
        collector: "sherlock",
        collectedAt,
        rawValue: hit,
        normalizedValue: {
          platform: hit.platform,
          username: raw.username,
          profileUrl: hit.url,
          status: "CANDIDATE",
        },
        confidence: observationConfidence(hit),
        metadata: {
          httpStatus: hit.httpStatus,
          identityEstablished: false,
          note: "Profile existence only. Ownership by the investigated person is NOT established by this record.",
        },
      });
    }

    // One platform failing must never fail the investigation — reported as
    // warnings so coverage is visible rather than silently narrower.
    for (const e of raw.errors) {
      warnings.push(`${e.platform}: not checked — ${e.reason}`);
    }
    if (raw.partial) {
      warnings.push(
        "Sherlock returned before checking every platform. Absence of a platform here is not evidence the handle is unused there.",
      );
    }

    return {
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: {
        username: raw.username,
        platformsChecked: raw.platformsChecked,
        hits: raw.hits.length,
        failures: raw.errors.length,
        partial: raw.partial,
      },
      execution: outcome.execution,
    };
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      return {
        state: "unavailable",
        detail: "SHERLOCK_WORKER_URL is not set. No worker is deployed for this environment.",
        checkedAt,
      };
    }
    try {
      const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return res.ok
        ? { state: "ready", detail: `Sherlock worker reachable at ${workerUrl}.`, checkedAt }
        : {
            state: "unavailable",
            detail: `Sherlock worker returned HTTP ${res.status}.`,
            checkedAt,
          };
    } catch (err) {
      return {
        state: "unavailable",
        detail: `Sherlock worker unreachable: ${err instanceof Error ? err.message : String(err)}`,
        checkedAt,
      };
    }
  },
};
