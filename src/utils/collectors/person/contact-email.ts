/**
 * contact.email — Person Investigation collector.
 *
 * Six independent checks, all free and keyless:
 *  1. Syntax — a real RFC-5322-ish shape check, not a network call.
 *  2. MX — a fresh Cloudflare DNS-over-HTTPS `type=MX` query. The only prior
 *     MX-lookup code in this codebase lived inline, un-exported, inside
 *     `routes/news.tsx`'s `fetchOSINT` handler (see
 *     PERSON-INVESTIGATION-ANALYSIS.md §9) — reimplemented here as a clean,
 *     standalone collector rather than reaching into that route, per Rule 4
 *     ("existing UI stays intact").
 *  3. Gravatar avatar — MD5(lowercased, trimmed email) against
 *     gravatar.com/avatar/{hash}?d=404. Verified live 2026-08-19: without
 *     `d=404` the endpoint always returns 200 with a fallback image, so
 *     `d=404` is what actually distinguishes "this address has a real
 *     avatar" (200) from "it doesn't" (404) — the standard, documented
 *     technique, not a guess.
 *  4. Gravatar profile — a SEPARATE, independent signal from the avatar
 *     check above (live-verified 2026-08-31: the same email can 404 on one
 *     and 200 on the other). `api.gravatar.com/v3/profiles/{sha256}` returns
 *     whatever the account owner chose to publish — name, bio, location, and
 *     `verified_accounts`, links to other platforms the owner cryptographically
 *     proved they control via Gravatar's own linking flow. Unauthenticated
 *     reads work (confirmed live, 100/hour), so no key is required.
 *  5. GitHub commit-author search — `api.github.com/search/commits?q=author-email:`
 *     is GitHub's own first-party public search feature over data the account
 *     owner made public themselves (git commit metadata in a public repo).
 *     A hit's `author.login`, when present, is GitHub's own resolution of that
 *     email to a real account. Deliberately NOT treated as a confirmed identity
 *     match — a git commit's author email is self-declared client-side
 *     configuration and is trivially spoofable, so this is evidence the email
 *     was USED to author public commits, not proof of who controls it.
 *  6. keys.openpgp.org — `keys.openpgp.org/vks/v1/by-email/{email}`, opt-in ONLY
 *     by that server's own design: a hit requires the email owner to have
 *     completed that keyserver's verification flow for this exact address. The
 *     cleanest ownership signal of the three network checks below the syntax/MX
 *     pair, at the cost of narrow real-world coverage (mostly developers and
 *     sysadmins who publish PGP keys).
 *
 * All three network additions (4-6) were researched and chosen specifically
 * because they are NOT the Holehe-style technique (probing a service's
 * password-reset/signup endpoint and reading the response difference to infer
 * account existence) — that approach was considered and rejected: it conflicts
 * with the Terms of Service most major platforms use to prohibit automated
 * querying, its reliability is degrading as platforms patch the enumeration
 * side-channel, and the Google-specific tool implementing it (GHunt) is
 * AGPL-licensed, which this project's licensing policy already excludes for the
 * same reason it excluded Ultralytics YOLO. Every check here instead reads data
 * the account owner published or verified on purpose, through a service's own
 * first-party public API.
 *
 * No collector before this one declared `supportedTargetTypes: ["email"]`
 * except `dorks` (which just builds search hits, not validation) — see
 * PERSON-INVESTIGATION-ANALYSIS.md §4.
 */

import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";

const EMAIL_SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MX_TIMEOUT_MS = 8_000;
const GRAVATAR_TIMEOUT_MS = 8_000;
const GRAVATAR_PROFILE_TIMEOUT_MS = 8_000;
const GITHUB_TIMEOUT_MS = 8_000;
const OPENPGP_TIMEOUT_MS = 8_000;

/** One account the Gravatar profile owner cryptographically linked and proved via Gravatar's own verification flow. */
export interface GravatarVerifiedAccount {
  serviceType: string;
  serviceLabel: string;
  url: string;
}

export interface GravatarProfile {
  exists: boolean;
  displayName: string | null;
  location: string | null;
  bio: string | null;
  jobTitle: string | null;
  company: string | null;
  verifiedAccounts: GravatarVerifiedAccount[];
}

export interface GithubCommitMatch {
  /** Public commits indexed by GitHub's search whose author email is this address. */
  totalCount: number;
  /** GitHub's own resolution of that email to an account, when it resolved one. */
  login: string | null;
}

export interface OpenPgpKeyCheck {
  hasKey: boolean;
}

export interface ContactEmailRaw {
  email: string;
  domain: string | null;
  syntaxValid: boolean;
  hasMx: boolean | null; // null = lookup failed, not "no MX records"
  mxHost: string | null;
  hasGravatar: boolean | null; // null = lookup failed
  /** null = lookup failed (network/rate-limit) — a profile that genuinely doesn't exist is `{ exists: false, ... }`, a real measurement. */
  gravatarProfile: GravatarProfile | null;
  gravatarHash256: string | null;
  /** null = lookup failed (network/rate-limit) — zero real commits found is `{ totalCount: 0, login: null }`, a real measurement. */
  githubCommits: GithubCommitMatch | null;
  /** null = lookup failed (network/rate-limit) — a confirmed absence is `{ hasKey: false }`, a real measurement. */
  openPgp: OpenPgpKeyCheck | null;
}

/**
 * Node's `crypto` module, not `Bun.CryptoHasher` — this collector's `execute()`
 * runs through server functions, and this project's Nitro preset is
 * `node-server` (`vite.config.ts`), so the actual runtime executing it is
 * plain Node, where `Bun` is not a defined global. `node:crypto` works
 * identically under Node and under Bun (which implements the Node API), so it
 * is the one hashing choice that is correct in every context this file
 * actually runs in — a `bun run` script, `bun test`, and the real server.
 */
async function md5Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(value).digest("hex");
}

async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
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

/**
 * Gravatar's v3 profile API — a genuinely different signal from the avatar
 * check above, not a duplicate of it (live-verified: the same email can 404 on
 * one and 200 on the other). Reads whatever the profile owner chose to
 * publish, including accounts they cryptographically linked and proved via
 * Gravatar's own verification flow.
 */
async function lookupGravatarProfile(
  hash256: string,
): Promise<GravatarProfile | null> {
  try {
    const res = await fetch(`https://api.gravatar.com/v3/profiles/${hash256}`, {
      signal: AbortSignal.timeout(GRAVATAR_PROFILE_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return {
        exists: false,
        displayName: null,
        location: null,
        bio: null,
        jobTitle: null,
        company: null,
        verifiedAccounts: [],
      };
    }
    if (!res.ok) return null; // rate-limited or otherwise inconclusive
    const json: any = await res.json();
    const verifiedAccounts: GravatarVerifiedAccount[] = Array.isArray(json?.verified_accounts)
      ? json.verified_accounts
          .filter((a: any) => typeof a?.url === "string" && a.url)
          .map((a: any) => {
            const serviceType = typeof a?.service_type === "string" ? a.service_type : "unknown";
            return {
              serviceType,
              serviceLabel: typeof a?.service_label === "string" ? a.service_label : serviceType,
              url: a.url as string,
            };
          })
      : [];
    return {
      exists: true,
      displayName: typeof json?.display_name === "string" ? json.display_name : null,
      location: typeof json?.location === "string" ? json.location : null,
      bio: typeof json?.description === "string" ? json.description : null,
      jobTitle: typeof json?.job_title === "string" ? json.job_title : null,
      company: typeof json?.company === "string" ? json.company : null,
      verifiedAccounts,
    };
  } catch {
    return null;
  }
}

/**
 * GitHub's own first-party public commit search, over data the account owner
 * made public by committing it to a public repo. `login`, when present, is
 * GitHub's own resolution of the commit author email to a real account — but
 * a commit's author email is self-declared client-side git config and is
 * trivially spoofable, so this is evidence the email was USED to author
 * public commits, never proof of who controls it.
 */
async function lookupGithubCommits(email: string): Promise<GithubCommitMatch | null> {
  try {
    const res = await fetch(
      `https://api.github.com/search/commits?q=${encodeURIComponent(`author-email:${email}`)}&per_page=1`,
      {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      },
    );
    // Unauthenticated search has a strict 10 requests/minute ceiling — a 403/429
    // here is a failed lookup, never a measured "no commits".
    if (!res.ok) return null;
    const json: any = await res.json();
    const totalCount = typeof json?.total_count === "number" ? json.total_count : 0;
    const login =
      typeof json?.items?.[0]?.author?.login === "string" ? json.items[0].author.login : null;
    return { totalCount, login };
  } catch {
    return null;
  }
}

/**
 * keys.openpgp.org's own by-email lookup — opt-in ONLY by that server's
 * design, so a hit requires the email owner to have completed its
 * verification flow for this exact address. The cleanest ownership signal of
 * the network checks in this file; also the narrowest in real-world coverage.
 */
async function lookupOpenPgpKey(email: string): Promise<OpenPgpKeyCheck | null> {
  try {
    const res = await fetch(`https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email)}`, {
      signal: AbortSignal.timeout(OPENPGP_TIMEOUT_MS),
    });
    if (res.status === 404) return { hasKey: false };
    if (res.ok) return { hasKey: true };
    return null; // any other status (including rate limit) is inconclusive
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

  capability: {
    sourceId: "contact.email",
    name: "Contact — Email",
    collectionMode: "PASSIVE_API",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: false,
    apiAvailable: true,
    notes:
      "Syntax check is local. MX is a Cloudflare DNS-over-HTTPS lookup. Gravatar avatar/profile, GitHub commit search and keys.openpgp.org are keyless HTTP checks against each service's own public API — never the email's own mail server, never a password-reset/signup endpoint.",
  },

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
      const gravatarHash256 = syntaxValid ? await sha256Hex(email.trim().toLowerCase()) : null;
      const [mx, hasGravatar, gravatarProfile, githubCommits, openPgp] = await Promise.all([
        domain && syntaxValid ? lookupMx(domain) : Promise.resolve(null),
        syntaxValid ? lookupGravatar(email) : Promise.resolve(null),
        gravatarHash256 ? lookupGravatarProfile(gravatarHash256) : Promise.resolve(null),
        syntaxValid ? lookupGithubCommits(email) : Promise.resolve(null),
        syntaxValid ? lookupOpenPgpKey(email) : Promise.resolve(null),
      ]);
      const raw: ContactEmailRaw = {
        email,
        domain,
        syntaxValid,
        hasMx: mx?.hasMx ?? null,
        mxHost: mx?.mxHost ?? null,
        hasGravatar,
        gravatarProfile,
        gravatarHash256,
        githubCommits,
        openPgp,
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
        metadata: {
          syntaxValid: r.syntaxValid,
          hasMx: r.hasMx,
          hasGravatar: r.hasGravatar,
          hasGravatarProfile: r.gravatarProfile?.exists ?? null,
          githubLogin: r.githubCommits?.login ?? null,
          hasOpenPgpKey: r.openPgp?.hasKey ?? null,
        },
      },
    ];
    const relationships: CollectorRelationship[] = [];
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

    // ── Gravatar profile — a separate signal from the avatar check above. ──
    if (r.gravatarProfile !== null) {
      const p = r.gravatarProfile;
      evidence.push({
        source: "Gravatar profile (public, api.gravatar.com)",
        sourceUrl: r.gravatarHash256 ? `https://gravatar.com/${r.gravatarHash256}` : null,
        collector: "contact.email",
        collectedAt,
        rawValue: p,
        normalizedValue: p,
        confidence: null,
        metadata: {},
      });
      if (p.exists) {
        for (const acc of p.verifiedAccounts) {
          const accId = `contact.email:verified-account:${acc.serviceType}:${acc.url.toLowerCase()}`;
          entities.push({
            id: accId,
            type: "social_account",
            value: acc.url,
            displayName: `${acc.serviceLabel} (Gravatar-verified)`,
            source: "contact.email",
            confidence: {
              value: null,
              reasons: ["owner-verified account link via Gravatar's own verification flow — not independently corroborated by this collector"],
            },
            metadata: { serviceType: acc.serviceType },
          });
          relationships.push({
            sourceEntity: emailId,
            relationshipType: "USES_USERNAME",
            targetEntity: accId,
            confidence: {
              value: null,
              reasons: ["Gravatar-verified link — the account owner proved control of both accounts through Gravatar's own linking flow"],
            },
            source: "contact.email",
          });
        }
      }
    }

    // ── GitHub commit-author search. ──
    if (r.githubCommits !== null) {
      const gh = r.githubCommits;
      evidence.push({
        source: "GitHub commit search (public commits, api.github.com)",
        sourceUrl: `https://github.com/search?q=${encodeURIComponent(`author-email:${r.email}`)}&type=commits`,
        collector: "contact.email",
        collectedAt,
        rawValue: gh,
        normalizedValue: gh,
        confidence: null,
        metadata: {},
      });
      if (gh.login) {
        const ghId = `contact.email:github:${gh.login.toLowerCase()}`;
        entities.push({
          id: ghId,
          type: "social_account",
          value: `https://github.com/${gh.login}`,
          displayName: `${gh.login} on GitHub`,
          source: "contact.email",
          confidence: {
            value: null,
            reasons: ["derived from public git commit author metadata — self-declared and spoofable, not independently verified"],
          },
          metadata: { login: gh.login, commitCount: gh.totalCount },
        });
        // CANDIDATE_ACCOUNT, not USES_USERNAME: a commit's author email is
        // client-side git config the actual account owner never has to prove —
        // this is evidence the email was USED to author public commits linked
        // to this account, never proof of who controls either.
        relationships.push({
          sourceEntity: emailId,
          relationshipType: "CANDIDATE_ACCOUNT",
          targetEntity: ghId,
          confidence: {
            value: null,
            reasons: ["public commits authored with this email are linked by GitHub to this account — not proof the commit author is this account's real owner"],
          },
          source: "contact.email",
        });
      }
    }

    // ── keys.openpgp.org — opt-in only by that server's own design. ──
    if (r.openPgp !== null) {
      evidence.push({
        source: "keys.openpgp.org (opt-in public keyserver)",
        sourceUrl: `https://keys.openpgp.org/search?q=${encodeURIComponent(r.email)}`,
        collector: "contact.email",
        collectedAt,
        rawValue: r.openPgp,
        normalizedValue: r.openPgp,
        confidence: null,
        metadata: {},
      });
    }

    const warnings: string[] = [];
    if (!r.syntaxValid) warnings.push(`"${r.email}" did not pass a basic email-syntax check.`);
    if (r.hasMx === null) warnings.push("MX lookup failed — mail-deliverability could not be determined.");
    if (r.hasGravatar === null) warnings.push("Gravatar avatar lookup failed — could not be determined.");
    if (r.gravatarProfile === null) warnings.push("Gravatar profile lookup failed — could not be determined.");
    if (r.githubCommits === null) warnings.push("GitHub commit-author search failed — could not be determined.");
    if (r.openPgp === null) warnings.push("keys.openpgp.org lookup failed — could not be determined.");

    return InvestigationResultSchema.parse({
      entities,
      relationships,
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
