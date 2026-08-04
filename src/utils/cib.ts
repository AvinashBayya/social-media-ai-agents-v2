/**
 * Module 3 — Coordinated Inauthentic Behaviour detection (PS-18 §6.3).
 *
 * CALIBRATION, and it governs every design choice below: what this file produces
 * are SIGNALS WARRANTING REVIEW, never a verdict. Coordinated behaviour and
 * inauthentic behaviour are not the same thing. A party's volunteer network, a
 * newsroom's staff accounts, a fandom and a relief effort all post similar text
 * at similar times from many accounts, and every signal here fires on them. The
 * output is a prompt for an analyst to look, not a finding that anyone is a bot.
 *
 * Every signal is computed from observed data and carries an evidence string
 * naming the specific accounts and timings that produced it. The previous
 * implementation set bot likelihood to 88 or 24 depending on a substring test on
 * the cluster name; that is what this replaces. A CIB flag an analyst cannot
 * audit is worthless — worse than worthless in a defence context, because it
 * launders an assertion into a number.
 *
 * A signal that cannot be computed returns null with a stated reason. It never
 * returns 0, because "no evidence of coordination" and "we could not look" are
 * opposite findings.
 *
 * No Math.random(). No fabricated scores.
 */

import type { BlueskyProfile, SocialPost } from "./social";

// ─── The caveat, rendered verbatim in the UI ───────────────────────────────

export const CIB_CAVEAT =
  "These are signals warranting review, not a determination of inauthenticity. " +
  "Organised legitimate campaigns — party volunteers, newsroom accounts, activist " +
  "networks, disaster relief — produce the same patterns as coordinated inauthentic " +
  "operations. Every score below is auditable: expand it to see the accounts and " +
  "timings it was computed from, and check them.";

// ─── Text normalisation ────────────────────────────────────────────────────

/**
 * Strip everything an operator would vary between copies while leaving the
 * message: URLs, mentions, hashtag markers, punctuation, casing, emoji. Two
 * posts differing only in the tracking parameter on a link normalise to the
 * same string, which is exactly the case duplication detection has to catch.
 */
export function normaliseText(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[\w.:-]+/g, " ")
    .replace(/[#$]/g, "")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  const n = normaliseText(text);
  return n ? n.split(" ") : [];
}

/** Jaccard over unigrams. Topic-level similarity — used to form clusters. */
export function contentSimilarity(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared);
}

export const SHINGLE_SIZE = 5;

/**
 * Word k-grams. Phrase-level, so it separates "two accounts discussing one
 * topic" from "two accounts posting the same sentence" — a distinction unigram
 * overlap cannot make, and the whole basis of duplication detection.
 */
export function shingles(text: string, k = SHINGLE_SIZE): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length === 0) return out;
  if (w.length < k) { out.add(w.join(" ")); return out; }
  for (let i = 0; i + k <= w.length; i += 1) out.add(w.slice(i, i + k).join(" "));
  return out;
}

export function shingleSimilarity(a: string, b: string, k = SHINGLE_SIZE): number {
  const sa = shingles(a, k);
  const sb = shingles(b, k);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

// ─── Thresholds ────────────────────────────────────────────────────────────

/** Unigram overlap at which two posts are treated as being about one thing. */
export const CLUSTER_THRESHOLD = 0.5;
/** Shingle overlap at which two posts are near-identical text. */
export const DUPLICATE_THRESHOLD = 0.8;
/**
 * Minimum span of collected data, in minutes, before synchrony means anything.
 *
 * Found by running the detector against the live firehose: 400 posts arrive in
 * about fifteen seconds, so every cluster drawn from that buffer had a timestamp
 * standard deviation near zero and scored 1.00. The signal was measuring the
 * length of the collection window, not the behaviour of the accounts. Below this
 * span the signal is skipped rather than scored.
 */
export const MIN_OBSERVATION_MINUTES = 10;

/**
 * Standard deviation of N points drawn uniformly across a window of width W is
 * W/sqrt(12). That is the null hypothesis — what "not coordinated" looks like —
 * and it is what an observed spread is compared against, so the score means
 * "concentrated relative to the window we watched" rather than "close together
 * in absolute minutes".
 */
const UNIFORM_SD_FACTOR = 1 / Math.sqrt(12);
/** Window within which reposts of one URI count as a single amplification push. */
export const AMPLIFICATION_WINDOW_MINUTES = 30;
/** Composite at or above which a cluster is surfaced for review. */
export const CIB_REVIEW_THRESHOLD = 0.6;
/** An account younger than this is treated as new for the maturity signal. */
export const YOUNG_ACCOUNT_DAYS = 30;
/** Posts per day above which output volume is itself notable. */
export const HIGH_POST_RATE = 50;

// ─── Signal shape ──────────────────────────────────────────────────────────

export type SignalId =
  | "temporal_synchrony"
  | "content_duplication"
  | "account_maturity"
  | "handle_patterns"
  | "amplification";

export interface CibSignal {
  id: SignalId;
  label: string;
  /**
   * 0-1, or null when the signal could not be computed. Null is not a low score:
   * it means the data required was absent, and the UI must render it as such.
   */
  score: number | null;
  /**
   * Names the specific accounts, timings and text that produced the score. This
   * is the deliverable — the number is only an index into it.
   */
  evidence: string;
  /** Accounts the evidence implicates. */
  accounts: string[];
  /** Present only when score is null. */
  skipped?: string;
}

export interface DuplicateGroup {
  /** Normalised text shared by the group. */
  text: string;
  members: { account: string; postId: string; createdAt: string; url: string }[];
}

export interface CibCluster {
  /** Id of the earliest post in the cluster. */
  id: string;
  posts: SocialPost[];
  /** Distinct account identifiers in the cluster. */
  accounts: string[];
  signals: CibSignal[];
  duplicateGroups: DuplicateGroup[];
  /** Mean of the signals that could be computed, or null if none could. */
  compositeScore: number | null;
  signalsComputed: number;
  signalsSkipped: number;
  /** compositeScore >= CIB_REVIEW_THRESHOLD. Never a claim of inauthenticity. */
  flagged: boolean;
  earliest: string;
  latest: string;
  /** Standard deviation of posting times, in minutes. Null with fewer than 2 dated posts. */
  timeStdDevMinutes: number | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const timeOf = (p: SocialPost): number => {
  const t = new Date(p.createdAt).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const distinctAccounts = (posts: SocialPost[]): string[] =>
  Array.from(new Set(posts.map((p) => p.authorId).filter(Boolean)));

/** Display name for an account: the handle when resolved, else the raw id. */
const nameOf = (post: SocialPost): string => post.author || post.authorId;

function stdDevMinutes(posts: SocialPost[]): number | null {
  const times = posts.map(timeOf).filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const variance = times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length;
  return Math.sqrt(variance) / 60_000;
}

function fmtTime(iso: string): string {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString().replace("T", " ").slice(0, 19) + "Z" : "undated";
}

class UnionFind {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// ─── 1. Temporal synchrony ─────────────────────────────────────────────────

/**
 * Similar content posted within a tight window by DISTINCT accounts.
 *
 * The distinct-account requirement is what separates this from "an account is
 * posting a lot". One account firing five near-identical posts in a minute is a
 * spam pattern, not coordination, and returns null here rather than a high score
 * — the single most important false positive to exclude, since a busy news
 * account trips it constantly.
 */
export function temporalSynchrony(
  posts: SocialPost[],
  observationWindowMinutes?: number,
): CibSignal {
  const accounts = distinctAccounts(posts);
  const base: CibSignal = {
    id: "temporal_synchrony",
    label: "Temporal synchrony",
    score: null,
    evidence: "",
    accounts,
  };

  if (accounts.length < 2) {
    return {
      ...base,
      skipped:
        `Only ${accounts.length} distinct account in this group. Synchrony is a property of ` +
        `multiple accounts acting together; rapid posting by one account is a different ` +
        `pattern and is not scored here.`,
    };
  }

  const dated = posts.filter((p) => Number.isFinite(timeOf(p)));
  if (dated.length < 2) {
    return { ...base, skipped: "Fewer than two posts in this group carry a usable timestamp." };
  }

  const ordered = [...dated].sort((a, b) => timeOf(a) - timeOf(b));
  const spanMinutes = (timeOf(ordered[ordered.length - 1]) - timeOf(ordered[0])) / 60_000;

  // Without a corpus window supplied, the cluster's own span is all we have —
  // which is exactly the case the guard below is for.
  const window = observationWindowMinutes ?? spanMinutes;

  if (window < MIN_OBSERVATION_MINUTES) {
    return {
      ...base,
      skipped:
        `The collected window spans only ${window.toFixed(1)} minutes. Every post in a window ` +
        `that short is necessarily close in time, so concentration cannot be distinguished ` +
        `from the collection window itself. Collect at least ${MIN_OBSERVATION_MINUTES} ` +
        `minutes before reading synchrony.`,
    };
  }

  const sd = stdDevMinutes(dated)!;
  // Expected spread if these posts were scattered uniformly across the window.
  const expected = window * UNIFORM_SD_FACTOR;
  const score = Math.max(0, Math.min(1, 1 - sd / expected));

  const sample = ordered
    .slice(0, 5)
    .map((p) => `${nameOf(p)} at ${fmtTime(p.createdAt)}`)
    .join("; ");

  return {
    ...base,
    score,
    evidence:
      `${accounts.length} accounts posted similar content within ${spanMinutes.toFixed(1)} minutes ` +
      `(standard deviation ${sd.toFixed(1)} min). Across the ${window.toFixed(0)}-minute window ` +
      `collected, uniformly scattered posting would give about ${expected.toFixed(1)} min. ` +
      `First five: ${sample}.`,
  };
}

// ─── 2. Content duplication ────────────────────────────────────────────────

/**
 * Near-identical text across DIFFERENT accounts, by 5-word shingle overlap.
 *
 * Cross-account is the operative constraint. A thread where one author repeats
 * themselves is not duplication in the sense that matters; two strangers posting
 * the same sentence is.
 */
export function contentDuplication(posts: SocialPost[]): {
  signal: CibSignal;
  groups: DuplicateGroup[];
} {
  const accounts = distinctAccounts(posts);
  const base: CibSignal = {
    id: "content_duplication",
    label: "Content duplication",
    score: null,
    evidence: "",
    accounts,
  };

  if (posts.length < 2 || accounts.length < 2) {
    return {
      signal: {
        ...base,
        skipped:
          `Needs at least two posts from two distinct accounts; this group has ` +
          `${posts.length} post(s) from ${accounts.length} account(s).`,
      },
      groups: [],
    };
  }

  const uf = new UnionFind(posts.length);
  for (let i = 0; i < posts.length; i += 1) {
    for (let j = i + 1; j < posts.length; j += 1) {
      if (posts[i].authorId === posts[j].authorId) continue;
      if (shingleSimilarity(posts[i].text, posts[j].text) >= DUPLICATE_THRESHOLD) uf.union(i, j);
    }
  }

  const byRoot = new Map<number, SocialPost[]>();
  posts.forEach((p, i) => {
    const r = uf.find(i);
    const list = byRoot.get(r);
    if (list) list.push(p); else byRoot.set(r, [p]);
  });

  const groups: DuplicateGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    if (distinctAccounts(members).length < 2) continue;
    groups.push({
      text: normaliseText(members[0].text).slice(0, 240),
      members: members.map((m) => ({
        account: nameOf(m),
        postId: m.id,
        createdAt: m.createdAt,
        url: m.url,
      })),
    });
  }

  const duplicated = groups.reduce((s, g) => s + g.members.length, 0);
  const score = duplicated / posts.length;

  if (groups.length === 0) {
    return {
      signal: {
        ...base,
        score: 0,
        evidence:
          `No two accounts in this group posted text sharing ${(DUPLICATE_THRESHOLD * 100).toFixed(0)}% ` +
          `of their 5-word phrases. The posts are about the same subject but are independently written.`,
      },
      groups: [],
    };
  }

  const biggest = [...groups].sort((a, b) => b.members.length - a.members.length)[0];
  return {
    signal: {
      ...base,
      score,
      evidence:
        `${duplicated} of ${posts.length} posts fall into ${groups.length} near-duplicate ` +
        `group(s). Largest: ${biggest.members.length} accounts posting the same text — ` +
        `${biggest.members.slice(0, 5).map((m) => `${m.account} at ${fmtTime(m.createdAt)}`).join("; ")}. ` +
        `Text: "${biggest.text.slice(0, 120)}${biggest.text.length > 120 ? "…" : ""}".`,
    },
    groups,
  };
}

// ─── 3. Account maturity ───────────────────────────────────────────────────

export interface MaturityFinding {
  account: string;
  ageDays: number | null;
  postsCount: number | null;
  followersCount: number | null;
  postsPerDay: number | null;
  concern: number;
  note: string;
}

/**
 * Account age against output and reach, from the AppView's own createdAt.
 *
 * Returns the actual numbers as evidence, never a bare score: "3 days old, 412
 * posts, 6 followers" is a fact an analyst can verify in one click, whereas
 * "maturity 0.87" is an assertion.
 */
export function accountMaturity(
  posts: SocialPost[],
  profiles: BlueskyProfile[],
  now = Date.now(),
): { signal: CibSignal; findings: MaturityFinding[] } {
  const accounts = distinctAccounts(posts);
  const base: CibSignal = {
    id: "account_maturity",
    label: "Account maturity",
    score: null,
    evidence: "",
    accounts,
  };

  const byId = new Map<string, BlueskyProfile>();
  for (const p of profiles) {
    if (p.did) byId.set(p.did, p);
    if (p.handle) byId.set(p.handle, p);
  }

  const findings: MaturityFinding[] = [];
  for (const account of accounts) {
    const profile = byId.get(account);
    if (!profile || !profile.createdAt) continue;
    const created = new Date(profile.createdAt).getTime();
    if (!Number.isFinite(created)) continue;

    const ageDays = (now - created) / 86_400_000;
    const postsCount = profile.postsCount;
    const followersCount = profile.followersCount;
    const postsPerDay = postsCount !== null && ageDays > 0 ? postsCount / ageDays : null;

    // Three independent observations, each contributing at most a third. No
    // component is invented: each is a ratio of two numbers the AppView reported.
    let concern = 0;
    const notes: string[] = [];

    if (ageDays < YOUNG_ACCOUNT_DAYS) {
      concern += (1 - ageDays / YOUNG_ACCOUNT_DAYS) / 3;
      notes.push(`${ageDays.toFixed(1)} days old`);
    } else {
      notes.push(`${Math.round(ageDays)} days old`);
    }

    if (postsPerDay !== null) {
      concern += Math.min(1, postsPerDay / HIGH_POST_RATE) / 3;
      notes.push(`${postsCount} posts (${postsPerDay.toFixed(1)}/day)`);
    }

    // High output with almost no audience: posting into a void is characteristic
    // of an account built to inflate a count rather than to be read.
    if (followersCount !== null && postsCount !== null && postsCount > 20) {
      const ratio = followersCount / postsCount;
      if (ratio < 0.1) {
        concern += Math.min(1, (0.1 - ratio) / 0.1) / 3;
      }
      notes.push(`${followersCount} followers`);
    }

    findings.push({
      account: profile.handle || account,
      ageDays,
      postsCount,
      followersCount,
      postsPerDay,
      concern: Math.min(1, concern),
      note: notes.join(", "),
    });
  }

  if (findings.length === 0) {
    return {
      signal: {
        ...base,
        skipped:
          `No profile data was retrieved for the ${accounts.length} account(s) in this group. ` +
          `Maturity cannot be assessed from post content alone — fetch profiles to enable it.`,
      },
      findings: [],
    };
  }

  const score = findings.reduce((s, f) => s + f.concern, 0) / findings.length;
  const worst = [...findings].sort((a, b) => b.concern - a.concern).slice(0, 5);
  const unresolved = accounts.length - findings.length;

  return {
    signal: {
      ...base,
      score,
      evidence:
        `Profiles resolved for ${findings.length} of ${accounts.length} accounts` +
        `${unresolved > 0 ? ` (${unresolved} unresolved and excluded from the mean)` : ""}. ` +
        worst.map((f) => `${f.account}: ${f.note}`).join("; ") + ".",
    },
    findings,
  };
}

// ─── 4. Handle patterns ────────────────────────────────────────────────────

export interface HandleFamily {
  stem: string;
  members: string[];
  suffixes: string[];
  sequential: boolean;
}

/** Split a handle into a stem and a trailing numeric or fixed-length alphanumeric suffix. */
function splitHandle(handle: string): { stem: string; suffix: string } | null {
  // Drop the domain part of an AT-Protocol handle: alice1234.bsky.social.
  const local = handle.replace(/^@/, "").split(".")[0];
  const m = /^(.*?)(\d{2,})$/.exec(local);
  if (m && m[1].length >= 2) return { stem: m[1], suffix: m[2] };
  const r = /^(.*?)([a-z0-9]{6,})$/.exec(local);
  if (r && r[1].length >= 3) return { stem: r[1], suffix: r[2] };
  return null;
}

/**
 * Handle families: several accounts sharing a stem with numeric or random-looking
 * suffixes, e.g. user1234 / user1235 / user1237.
 *
 * Only meaningful on RESOLVED handles. A Jetstream event carries a DID, and every
 * DID looks like a random-suffix family, so running this on unresolved DIDs would
 * flag the entire network. It returns null in that case rather than a score.
 */
export function handlePatterns(posts: SocialPost[]): { signal: CibSignal; families: HandleFamily[] } {
  const accounts = distinctAccounts(posts);
  const base: CibSignal = {
    id: "handle_patterns",
    label: "Handle patterns",
    score: null,
    evidence: "",
    accounts,
  };

  const handles = Array.from(
    new Set(posts.map((p) => p.author).filter((h) => h && !h.startsWith("did:"))),
  );

  if (handles.length < 3) {
    return {
      signal: {
        ...base,
        skipped:
          handles.length === 0
            ? `No handles have been resolved for this group — Jetstream carries DIDs, and every ` +
              `DID has a random-looking suffix, so scoring them would flag the entire network. ` +
              `Resolve handles via the AppView to enable this signal.`
            : `Only ${handles.length} resolved handle(s); a family needs at least 3 to be more ` +
              `than a coincidence.`,
      },
      families: [],
    };
  }

  const byStem = new Map<string, { members: string[]; suffixes: string[] }>();
  for (const h of handles) {
    const parts = splitHandle(h);
    if (!parts) continue;
    const entry = byStem.get(parts.stem) ?? { members: [], suffixes: [] };
    entry.members.push(h);
    entry.suffixes.push(parts.suffix);
    byStem.set(parts.stem, entry);
  }

  const families: HandleFamily[] = [];
  for (const [stem, entry] of byStem) {
    if (entry.members.length < 3) continue;
    const numeric = entry.suffixes.filter((s) => /^\d+$/.test(s)).map(Number).sort((a, b) => a - b);
    // Sequential means the numbers occupy a tight range, not that they are exactly
    // consecutive — operators skip taken handles.
    const sequential =
      numeric.length >= 3 && numeric[numeric.length - 1] - numeric[0] <= numeric.length * 3;
    families.push({ stem, members: entry.members, suffixes: entry.suffixes, sequential });
  }

  if (families.length === 0) {
    return {
      signal: {
        ...base,
        score: 0,
        evidence:
          `${handles.length} resolved handles show no shared stem with numeric or ` +
          `fixed-length suffixes. Handles appear independently chosen.`,
      },
      families: [],
    };
  }

  const inFamilies = families.reduce((s, f) => s + f.members.length, 0);
  const share = Math.min(1, inFamilies / handles.length);
  // A sequential family is a stronger observation than a merely shared stem.
  const sequentialBoost = families.some((f) => f.sequential) ? 0.2 : 0;
  const score = Math.min(1, share + sequentialBoost);

  const biggest = [...families].sort((a, b) => b.members.length - a.members.length)[0];
  return {
    signal: {
      ...base,
      score,
      evidence:
        `${inFamilies} of ${handles.length} resolved handles fall into ${families.length} ` +
        `family/families sharing a stem. Largest: "${biggest.stem}" — ${biggest.members.slice(0, 8).join(", ")}` +
        `${biggest.sequential ? ` (suffixes ${biggest.suffixes.slice(0, 8).join(", ")} occupy a contiguous range)` : ""}.`,
    },
    families,
  };
}

// ─── 5. Amplification ──────────────────────────────────────────────────────

export interface AmplifiedTarget {
  uri: string;
  accounts: string[];
  windowMinutes: number;
  first: string;
  last: string;
}

/**
 * One URI pushed by many accounts inside a short window.
 *
 * Scoped to a window because reach over days is popularity; reach inside half an
 * hour from accounts that would not otherwise coincide is a push.
 */
export function amplification(posts: SocialPost[]): {
  signal: CibSignal;
  targets: AmplifiedTarget[];
} {
  const accounts = distinctAccounts(posts);
  const base: CibSignal = {
    id: "amplification",
    label: "Amplification",
    score: null,
    evidence: "",
    accounts,
  };

  const byUri = new Map<string, SocialPost[]>();
  for (const p of posts) {
    for (const link of p.links) {
      // Strip tracking parameters so the same target is not split into variants.
      const key = link.split("?")[0].replace(/\/+$/, "");
      if (!key) continue;
      const list = byUri.get(key);
      if (list) list.push(p); else byUri.set(key, [p]);
    }
  }

  if (byUri.size === 0) {
    return {
      signal: {
        ...base,
        skipped: "No post in this group carries an external link or quoted record to amplify.",
      },
      targets: [],
    };
  }

  const targets: AmplifiedTarget[] = [];
  for (const [uri, sharers] of byUri) {
    const dated = sharers.filter((p) => Number.isFinite(timeOf(p)));
    const uniqueAccounts = distinctAccounts(sharers);
    if (uniqueAccounts.length < 2) continue;
    if (dated.length < 2) continue;

    const ordered = [...dated].sort((a, b) => timeOf(a) - timeOf(b));
    const windowMinutes = (timeOf(ordered[ordered.length - 1]) - timeOf(ordered[0])) / 60_000;
    if (windowMinutes > AMPLIFICATION_WINDOW_MINUTES) continue;

    targets.push({
      uri,
      accounts: uniqueAccounts,
      windowMinutes,
      first: ordered[0].createdAt,
      last: ordered[ordered.length - 1].createdAt,
    });
  }

  if (targets.length === 0) {
    return {
      signal: {
        ...base,
        score: 0,
        evidence:
          `${byUri.size} distinct link(s) appear in this group, none shared by two or more ` +
          `accounts within ${AMPLIFICATION_WINDOW_MINUTES} minutes.`,
      },
      targets: [],
    };
  }

  const strongest = [...targets].sort((a, b) => b.accounts.length - a.accounts.length)[0];
  // Scale against the group: every account pushing one link is the maximum.
  const score = accounts.length > 0
    ? Math.min(1, strongest.accounts.length / accounts.length)
    : 0;

  return {
    signal: {
      ...base,
      score,
      evidence:
        `${strongest.accounts.length} of ${accounts.length} accounts shared ${strongest.uri} ` +
        `within ${strongest.windowMinutes.toFixed(1)} minutes ` +
        `(${fmtTime(strongest.first)} to ${fmtTime(strongest.last)}): ` +
        `${strongest.accounts.slice(0, 8).join(", ")}` +
        `${targets.length > 1 ? `. ${targets.length - 1} further link(s) show the same pattern.` : "."}`,
    },
    targets,
  };
}

// ─── Cluster assembly ──────────────────────────────────────────────────────

/** Group posts by topic-level text similarity. */
export function clusterPosts(posts: SocialPost[], threshold = CLUSTER_THRESHOLD): SocialPost[][] {
  if (posts.length === 0) return [];
  const uf = new UnionFind(posts.length);
  for (let i = 0; i < posts.length; i += 1) {
    for (let j = i + 1; j < posts.length; j += 1) {
      if (contentSimilarity(posts[i].text, posts[j].text) >= threshold) uf.union(i, j);
    }
  }
  const byRoot = new Map<number, SocialPost[]>();
  posts.forEach((p, i) => {
    const r = uf.find(i);
    const list = byRoot.get(r);
    if (list) list.push(p); else byRoot.set(r, [p]);
  });
  return Array.from(byRoot.values());
}

export interface AnalyseOptions {
  profiles?: BlueskyProfile[];
  now?: number;
  /** Clusters smaller than this are not assessed; two posts is not a campaign. */
  minClusterSize?: number;
  /**
   * Span of the whole collection the cluster was drawn from, in minutes. This is
   * what a cluster's timestamp concentration is judged against — without it, a
   * fifteen-second firehose sample makes every cluster look perfectly
   * synchronised. analyseCib() computes it from its input.
   */
  observationWindowMinutes?: number;
}

/**
 * Span of a post set in minutes, measured between the 5th and 95th percentile
 * rather than min to max.
 *
 * createdAt is declared by the author's client, not observed by us: one post
 * backdated to 2020 would stretch a min-to-max window to years, inflate the
 * expected spread accordingly, and make every cluster in the buffer look
 * tightly synchronised. Trimming the tails costs a little sensitivity and
 * removes that whole failure mode — the right trade for a detector whose worst
 * outcome is a false positive.
 */
export function observationWindowOf(posts: SocialPost[]): number {
  const times = posts.map(timeOf).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (times.length < 2) return 0;
  if (times.length < 20) return (times[times.length - 1] - times[0]) / 60_000;
  const lo = times[Math.floor(times.length * 0.05)];
  const hi = times[Math.ceil(times.length * 0.95) - 1];
  return (hi - lo) / 60_000;
}

/**
 * Run every signal over one group of posts.
 *
 * The composite is the MEAN OF THE SIGNALS THAT COULD BE COMPUTED. Skipped
 * signals are excluded rather than counted as zero: treating "we could not fetch
 * profiles" as "these accounts are mature" would quietly suppress the score, and
 * the count of what was skipped is reported alongside so the analyst can see how
 * much of the picture is missing.
 */
export function assessCluster(posts: SocialPost[], options: AnalyseOptions = {}): CibCluster {
  const now = options.now ?? Date.now();
  const ordered = [...posts].sort((a, b) => {
    const ta = timeOf(a), tb = timeOf(b);
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return ta - tb;
  });

  const synchrony = temporalSynchrony(ordered, options.observationWindowMinutes);
  const duplication = contentDuplication(ordered);
  const maturity = accountMaturity(ordered, options.profiles ?? [], now);
  const handles = handlePatterns(ordered);
  const amplify = amplification(ordered);

  const signals: CibSignal[] = [
    synchrony,
    duplication.signal,
    maturity.signal,
    handles.signal,
    amplify.signal,
  ];

  const computed = signals.filter((s) => s.score !== null);
  const compositeScore = computed.length
    ? computed.reduce((s, x) => s + (x.score ?? 0), 0) / computed.length
    : null;

  const dated = ordered.filter((p) => Number.isFinite(timeOf(p)));

  return {
    id: ordered[0]?.id ?? "empty",
    posts: ordered,
    accounts: distinctAccounts(ordered),
    signals,
    duplicateGroups: duplication.groups,
    compositeScore,
    signalsComputed: computed.length,
    signalsSkipped: signals.length - computed.length,
    flagged: compositeScore !== null && compositeScore >= CIB_REVIEW_THRESHOLD,
    earliest: dated[0]?.createdAt ?? "",
    latest: dated[dated.length - 1]?.createdAt ?? "",
    timeStdDevMinutes: stdDevMinutes(ordered),
  };
}

/**
 * Cluster a post set and assess every cluster, strongest signal first.
 *
 * Single-account clusters are assessed but will skip synchrony, duplication and
 * amplification by construction, so they cannot reach the review threshold on
 * volume alone. That is deliberate: one prolific account is not coordination.
 */
export function analyseCib(posts: SocialPost[], options: AnalyseOptions = {}): CibCluster[] {
  const minSize = options.minClusterSize ?? 2;
  // Measured once from the whole input: a cluster's concentration is only
  // meaningful relative to the window it was drawn from.
  const withWindow: AnalyseOptions = {
    ...options,
    observationWindowMinutes: options.observationWindowMinutes ?? observationWindowOf(posts),
  };
  return clusterPosts(posts)
    .filter((group) => group.length >= minSize)
    .map((group) => assessCluster(group, withWindow))
    .sort(
      (a, b) =>
        (b.compositeScore ?? -1) - (a.compositeScore ?? -1) ||
        b.posts.length - a.posts.length,
    );
}
