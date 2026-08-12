/**
 * Credentials vault — the store behind the Settings page, and the thing the
 * collectors actually read.
 *
 * WHAT THIS REPLACES. Until now the vault was a write-only box. `settings.tsx`
 * wrote `data/credentials.json`; nothing anywhere read it. Every collector that
 * needs a key read `process.env` and nothing else, so an operator could add a
 * credential, watch it save, see it listed as "Active", and collect exactly as
 * much as before: nothing. The v1 tree closed that loop by having
 * `scripts/agent_scraper.py` read this file and log into Instagram with it —
 * see the note at the bottom of this file for why that path is not coming back.
 * This module closes it the other way: the vault feeds the collectors that can
 * genuinely use a credential, and says so, per provider, in the UI.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE.
 *
 * 1. `status` is never asserted, only measured. Saving a credential does not
 *    make it "Active" — that word was written to disk by the old form handler
 *    for a secret nothing had ever tried. A new entry is `unverified` until a
 *    live call to the provider says otherwise, and a provider that cannot be
 *    used at all (Instagram, Facebook) is `unusable` and can never be anything
 *    else, no matter what the operator pastes in.
 *
 * 2. Environment wins over the vault. `LLM_API_KEY` and friends arrive as Key
 *    Vault `secretref:` env vars through the container app's managed identity.
 *    That is the real deployment path and it must not be shadowed by a file an
 *    operator edited on a scratch container. `resolveCredential` therefore
 *    reads env first and reports which of the two answered.
 *
 * 3. Secrets do not cross to the browser as a side effect. `listCredentials`
 *    returns masked entries. Revealing one is a separate, deliberate server
 *    call, so a page load never ships the whole key set to a client.
 *
 * STORAGE HONESTY. This writes `data/credentials.json` in cleartext, mode 0600
 * where the platform supports it. `data/` is excluded from the Docker build
 * context and is not a mounted volume, so on Azure Container Apps the file dies
 * with the replica: a vault credential does not survive a revision restart or a
 * scale-to-zero. That is a real limitation, it is stated in the UI, and it is
 * why env/Key Vault stays the durable path for anything that matters.
 */

import { createServerFn } from "@tanstack/react-start";

// ─── Errors ────────────────────────────────────────────────────────────────

export class CredentialVaultError extends Error {
  readonly providerId: string;
  constructor(message: string, providerId: string) {
    super(message);
    this.name = "CredentialVaultError";
    this.providerId = providerId;
  }
}

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * Four distinct facts, deliberately not collapsed into a boolean.
 *
 * - `unverified` — stored, never tried. The honest state of every credential
 *   the moment it is saved.
 * - `verified`   — a live call to the provider succeeded at `verifiedAt`.
 * - `rejected`   — a live call ran and the provider refused the secret.
 * - `unusable`   — the provider cannot be collected from at all, so the secret
 *   is inert regardless of whether it is correct.
 *
 * An analyst acts differently on each. "Nothing came back" reads very
 * differently under `rejected` than under `verified`.
 */
export type CredentialStatus = "unverified" | "verified" | "rejected" | "unusable";

export const STATUS_LABELS: Record<CredentialStatus, string> = {
  unverified: "Unverified",
  verified: "Verified",
  rejected: "Rejected",
  unusable: "Not collectable",
};

/**
 * Legacy rows wrote `status: "Active"` (or `"Inactive"`) at save time for a
 * secret nothing had ever called. That claim was never measured, so it is read
 * back as `unverified` rather than honoured — downgrading an unearned green
 * badge, not losing operator data. The entry, its label, username and secret
 * are all preserved untouched.
 */
export function normaliseStatus(raw: unknown): CredentialStatus {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "verified" || s === "rejected" || s === "unusable" || s === "unverified") {
    return s as CredentialStatus;
  }
  return "unverified";
}

// ─── Provider registry ─────────────────────────────────────────────────────

export type ProviderCategory = "social" | "osint" | "gis" | "llm" | "blocked";

export interface CredentialProvider {
  id: string;
  label: string;
  category: ProviderCategory;
  /**
   * Whether supplying this credential unlocks anything. `false` means the
   * platform is closed to us for reasons no key resolves — the entry can still
   * be stored, but it is reported as inert rather than as an integration.
   */
  collectable: boolean;
  /** Reason a non-collectable provider is non-collectable. Rendered verbatim. */
  blockedReason?: string;
  /** Label for the non-secret half of the credential. */
  identifierLabel: string;
  identifierHint: string;
  /** Some providers (bare API keys) have no identifier at all. */
  identifierRequired: boolean;
  secretLabel: string;
  secretHint: string;
  /** Env var carrying the identifier, where one exists. Checked before the vault. */
  envIdentifier?: string;
  /** Env var carrying the secret. Checked before the vault. */
  envSecret?: string;
  /** What collection this credential switches on. Concrete, not aspirational. */
  unlocks: string;
  /**
   * The code path that reads it. If nothing reads it, this says so — a vault
   * entry that quietly feeds nothing is the exact failure this module was
   * written to remove, so it must not be disguised by an empty string.
   */
  consumedBy: string;
  /** Where an operator obtains the credential. */
  howTo: string;
  /** Whether `verifyProviderCredential` can make a real call for this provider. */
  verifiable: boolean;
}

/**
 * Every provider the platform can hold a credential for.
 *
 * Ordered by how much each unlocks, because the Settings page renders them in
 * this order and the first thing an operator sees should be the one blocking
 * the most collection.
 */
export const CREDENTIAL_PROVIDERS: CredentialProvider[] = [
  {
    id: "reddit",
    label: "Reddit — script app (OAuth)",
    category: "social",
    collectable: true,
    identifierLabel: "Client ID",
    identifierHint: "The 14-character string under the app name at reddit.com/prefs/apps",
    identifierRequired: true,
    secretLabel: "Client Secret",
    secretHint: "The 'secret' field of the same app",
    envIdentifier: "REDDIT_CLIENT_ID",
    envSecret: "REDDIT_CLIENT_SECRET",
    unlocks:
      "Keyword search across all of Reddit at 100 queries/minute. Without it every " +
      "unauthenticated Reddit endpoint returns 403 (verified 2026-08-10) and the platform " +
      "collects nothing at all.",
    consumedBy: "fetchRedditSearch() in social.ts — the /social and /live Reddit panels",
    howTo: "reddit.com/prefs/apps → create another app → type 'script' → free, no review",
    verifiable: true,
  },
  {
    id: "bluesky",
    label: "Bluesky — app password",
    category: "social",
    collectable: true,
    identifierLabel: "Handle or DID",
    identifierHint: "e.g. analyst.bsky.social",
    identifierRequired: true,
    secretLabel: "App password",
    secretHint: "Settings → App Passwords. Never the account password.",
    envIdentifier: "BLUESKY_IDENTIFIER",
    envSecret: "BLUESKY_APP_PASSWORD",
    unlocks:
      "Historical keyword search via app.bsky.feed.searchPosts, which returns 403 " +
      "unauthenticated. Without it Bluesky collection can only run forward from the moment " +
      "the Jetstream socket connects, so nothing posted before the analyst opened the tab is " +
      "reachable. This is the single largest collection gain any credential here buys.",
    consumedBy: "fetchBlueskySearch() in social.ts — the /social keyword search panel",
    howTo: "bsky.app → Settings → Privacy and security → App Passwords → Add App Password",
    verifiable: true,
  },
  {
    id: "mastodon",
    label: "Mastodon — instance access token",
    category: "social",
    collectable: true,
    identifierLabel: "Instance host",
    identifierHint: "e.g. mastodon.social — the instance that issued the token",
    identifierRequired: true,
    secretLabel: "Access token",
    secretHint: "Preferences → Development → New application, scope: read",
    envIdentifier: "MASTODON_INSTANCE",
    envSecret: "MASTODON_ACCESS_TOKEN",
    unlocks:
      "Full-text status search on that instance (api/v2/search), which needs a token on " +
      "every instance tested. Keyless collection is limited to hashtag timelines, so an " +
      "unhashtagged post is currently invisible.",
    consumedBy: "fetchMastodonSearch() in social.ts — the /social Mastodon panel",
    howTo: "Your instance → Preferences → Development → New application → scope 'read'",
    verifiable: true,
  },
  {
    id: "github",
    label: "GitHub — personal access token",
    category: "osint",
    collectable: true,
    identifierLabel: "Account / token name",
    identifierHint: "For your own records; GitHub authenticates on the token alone",
    identifierRequired: false,
    secretLabel: "Personal access token",
    secretHint: "A classic or fine-grained PAT. No scopes are needed for public search.",
    envSecret: "GITHUB_TOKEN",
    unlocks:
      "Raises GitHub search from 10 requests/minute to 30, and the core API from 60 " +
      "requests/hour to 5,000. The exposure sweep makes three calls per subject, so the " +
      "unauthenticated ceiling is roughly three subjects a minute before results start " +
      "silently thinning.",
    consumedBy: "githubHeaders() → the repository, user and user-repo sweeps in news.tsx",
    howTo: "github.com/settings/tokens → generate new token → no scopes required",
    verifiable: true,
  },
  {
    id: "ucdp",
    label: "UCDP — GED API token",
    category: "gis",
    collectable: true,
    identifierLabel: "Token label",
    identifierHint: "For your own records",
    identifierRequired: false,
    secretLabel: "Access token",
    secretHint: "Sent as the x-ucdp-access-token header",
    envSecret: "UCDP_API_TOKEN",
    unlocks:
      "The conflict-event layer on the GIS map. UCDP began returning 401 without a token " +
      "before 2026-08-04, so the layer currently reports a missing credential rather than " +
      "plotting events.",
    consumedBy: "collectConflict() in geo-sources.ts — the /gis conflict layer",
    howTo: "ucdp.uu.se → request API access",
    verifiable: true,
  },
  {
    id: "llm-primary",
    label: "LLM — primary (Sarvam)",
    category: "llm",
    collectable: true,
    identifierLabel: "Model ID",
    identifierHint: "sarvam-105b — the only model Sarvam's /models returns",
    identifierRequired: false,
    secretLabel: "API key",
    secretHint: "Sent as a bearer token to LLM_BASE_URL",
    envSecret: "LLM_API_KEY",
    unlocks:
      "Summarisation, entity extraction, linguistic-marker scoring and report generation. " +
      "Every PS-18 §6.5 product names its model on screen and in the PDF footer.",
    consumedBy: "chat()/chatJson() in llm.ts — Modules 1, 2 and 5",
    howTo: "dashboard.sarvam.ai — Apache 2.0 weights, self-hostable on vLLM later",
    verifiable: true,
  },
  {
    id: "llm-fallback",
    label: "LLM — fallback (Groq, gpt-oss-120b)",
    category: "llm",
    collectable: true,
    identifierLabel: "Model ID",
    identifierHint: "openai/gpt-oss-120b — open weights despite the prefix",
    identifierRequired: false,
    secretLabel: "API key",
    secretHint: "Used only on 429/5xx from the primary. A 401 does not fail over.",
    envSecret: "LLM_FALLBACK_KEY",
    unlocks: "Failover inference when the primary rate limits or errors.",
    consumedBy: "the fallback branch of chat() in llm.ts",
    howTo: "console.groq.com — free tier",
    verifiable: true,
  },
  {
    id: "youtube",
    label: "YouTube — Data API v3 key",
    category: "social",
    collectable: true,
    identifierLabel: "Project / key name",
    identifierHint: "For your own records; Google authenticates on the key alone",
    identifierRequired: false,
    secretLabel: "API key",
    secretHint: "Google Cloud console → APIs & Services → Credentials → API key",
    envSecret: "YOUTUBE_API_KEY",
    unlocks:
      "Comment collection via commentThreads.list. Metadata and captions already work without " +
      "a key (they come from the InnerTube player endpoint), so this buys comments and nothing " +
      "else. Quota is 10,000 units/day, and a commentThreads page costs 1 unit.",
    consumedBy: "fetchYoutubeComments() in youtube-collector.ts — the /youtube comments panel",
    howTo: "console.cloud.google.com → enable 'YouTube Data API v3' → create an API key. Free.",
    verifiable: true,
  },
  {
    id: "instagram",
    label: "Instagram",
    category: "blocked",
    collectable: false,
    blockedReason:
      "Meta's terms prohibit scraping, and the Graph API grants access only to Pages and " +
      "Business accounts the caller already owns. There is no compliant route to broad " +
      "monitoring, so no credential enables collection here — an account login would be a " +
      "terms breach and a ban, not an integration. Stored entries are inert and are reported " +
      "as such rather than shown as active integrations.",
    identifierLabel: "Username",
    identifierHint: "Stored only; nothing reads it",
    identifierRequired: true,
    secretLabel: "Password / token",
    secretHint: "Stored only; nothing reads it",
    unlocks: "Nothing. See the reason above.",
    consumedBy: "Nothing reads this. No collector exists for Instagram.",
    howTo: "Not applicable.",
    verifiable: false,
  },
  {
    id: "facebook",
    label: "Facebook",
    category: "blocked",
    collectable: false,
    blockedReason:
      "The same constraint as Instagram. CrowdTangle, the research programme that once " +
      "permitted this, shut down in August 2024. Stored entries are inert.",
    identifierLabel: "Account / app name",
    identifierHint: "Stored only; nothing reads it",
    identifierRequired: true,
    secretLabel: "Password / token",
    secretHint: "Stored only; nothing reads it",
    unlocks: "Nothing. See the reason above.",
    consumedBy: "Nothing reads this. No collector exists for Facebook.",
    howTo: "Not applicable.",
    verifiable: false,
  },
];

export function providerById(id: string): CredentialProvider | null {
  return CREDENTIAL_PROVIDERS.find((p) => p.id === id) ?? null;
}

// ─── Entries ───────────────────────────────────────────────────────────────

export interface CredentialEntry {
  id: string;
  /** Registry key. Matches the vault file's top-level key. */
  provider: string;
  label: string;
  /** The non-secret half: client id, handle, instance host, account name. */
  username: string;
  secret: string;
  status: CredentialStatus;
  /**
   * ISO 8601 of the last time a collector actually used this credential, or
   * null. Never the string "Never" — that was a display value written into the
   * data, which made "never used" and "used at an unknown time" the same row.
   */
  lastUsed: string | null;
  /** ISO 8601 of the last live verification call, or null if never verified. */
  verifiedAt: string | null;
  /** The provider's own words from that call. Null before any verification. */
  verifyDetail: string | null;
  createdAt: string | null;
}

/** What crosses to the browser: everything except the secret. */
export interface RedactedCredentialEntry extends Omit<CredentialEntry, "secret"> {
  /** Fixed-width mask. Deliberately not length-preserving — length is a hint. */
  secretMask: string;
  /** Last 4 characters, so an operator can tell two keys apart without revealing either. */
  secretTail: string;
}

export type CredentialVaultFile = Record<string, CredentialEntry[]>;

export function maskSecret(secret: string): string {
  // Fixed width: a length-preserving mask leaks the key length, and an empty
  // secret must not render as dots — that would show a credential that is not
  // there as though one were stored.
  return secret ? "•".repeat(16) : "";
}

export function secretTail(secret: string): string {
  const s = String(secret ?? "");
  return s.length <= 4 ? "" : s.slice(-4);
}

export function redactEntry(entry: CredentialEntry): RedactedCredentialEntry {
  const { secret, ...rest } = entry;
  return { ...rest, secretMask: maskSecret(secret), secretTail: secretTail(secret) };
}

export function redactVault(vault: CredentialVaultFile): Record<string, RedactedCredentialEntry[]> {
  const out: Record<string, RedactedCredentialEntry[]> = {};
  for (const [provider, entries] of Object.entries(vault)) {
    out[provider] = entries.map(redactEntry);
  }
  return out;
}

/**
 * Coerce one stored row into a `CredentialEntry`.
 *
 * Tolerant by design: the file predates this module and holds rows written by
 * the v1 form handler. A row missing a field is filled with an explicit null,
 * never with a plausible-looking default — `lastUsed: "Never"` becomes `null`
 * rather than a timestamp, and an unverified row does not acquire a
 * `verifiedAt`.
 */
export function normaliseEntry(raw: unknown, provider: string, index: number): CredentialEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  // "Never" was the legacy sentinel for "not used". It is a display string, not
  // a time, so it maps to null rather than being parsed into one.
  const iso = (v: unknown): string | null => {
    const s = str(v).trim();
    if (!s || s.toLowerCase() === "never") return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };

  const def = providerById(provider);
  const status = def && !def.collectable ? "unusable" : normaliseStatus(r.status);

  return {
    id: str(r.id) || `${provider}-${index}`,
    provider,
    label: str(r.label) || `${provider.toUpperCase()} credential`,
    username: str(r.username),
    secret: str(r.secret),
    status,
    lastUsed: iso(r.lastUsed),
    verifiedAt: iso(r.verifiedAt),
    verifyDetail: str(r.verifyDetail) || null,
    createdAt: iso(r.createdAt),
  };
}

export function normaliseVault(raw: unknown): CredentialVaultFile {
  const out: CredentialVaultFile = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[provider] = value.map((row, i) => normaliseEntry(row, provider, i));
  }
  return out;
}

// ─── File store ────────────────────────────────────────────────────────────

const VAULT_PATH = "./data/credentials.json";

/**
 * Read the vault, or an empty vault if there is no file.
 *
 * An absent store means NO credentials are configured. The v1 handler seeded
 * three fabricated "Active" accounts here on a cache miss and wrote them to
 * disk, so the next read returned them as though an operator had configured
 * them; the container ships no `data/`, so that fired on every cold start in
 * production. Absence is absence.
 */
export async function readVault(): Promise<CredentialVaultFile> {
  try {
    const fs = (await import("fs")).promises;
    const data = await fs.readFile(VAULT_PATH, "utf-8");
    return normaliseVault(JSON.parse(data));
  } catch {
    return {};
  }
}

/** Single-generation backup, overwritten on each write. */
export const VAULT_BACKUP_PATH = "./data/credentials.prev.json";

export async function writeVault(vault: CredentialVaultFile): Promise<void> {
  const fs = (await import("fs")).promises;
  await fs.mkdir("./data", { recursive: true });

  // Keep the previous generation before overwriting. Every write here replaces
  // the WHOLE file, so a stale client — an old tab, a page that loaded before
  // another was edited — can submit a vault that silently drops entries it
  // never knew about. Last-writer-wins is tolerable for a demo store; losing an
  // operator's only copy of a secret to it is not, and secrets are the one
  // thing here that cannot be re-derived. Best effort: no previous file on a
  // first write is the normal case, not an error.
  try {
    const existing = await fs.readFile(VAULT_PATH, "utf-8");
    await fs.writeFile(VAULT_BACKUP_PATH, existing, "utf-8");
    await fs.chmod(VAULT_BACKUP_PATH, 0o600).catch(() => {});
  } catch {
    // No existing vault to back up.
  }

  await fs.writeFile(VAULT_PATH, JSON.stringify(vault, null, 2), "utf-8");
  // Best effort: no-op on Windows, meaningful on the Linux container. A failure
  // here must not lose the credential the operator just entered, but it also
  // must not pass silently as though the file were locked down.
  try {
    await fs.chmod(VAULT_PATH, 0o600);
  } catch (err: any) {
    console.warn(`credential vault: could not restrict ${VAULT_PATH} permissions:`, err?.message);
  }
}

// ─── Resolution: environment first, vault second ───────────────────────────

export interface ResolvedCredential {
  providerId: string;
  /** Null when the provider takes a bare key with no identifier half. */
  identifier: string | null;
  secret: string;
  /** Which store answered. Drives what the UI tells the operator to change. */
  source: "env" | "vault";
  /** Vault entry id, so usage can be recorded against it. Null for env. */
  entryId: string | null;
}

function envValue(name: string | undefined): string | null {
  if (!name) return null;
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed ? trimmed : null;
}

/**
 * Find the credential a collector should use for `providerId`, or null.
 *
 * Environment first. `LLM_API_KEY`, `REDDIT_CLIENT_ID` and the rest arrive from
 * Key Vault through the container app's managed identity; that is the audited
 * path and a file on an ephemeral replica must not override it. The vault is
 * the fallback, which is what makes the Settings page useful locally and during
 * a demo without a redeploy.
 *
 * A `rejected` entry is skipped: the provider has already refused it, and
 * replaying a known-dead secret turns one clear "your key is wrong" into a
 * stream of confusing 401s. `unverified` entries ARE tried — untested is not
 * the same as known-bad.
 */
export async function resolveCredential(providerId: string): Promise<ResolvedCredential | null> {
  const def = providerById(providerId);
  if (!def) return null;
  // A non-collectable provider resolves to nothing even when an entry exists.
  // Nothing should be calling this for Instagram, but if something does, it
  // must not receive a usable-looking credential.
  if (!def.collectable) return null;

  const envSecret = envValue(def.envSecret);
  if (envSecret) {
    return {
      providerId,
      identifier: envValue(def.envIdentifier),
      secret: envSecret,
      source: "env",
      entryId: null,
    };
  }

  const vault = await readVault();
  const entries = vault[providerId] ?? [];
  const usable = entries.find(
    (e) => e.secret && e.status !== "rejected" && (!def.identifierRequired || e.username),
  );
  if (!usable) return null;

  return {
    providerId,
    identifier: usable.username || null,
    secret: usable.secret,
    source: "vault",
    entryId: usable.id,
  };
}

/**
 * Stamp `lastUsed` on the entry a collector just used.
 *
 * Best effort and non-throwing: a read-only filesystem must degrade a bookkeeping
 * field, not fail the collection that succeeded. Env-sourced credentials have no
 * entry to stamp, which is why `entryId` is nullable.
 */
export async function recordCredentialUse(
  providerId: string,
  entryId: string | null,
): Promise<void> {
  if (!entryId) return;
  try {
    const vault = await readVault();
    const entries = vault[providerId];
    if (!entries) return;
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.lastUsed = new Date().toISOString();
    await writeVault(vault);
  } catch {
    // Deliberately swallowed — see the doc comment.
  }
}

// ─── Live verification ─────────────────────────────────────────────────────

export interface VerifyResult {
  providerId: string;
  status: CredentialStatus;
  /** The provider's own answer, including the HTTP status where there was one. */
  detail: string;
  /** ISO 8601 of the call. Null only when no call was made. */
  checkedAt: string | null;
}

const VERIFY_TIMEOUT_MS = 12_000;

/** Distinguishes "the provider refused you" from "we could not reach it". */
function transportFailure(providerId: string, err: any): VerifyResult {
  return {
    providerId,
    status: "unverified",
    detail:
      `Could not reach the provider: ${err?.message ?? String(err)}. The credential was ` +
      `not tested — this is a network failure, not a rejection.`,
    checkedAt: new Date().toISOString(),
  };
}

const ok = (providerId: string, detail: string): VerifyResult => ({
  providerId,
  status: "verified",
  detail,
  checkedAt: new Date().toISOString(),
});

const rejected = (providerId: string, detail: string): VerifyResult => ({
  providerId,
  status: "rejected",
  detail,
  checkedAt: new Date().toISOString(),
});

/**
 * Make a real call to the provider and report what it said.
 *
 * Every branch here talks to the live service. There is no offline "looks like
 * a valid key" heuristic, because a format check that returns green for a
 * revoked key is exactly the fabricated confidence value this project forbids.
 */
export async function verifyProviderCredential(
  providerId: string,
  identifier: string,
  secret: string,
): Promise<VerifyResult> {
  const def = providerById(providerId);
  if (!def) {
    throw new CredentialVaultError(`Unknown credential provider "${providerId}".`, providerId);
  }

  if (!def.collectable) {
    return {
      providerId,
      status: "unusable",
      detail:
        def.blockedReason ??
        "This provider is not collectable, so the credential cannot be verified or used.",
      // No call was made, and saying otherwise would imply one had been.
      checkedAt: null,
    };
  }

  if (!secret.trim()) {
    return rejected(providerId, "No secret supplied.");
  }

  const signal = () => AbortSignal.timeout(VERIFY_TIMEOUT_MS);

  try {
    switch (providerId) {
      case "reddit": {
        if (!identifier.trim()) return rejected(providerId, "No client ID supplied.");
        const res = await fetch("https://www.reddit.com/api/v1/access_token", {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${identifier}:${secret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "SentinelAI/1.0 (OSINT research; contact via repository)",
          },
          body: "grant_type=client_credentials",
          signal: signal(),
        });
        if (res.status === 401 || res.status === 403) {
          return rejected(
            providerId,
            `Reddit refused the credentials (HTTP ${res.status}). Check the client ID and ` +
              `secret, and that the app is registered as type "script" rather than "web app".`,
          );
        }
        if (!res.ok) {
          return rejected(providerId, `Reddit token endpoint returned HTTP ${res.status}.`);
        }
        const json: any = await res.json().catch(() => null);
        if (typeof json?.access_token !== "string" || !json.access_token) {
          return rejected(providerId, "Reddit returned 200 but no access_token.");
        }
        const ttl = typeof json?.expires_in === "number" ? json.expires_in : null;
        return ok(
          providerId,
          `Reddit issued a client-credentials token${ttl ? `, valid ${ttl}s` : ""}. ` +
            `Keyword search is live at 100 queries/minute.`,
        );
      }

      case "bluesky": {
        if (!identifier.trim()) return rejected(providerId, "No handle or DID supplied.");
        const res = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identifier: identifier.trim().replace(/^@/, ""),
            password: secret,
          }),
          signal: signal(),
        });
        const json: any = await res.json().catch(() => null);
        if (res.status === 401) {
          return rejected(
            providerId,
            `Bluesky refused the app password: ${json?.message ?? "AuthenticationRequired"}. ` +
              `Note this must be an App Password from Settings, not the account password.`,
          );
        }
        if (res.status === 400 && json?.error === "AuthFactorTokenRequired") {
          return rejected(
            providerId,
            "This account has two-factor email confirmation enabled, which the " +
              "client-credentials flow cannot satisfy. Use an account without 2FA, or supply " +
              "the sign-in code out of band.",
          );
        }
        if (!res.ok) {
          return rejected(
            providerId,
            `Bluesky createSession returned HTTP ${res.status}${json?.error ? ` (${json.error})` : ""}.`,
          );
        }
        if (typeof json?.accessJwt !== "string") {
          return rejected(providerId, "Bluesky returned 200 but no accessJwt.");
        }
        return ok(
          providerId,
          `Session created for @${json?.handle ?? identifier} (${json?.did ?? "did unknown"}). ` +
            `Historical keyword search via searchPosts is now available.`,
        );
      }

      case "mastodon": {
        const host = normaliseHost(identifier) || "mastodon.social";
        const res = await fetch(`https://${host}/api/v1/accounts/verify_credentials`, {
          headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
          signal: signal(),
        });
        if (res.status === 401 || res.status === 403) {
          return rejected(
            providerId,
            `${host} refused the token (HTTP ${res.status}). Confirm the token was issued by ` +
              `this instance — a token is only valid on the instance that created it.`,
          );
        }
        if (!res.ok) {
          return rejected(providerId, `${host} returned HTTP ${res.status}.`);
        }
        const json: any = await res.json().catch(() => null);
        return ok(
          providerId,
          `Authenticated on ${host} as @${json?.username ?? "unknown"}. Full-text status ` +
            `search is available on this instance.`,
        );
      }

      case "github": {
        const res = await fetch("https://api.github.com/user", {
          headers: {
            authorization: `Bearer ${secret}`,
            accept: "application/vnd.github+json",
            "user-agent": "SentinelAI/1.0",
          },
          signal: signal(),
        });
        if (res.status === 401) {
          return rejected(
            providerId,
            "GitHub refused the token (HTTP 401). It may be revoked, expired, or mistyped.",
          );
        }
        if (!res.ok) {
          return rejected(providerId, `GitHub /user returned HTTP ${res.status}.`);
        }
        const json: any = await res.json().catch(() => null);
        const limit = res.headers.get("x-ratelimit-limit");
        return ok(
          providerId,
          `Authenticated as ${json?.login ?? "unknown"}` +
            `${limit ? `; core rate limit now ${limit}/hour` : ""}.`,
        );
      }

      case "ucdp": {
        const res = await fetch("https://ucdpapi.pcr.uu.se/api/gedevents/24.1?pagesize=1", {
          headers: { "x-ucdp-access-token": secret, accept: "application/json" },
          signal: signal(),
        });
        if (res.status === 401 || res.status === 403) {
          return rejected(providerId, `UCDP refused the token (HTTP ${res.status}).`);
        }
        if (!res.ok) return rejected(providerId, `UCDP returned HTTP ${res.status}.`);
        const json: any = await res.json().catch(() => null);
        const total = typeof json?.TotalCount === "number" ? json.TotalCount : null;
        return ok(
          providerId,
          `UCDP GED accepted the token${total !== null ? `; ${total} events in this version` : ""}. ` +
            `The GIS conflict layer will now populate.`,
        );
      }

      case "youtube": {
        // videos.list on a known-good id costs 1 unit — the cheapest call that
        // still exercises the key. A quota failure is NOT a bad key, and the
        // two must not collapse: one is fixed by waiting, the other by
        // reissuing.
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(secret)}`,
          { headers: { accept: "application/json" }, signal: signal() },
        );
        const json: any = await res.json().catch(() => null);
        const reason = json?.error?.errors?.[0]?.reason ?? json?.error?.status ?? null;
        if (reason === "quotaExceeded" || reason === "RESOURCE_EXHAUSTED") {
          return {
            providerId,
            status: "unverified",
            detail:
              "The key is recognised but its 10,000 unit/day quota is exhausted, so it could " +
              "not be tested. This is a quota state, not a rejection — it resets at midnight " +
              "Pacific.",
            checkedAt: new Date().toISOString(),
          };
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          return rejected(
            providerId,
            `Google refused the key (HTTP ${res.status}${reason ? `, ${reason}` : ""}). Check ` +
              `that "YouTube Data API v3" is enabled on the project and that no HTTP-referrer ` +
              `restriction blocks server-side use.`,
          );
        }
        if (!res.ok) return rejected(providerId, `YouTube Data API returned HTTP ${res.status}.`);
        return ok(
          providerId,
          "YouTube Data API accepted the key. Comment collection is available at 10,000 " +
            "units/day (1 unit per 100-comment page).",
        );
      }

      case "llm-primary":
      case "llm-fallback": {
        const base =
          providerId === "llm-primary"
            ? (envValue("LLM_BASE_URL") ?? "https://api.sarvam.ai/v1")
            : (envValue("LLM_FALLBACK_BASE_URL") ?? "https://api.groq.com/openai/v1");
        const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
          headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
          signal: signal(),
        });
        if (res.status === 401 || res.status === 403) {
          return rejected(providerId, `${base} refused the key (HTTP ${res.status}).`);
        }
        if (!res.ok) return rejected(providerId, `${base}/models returned HTTP ${res.status}.`);
        const json: any = await res.json().catch(() => null);
        const ids: string[] = Array.isArray(json?.data)
          ? json.data.map((m: any) => String(m?.id ?? "")).filter(Boolean)
          : [];
        // The model list is reported verbatim. Sarvam returns exactly one model
        // and Groq carries none of the Mistral IDs the docs once assumed, so an
        // operator needs to see what is actually there, not what we expected.
        return ok(
          providerId,
          `${base} accepted the key. ${ids.length} model(s) available` +
            `${ids.length ? `: ${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ", …" : ""}` : ""}.`,
        );
      }

      default:
        return {
          providerId,
          status: "unverified",
          detail: `No verification probe is implemented for "${providerId}".`,
          checkedAt: null,
        };
    }
  } catch (err: any) {
    return transportFailure(providerId, err);
  }
}

/** `https://mastodon.social/` and `@mastodon.social` all reduce to the bare host. */
export function normaliseHost(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

// ─── Capability matrix ─────────────────────────────────────────────────────

export interface CapabilityRow {
  providerId: string;
  label: string;
  category: ProviderCategory;
  collectable: boolean;
  /** True when a usable credential resolves from env or the vault. */
  configured: boolean;
  source: "env" | "vault" | null;
  /** Status of the vault entry backing it, when the vault is the source. */
  status: CredentialStatus | null;
  unlocks: string;
  consumedBy: string;
  blockedReason?: string;
}

/**
 * What the deployment can currently collect, computed rather than declared.
 *
 * The UI must never assert a capability from a static list while the deployment
 * lacks the credential behind it — the same rule `socialCredentials` was added
 * for. No secret value appears in the output.
 */
export async function buildCapabilityMatrix(): Promise<CapabilityRow[]> {
  const vault = await readVault();
  const rows: CapabilityRow[] = [];
  for (const def of CREDENTIAL_PROVIDERS) {
    const resolved = def.collectable ? await resolveCredential(def.id) : null;
    const entry = resolved?.entryId
      ? (vault[def.id] ?? []).find((e) => e.id === resolved.entryId)
      : undefined;
    rows.push({
      providerId: def.id,
      label: def.label,
      category: def.category,
      collectable: def.collectable,
      configured: resolved !== null,
      source: resolved?.source ?? null,
      status: entry?.status ?? null,
      unlocks: def.unlocks,
      consumedBy: def.consumedBy,
      blockedReason: def.blockedReason,
    });
  }
  return rows;
}

// ─── Shared header helpers for consumers ───────────────────────────────────

/**
 * Authorization headers for GitHub, or just the User-Agent when no token is
 * configured. Callers keep working unauthenticated — this raises the ceiling,
 * it is not a gate.
 */
export async function githubHeaders(): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "SentinelAI/1.0 (OSINT research)",
  };
  const cred = await resolveCredential("github");
  if (!cred) return base;
  await recordCredentialUse("github", cred.entryId);
  return { ...base, authorization: `Bearer ${cred.secret}` };
}

// ─── Server functions ──────────────────────────────────────────────────────

/** Registry only — static, no secrets, safe to render before any vault read. */
export const listCredentialProviders = createServerFn({ method: "GET" })
  .validator((d: undefined) => d)
  .handler(async () => CREDENTIAL_PROVIDERS);

/** Masked entries plus the computed capability matrix. No secret crosses here. */
export const listCredentials = createServerFn({ method: "GET" })
  .validator((d: undefined) => d)
  .handler(async () => {
    const vault = await readVault();
    return {
      vault: redactVault(vault),
      capabilities: await buildCapabilityMatrix(),
      storagePath: VAULT_PATH,
    };
  });

export const addCredential = createServerFn({ method: "POST" })
  .validator((d: { provider: string; label: string; username: string; secret: string }) => d)
  .handler(async ({ data }) => {
    const def = providerById(data.provider);
    if (!def) {
      throw new CredentialVaultError(
        `Unknown credential provider "${data.provider}".`,
        data.provider,
      );
    }
    const secret = String(data.secret ?? "").trim();
    if (!secret) {
      throw new CredentialVaultError("A secret is required.", data.provider);
    }
    const username = String(data.username ?? "").trim();
    if (def.identifierRequired && !username) {
      throw new CredentialVaultError(`${def.identifierLabel} is required.`, data.provider);
    }

    const vault = await readVault();
    const entry: CredentialEntry = {
      id: `${data.provider}-${Date.now()}`,
      provider: data.provider,
      label: String(data.label ?? "").trim() || `${def.label} credential`,
      username,
      secret,
      // Saving is not testing. A collectable provider starts unverified; a
      // blocked one can never be anything but unusable.
      status: def.collectable ? "unverified" : "unusable",
      lastUsed: null,
      verifiedAt: null,
      verifyDetail: null,
      createdAt: new Date().toISOString(),
    };
    vault[data.provider] = [...(vault[data.provider] ?? []), entry];
    await writeVault(vault);
    return { entry: redactEntry(entry) };
  });

export const deleteCredential = createServerFn({ method: "POST" })
  .validator((d: { provider: string; id: string }) => d)
  .handler(async ({ data }) => {
    const vault = await readVault();
    const before = (vault[data.provider] ?? []).length;
    vault[data.provider] = (vault[data.provider] ?? []).filter((e) => e.id !== data.id);
    if (before === vault[data.provider].length) {
      throw new CredentialVaultError(
        `No credential "${data.id}" is stored for ${data.provider}.`,
        data.provider,
      );
    }
    await writeVault(vault);
    return { removed: data.id };
  });

/**
 * Return one secret in clear.
 *
 * Deliberately separate from `listCredentials` so that rendering the page does
 * not ship every key to the browser — revealing is an explicit act against one
 * entry, and the call is the natural place to hang an audit log when this grows
 * real auth.
 */
export const revealCredential = createServerFn({ method: "POST" })
  .validator((d: { provider: string; id: string }) => d)
  .handler(async ({ data }) => {
    const vault = await readVault();
    const entry = (vault[data.provider] ?? []).find((e) => e.id === data.id);
    if (!entry) {
      throw new CredentialVaultError(
        `No credential "${data.id}" is stored for ${data.provider}.`,
        data.provider,
      );
    }
    return { id: entry.id, secret: entry.secret };
  });

/**
 * Verify a stored credential against the live provider and persist the verdict.
 *
 * The result is written back so the badge in the UI reflects a measurement with
 * a timestamp, rather than a claim made at save time.
 */
export const verifyCredential = createServerFn({ method: "POST" })
  .validator((d: { provider: string; id: string }) => d)
  .handler(async ({ data }) => {
    const vault = await readVault();
    const entry = (vault[data.provider] ?? []).find((e) => e.id === data.id);
    if (!entry) {
      throw new CredentialVaultError(
        `No credential "${data.id}" is stored for ${data.provider}.`,
        data.provider,
      );
    }
    const result = await verifyProviderCredential(data.provider, entry.username, entry.secret);
    entry.status = result.status;
    entry.verifiedAt = result.checkedAt;
    entry.verifyDetail = result.detail;
    await writeVault(vault);
    return { result, entry: redactEntry(entry) };
  });

export const capabilityMatrix = createServerFn({ method: "GET" })
  .validator((d: undefined) => d)
  .handler(async () => buildCapabilityMatrix());

/*
 * WHY THERE IS NO INSTAGRAM OR FACEBOOK COLLECTOR BEHIND THESE ENTRIES.
 *
 * The v1 tree wired this exact file to two scripts that did claim to collect
 * from Meta, and both are the reason the rule exists:
 *
 *   scripts/agent_scraper.py read `credentials.json`, picked the first entry
 *   with status "Active", and logged into Instagram with instaloader. When that
 *   failed it fell back to a Google News RSS query and relabelled the results
 *   as Instagram and Facebook posts with engagement counts derived from
 *   `hash(title) % 500`. When THAT failed it wrote two hardcoded posts with 842
 *   and 420 likes, and printed "AGENT CYCLE COMPLETE."
 *
 *   scripts/agent-scraper.js did the same with Playwright, and without it
 *   generated posts with `Math.floor(Math.random() * 900)` likes.
 *
 * The cache they wrote held 128 records, 100% Instagram or Facebook, 100%
 * invented, and the app rendered them beside its own on-screen statement that
 * those platforms cannot be collected. Both scripts and the reader were deleted
 * on 2026-08-10.
 *
 * The login path was not better than the fabrication path, only rarer: it
 * breaches Meta's terms, gets the account banned, and needs a headless browser
 * the Azure container does not have. So the vault still STORES an Instagram or
 * Facebook credential — operators have them and asked to keep them — and
 * reports it as inert, which is the true state, instead of quietly feeding a
 * scraper that invents its output.
 */
