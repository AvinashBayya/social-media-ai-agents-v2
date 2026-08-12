/**
 * Conversions between the frozen contracts in `./core.ts` and the internal
 * working types the modules already use.
 *
 * There is exactly ONE conversion point per type. Scattering `publishedAt →
 * pubDate` mappings through the routes is how two shapes quietly diverge, so
 * every crossing goes through here and every lossy crossing says what it lost.
 *
 * Direction of dependency: this file imports from `src/utils/*`, never the
 * reverse. The modules stay unaware the contract exists, which is what keeps
 * the contract free to change without a module rewrite.
 */

import { domainOf, type Article as AnalysisArticle } from "../utils/analysis";
import { isRealCoordinate } from "../utils/geo";
import type { SocialPost } from "../utils/social";
import type { Article, GeoPoint, GeoPrecision, Post } from "./core";

// ─── Article ───────────────────────────────────────────────────────────────

/** Contract → internal. Total: the internal shape is a strict subset. */
export function toAnalysisArticle(article: Article): AnalysisArticle {
  return {
    id: article.id,
    title: article.title,
    source: article.source,
    url: article.url,
    pubDate: article.publishedAt,
    // The internal type treats an absent body as `undefined`; the contract uses
    // "" for "the feed shipped none". Both mean the same thing to every reader
    // of `body`, and `citation_depth` skips on either.
    body: article.body || undefined,
  };
}

/**
 * Internal → contract.
 *
 * `domain` is derived rather than required, because the internal type never
 * carried one — `domainOf` is the same resolver Module 1 scores against, so a
 * contract domain and a credibility lookup can never disagree.
 *
 * `lang` and `images` have no internal source at all. They default to null and
 * empty, which is honest — "not detected" and "none recorded" — but it does
 * mean a round-trip through the internal type drops them. Pass `extra` to
 * preserve values the caller still holds.
 */
export function fromAnalysisArticle(
  article: AnalysisArticle,
  extra: { lang?: string | null; images?: string[] } = {},
): Article {
  return {
    id: article.id,
    title: article.title,
    body: article.body ?? "",
    url: article.url,
    source: article.source,
    domain: domainOf(article.url) || domainOf(article.source),
    publishedAt: article.pubDate,
    lang: extra.lang ?? null,
    images: extra.images ?? [],
  };
}

// ─── Post ──────────────────────────────────────────────────────────────────

/** What a contract-sourced post could not supply, and what that disables. */
export interface PostDegradation {
  field: string;
  consequence: string;
}

/**
 * Why a contract-sourced post never carries media, stated once at the seam.
 *
 * The frozen `Post` has no media field, and widening it is a contract change
 * rather than the additive one the freeze permits. Media crosses to Dev 1 as
 * `MediaAsset` after analysis instead — `MediaAssetSchema` already names
 * "analyst upload" among its sources and carries the hashes and provenance that
 * a bare URL on a Post could not.
 *
 * The consequence for a reader is that `SocialPost.media` is left **undefined**
 * on a contract-sourced post, never `[]`. Undefined means not collected; `[]`
 * means an extractor ran and the post genuinely had none. Collapsing them would
 * show a post that really carried four images as a clean text-only record.
 */
export const CONTRACT_MEDIA_LIMITATION =
  "The frozen Post contract carries no media field, so images and video on a contract-sourced " +
  "post are not transferred with it. Their absence here is 'not collected', not 'the post had " +
  "none' — media reaches Module 4 as a MediaAsset after analysis, not as a URL on a Post.";

/**
 * Contract → internal.
 *
 * LOSSY IN ONE DIRECTION, and that matters. Appendix B's Post has no stable
 * account id and no links, both of which Module 3's coordination signals
 * depend on. This returns what was missing rather than filling the gaps,
 * because a CIB analysis silently missing two of its inputs would report a
 * cleaner picture than the evidence supports — and `cib.ts` is built on the
 * rule that an uncomputable signal returns null with a reason, never 0.
 *
 * `authorId` falls back to the handle so grouping still works, but the caller
 * is told, because a handle is not stable: an account that renames looks like
 * two accounts, which is exactly the evasion handle-family detection exists to
 * catch.
 */
export function toSocialPost(post: Post): {
  post: SocialPost;
  degraded: PostDegradation[];
} {
  const degraded: PostDegradation[] = [];

  if (post.authorId === undefined) {
    degraded.push({
      field: "authorId",
      consequence:
        "No stable account id, so the handle is used instead. Handle-family detection " +
        "cannot follow an account that renamed, and will read it as two accounts.",
    });
  }
  if (post.links === undefined) {
    degraded.push({
      field: "links",
      consequence:
        "No outbound links, so amplification detection has nothing to match on and " +
        "must report itself as not computed.",
    });
  }
  if (post.langs === undefined) {
    degraded.push({
      field: "langs",
      consequence: "No declared language tags, so language-mix signals are unavailable.",
    });
  }
  // NOTE ON MEDIA — deliberately NOT pushed into `degraded`.
  //
  // `degraded` means "the producer could have supplied this and did not", which
  // is why a fully populated fixture must report zero entries. Media is not that
  // kind of gap: the frozen Post has no media field at all, so no producer can
  // ever supply it and flagging it on every post would make the list describe
  // the seam rather than the record, and stop distinguishing a thin producer
  // from a complete one.
  //
  // The limitation is real and is stated once, as CONTRACT_MEDIA_LIMITATION
  // below, for the UI to surface at the seam instead of per post.
  return {
    post: {
      id: post.id,
      platform: post.platform,
      author: post.author,
      authorId: post.authorId ?? post.author,
      text: post.text,
      createdAt: post.createdAt,
      url: post.uri,
      langs: post.langs ?? [],
      links: post.links ?? [],
    },
    degraded,
  };
}

/**
 * Platforms the FROZEN contract can represent.
 *
 * `PlatformSchema` in core.ts is `["bluesky", "reddit", "telegram"]`, frozen
 * 2026-08-06. The internal `Platform` union in social.ts has since gained
 * "mastodon", so the two are no longer the same set and this adapter is where
 * that shows up.
 *
 * Widening a frozen enum is NOT the additive change the freeze permits. New
 * optional fields are safe because a consumer that ignores them still behaves
 * correctly; a new enum member is different — every consumer switching on
 * `platform` (Dev 1's and Dev 2's code, which this repo does not contain) would
 * silently fall through its default branch on a value it has never seen. That
 * needs the joint re-freeze CLAUDE.md describes, not a one-line edit here.
 */
const CONTRACT_PLATFORMS = new Set<Post["platform"]>(["bluesky", "reddit", "telegram"]);

function isContractPlatform(platform: SocialPost["platform"]): platform is Post["platform"] {
  return CONTRACT_PLATFORMS.has(platform as Post["platform"]);
}

/**
 * Internal → contract. Lossless: the extension fields exist precisely so a post
 * this system collected itself survives the round trip intact.
 *
 * `accountAgeDays` is not derivable from a post alone — it needs a profile
 * fetch — so it is a required argument. Passing null is correct when no profile
 * was retrieved; it must never be defaulted to a number.
 *
 * THROWS for a platform the contract does not define. The alternatives were both
 * worse: casting would emit a Post whose `platform` fails `parsePost` downstream
 * with a far less useful message, and mapping Mastodon onto one of the three
 * existing values would attribute a post to a platform it did not come from —
 * fabricated provenance on a record that feeds credibility scoring.
 */
export function fromSocialPost(post: SocialPost, accountAgeDays: number | null): Post {
  if (!isContractPlatform(post.platform)) {
    throw new Error(
      `Post ${post.id} is from "${post.platform}", which the frozen Post contract does not ` +
        `define (it allows ${[...CONTRACT_PLATFORMS].join(", ")}). The shape was frozen ` +
        `2026-08-06 and adding a platform is a joint re-freeze with Dev 1 and Dev 2, not a ` +
        `local change — every consumer switching on platform would fall through on the new ` +
        `value. Until then, ${post.platform} posts are usable inside this system but must not ` +
        `cross the developer boundary.`,
    );
  }

  return {
    id: post.id,
    platform: post.platform,
    author: post.author,
    text: post.text,
    createdAt: post.createdAt,
    accountAgeDays,
    uri: post.url,
    authorId: post.authorId,
    langs: post.langs,
    links: post.links,
  };
}

// ─── Coordinates ───────────────────────────────────────────────────────────

/**
 * Build a contract GeoPoint, or null when the coordinate is not real.
 *
 * Enforces the coordinate-honesty rule at the boundary, so an unplaceable
 * record cannot enter the system as `0,0` and be plotted as the null island.
 * Callers count the nulls and report them as unplaceable — never approximate
 * them onto the map.
 */
export function toGeoPoint(lat: unknown, lon: unknown, precision: GeoPrecision): GeoPoint | null {
  if (!isRealCoordinate(lat, lon)) return null;
  return { lat: lat as number, lon: lon as number, precision };
}

// ─── OSINT Findings Adapters ─────────────────────────────────────────────

export interface GpsJamFindingInput {
  h3: string;
  lat: number;
  lon: number;
  level: "medium" | "high";
  pct: number;
  affectedAircraft: number;
  totalAircraft: number;
}

export function toGpsJamFinding(input: GpsJamFindingInput) {
  const geo = toGeoPoint(input.lat, input.lon, "city");
  return {
    id: `gpsjam-${input.h3}`,
    title: `GPS Interference (${input.level.toUpperCase()}) — ${input.pct.toFixed(1)}% aircraft affected`,
    category: "infrastructure" as const,
    severity: input.level === "high" ? ("high" as const) : ("medium" as const),
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    details: `${input.affectedAircraft}/${input.totalAircraft} aircraft reported GPS jamming in hex ${input.h3}`,
  };
}
