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
 * Internal → contract. Lossless: the extension fields exist precisely so a post
 * this system collected itself survives the round trip intact.
 *
 * `accountAgeDays` is not derivable from a post alone — it needs a profile
 * fetch — so it is a required argument. Passing null is correct when no profile
 * was retrieved; it must never be defaulted to a number.
 */
export function fromSocialPost(post: SocialPost, accountAgeDays: number | null): Post {
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
