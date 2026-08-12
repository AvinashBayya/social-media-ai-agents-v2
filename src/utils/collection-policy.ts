/**
 * Collection policy — what may be collected from each source, on what legal
 * basis, and by what route content therefore enters the system.
 *
 * WHY THIS EXISTS AS A MODEL RATHER THAN PROSE.
 *
 * `PLATFORM_NOTES` in social.ts models collection as a **boolean**: the Social
 * Intelligence page renders a green "collected" or a red "unavailable" badge and
 * a paragraph of explanation. That binary cannot express three things the
 * project is actually bound by:
 *
 *   - **Partial permission.** YouTube metadata, comments and captions are
 *     available through the official API; video frames are not. "Available" and
 *     "unavailable" are both wrong answers for YouTube, which is why it had no
 *     entry at all.
 *   - **A manual route.** Instagram and Facebook cannot be collected
 *     automatically, but a public post can still enter the system when an
 *     analyst captures it and attests to it. Rendered as a flat red
 *     "unavailable", that legitimate route looks like a dead end.
 *   - **The basis.** "Not allowed" for commercial reasons (X has no free tier)
 *     and "not allowed" under the DPDP Act 2023 are different facts with
 *     different remedies — one is a budget decision, the other is law. The prose
 *     mixed them together with no machine-readable distinction.
 *
 * Keeping this as data rather than paragraphs means the UI, the collectors and
 * the evidence path all read the same source. A collector that grows a new
 * capability and a policy row that still forbids it become a visible
 * contradiction rather than a page nobody updated.
 *
 * NOTHING HERE IS AN ENFORCEMENT MECHANISM. It is a declaration of what the
 * system is permitted to do and a statement of what it actually does. The
 * enforcement is that no Instagram or Facebook collector exists — see the note
 * at the foot of credential-vault.ts for what happened the last time one did.
 */

// ─── Vocabulary ────────────────────────────────────────────────────────────

/**
 * How content from a source may be collected.
 *
 * Four states rather than a boolean, because "partial" and "manual-only" are
 * the two the old model could not express and they are exactly the two that
 * matter for compliance questions.
 */
export type CollectionMode = "automated" | "partial" | "manual-only" | "none";

export const MODE_LABELS: Record<CollectionMode, string> = {
  automated: "Automated",
  partial: "Partial",
  "manual-only": "Manual only",
  none: "Not collected",
};

/**
 * Why a source sits in its mode.
 *
 * Deliberately separates law from terms from commerce. An evaluator asking "why
 * no Twitter?" is owed "there is no free tier", not the same red badge Instagram
 * gets for a legal prohibition.
 */
export type LegalBasis =
  | "syndication-by-design"
  | "official-api"
  | "platform-tos"
  | "dpdp-act-2023"
  | "no-free-tier";

export const BASIS_LABELS: Record<LegalBasis, string> = {
  "syndication-by-design": "Syndication by design",
  "official-api": "Official API",
  "platform-tos": "Platform terms of service",
  "dpdp-act-2023": "DPDP Act 2023",
  "no-free-tier": "No free tier",
};

export const BASIS_DETAIL: Record<LegalBasis, string> = {
  "syndication-by-design":
    "RSS and Atom exist to be fetched and republished. Consuming a feed is the use the " +
    "publisher built it for, so no further permission is implied or needed.",
  "official-api":
    "A documented API used within its published terms and quota. Permission is the vendor's " +
    "own, and staying inside the quota is part of staying inside the permission.",
  "platform-tos":
    "The platform's terms prohibit automated collection. This binds regardless of whether the " +
    "content is public and regardless of whether a scraper would technically succeed.",
  "dpdp-act-2023":
    "India's Digital Personal Data Protection Act 2023 governs processing of personal data. " +
    "Public visibility is not consent, and bulk collection of posts about identifiable people " +
    "needs a lawful basis independent of technical access.",
  "no-free-tier":
    "Access exists but is priced. This is a budget constraint, not a legal one — it would " +
    "become available under a paid plan, which the zero-budget constraint excludes.",
};

// ─── Policy rows ───────────────────────────────────────────────────────────

export interface CollectionPolicy {
  id: string;
  /** Display names of the sources this row governs. */
  sources: string[];
  mode: CollectionMode;
  /** Every basis that applies, most binding first. */
  basis: LegalBasis[];
  /** Whether automated collection is allowed, and why — the matrix's column 2. */
  rationale: string;
  /** How content actually enters the system — the matrix's column 3. */
  ingestionRoute: string;
  /** For `partial`: what the permission covers. Empty for other modes. */
  permitted: string[];
  /** For `partial`: what it does not cover, and which stays out. */
  withheld: string[];
  /** Whether an analyst upload path exists for this source. */
  manualUploadAllowed: boolean;
  /** Where the collection actually happens, or the reason no code exists. */
  implementedBy: string;
}

/**
 * The matrix. One row per source family.
 *
 * Ordered most-restricted first, so the page leads with the constraint an
 * evaluator will ask about rather than burying it under the sources that work.
 */
export const COLLECTION_POLICIES: CollectionPolicy[] = [
  {
    id: "meta",
    sources: ["Instagram", "Facebook"],
    mode: "manual-only",
    basis: ["platform-tos", "dpdp-act-2023"],
    rationale:
      "No automated collection. Meta's terms prohibit scraping, and the Graph API grants access " +
      "only to Pages and Business accounts the caller already owns — so there is no compliant " +
      "automated route, not merely an unimplemented one. CrowdTangle, the research programme " +
      "that once permitted this, shut down in August 2024. Bulk collection would additionally " +
      "process personal data of identifiable individuals without a lawful basis under the DPDP " +
      "Act 2023.",
    ingestionRoute:
      "An analyst opens a public post, captures it, and uploads that capture with its source " +
      "URL, capture time and attribution. It enters as analyst-attested evidence — hashed, " +
      "provenance-marked, and never presented as collected data.",
    permitted: [],
    withheld: [],
    manualUploadAllowed: true,
    implementedBy:
      "No collector exists, by design. The manual capture panel on /social writes to the " +
      "evidence store; see manual-evidence.ts.",
  },
  {
    id: "youtube",
    sources: ["YouTube"],
    mode: "partial",
    basis: ["official-api", "platform-tos"],
    rationale:
      "Text is permitted, pixels are not. Metadata, comments and captions come from documented " +
      "endpoints. Redistributing or systematically storing video frames is outside the terms, " +
      "so frame extraction is not automated.",
    ingestionRoute:
      "API for metadata, comments and captions. Frames enter only through an analyst-initiated " +
      "download or screen recording of a single video, handed to Module 4 as evidence.",
    permitted: ["Video metadata", "Comments", "Captions and transcripts", "Channel details"],
    withheld: ["Bulk video frame extraction", "Systematic re-hosting of video"],
    manualUploadAllowed: true,
    implementedBy:
      "youtube-collector.ts — InnerTube player for metadata and captions, commentThreads.list " +
      // NOT "audit logged" — no audit trail exists anywhere in this system.
      "for comments. Single-video download is analyst-initiated, and is not recorded: there is " +
      "no audit trail in this build.",
  },
  {
    id: "news-rss",
    sources: ["News (RSS)", "Google News", "GDELT", "Hacker News"],
    mode: "automated",
    basis: ["syndication-by-design"],
    rationale:
      "Allowed. RSS and Atom are published so that they can be fetched and redistributed — " +
      "consuming a feed is the use the publisher built it for.",
    ingestionRoute: "Already automated. Feeds are polled and parsed on the news and OSINT pages.",
    permitted: [],
    withheld: [],
    manualUploadAllowed: false,
    implementedBy: "news.tsx and osint.tsx feed collectors; geo-sources.ts for GDELT.",
  },
  {
    id: "open-social",
    sources: ["Reddit", "Telegram", "Bluesky", "Mastodon"],
    mode: "automated",
    basis: ["official-api"],
    rationale:
      "Allowed through official or openly public APIs: Bluesky's Jetstream firehose and AppView, " +
      "Reddit's OAuth API under a registered script app, Telegram's public channel previews, and " +
      "Mastodon's public timelines.",
    ingestionRoute:
      "Already automated for text. Media the platforms host is collected as URLs and rendered " +
      "from the platform; bytes are fetched only when an analyst sends one asset to Module 4.",
    permitted: [],
    withheld: [],
    manualUploadAllowed: false,
    implementedBy: "social.ts — Jetstream, AppView, Reddit OAuth, t.me previews, Mastodon.",
  },
  {
    id: "x-twitter",
    sources: ["X / Twitter"],
    mode: "none",
    basis: ["no-free-tier"],
    rationale:
      "Not collected. There has been no free API tier for search or streaming since 2023. This " +
      "is a commercial constraint rather than a legal one — it would become available under a " +
      "paid plan, which the zero-budget constraint excludes.",
    ingestionRoute:
      "Nothing enters automatically. An individual public post can be captured manually like " +
      "any other web page.",
    permitted: [],
    withheld: [],
    manualUploadAllowed: true,
    implementedBy: "No collector exists.",
  },
];

// ─── Lookup ────────────────────────────────────────────────────────────────

/** Normalises "X / Twitter", "x/twitter", " Bluesky " to a comparable key. */
function sourceKey(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The policy governing a named source, or null.
 *
 * Null means **no policy has been written for this source**, which is a gap to
 * close rather than a permission to collect. Callers must not read it as
 * "unrestricted" — that inversion is how an unreviewed source ends up collected
 * by default.
 */
export function policyFor(source: string): CollectionPolicy | null {
  const key = sourceKey(source);
  if (!key) return null;
  return (
    COLLECTION_POLICIES.find((p) => p.sources.some((s) => sourceKey(s) === key)) ??
    COLLECTION_POLICIES.find((p) => p.id === key) ??
    null
  );
}

export function policyById(id: string): CollectionPolicy | null {
  return COLLECTION_POLICIES.find((p) => p.id === id) ?? null;
}

/** True when any automated collection at all is permitted for this source. */
export function allowsAutomatedCollection(source: string): boolean {
  const policy = policyFor(source);
  // Unknown source → false. See the note on policyFor: absence of a policy is
  // not permission.
  if (!policy) return false;
  return policy.mode === "automated" || policy.mode === "partial";
}

/**
 * One-line summary for a compact badge or a report footnote.
 *
 * Names the mode and the binding reason together, because either alone
 * misleads: "Partial" without "official API" reads as a capability gap, and
 * "DPDP Act 2023" without "manual only" reads as a blanket prohibition.
 */
export function policySummary(policy: CollectionPolicy): string {
  const bases = policy.basis.map((b) => BASIS_LABELS[b]).join(" + ");
  return `${MODE_LABELS[policy.mode]} — ${bases}`;
}
