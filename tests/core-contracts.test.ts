/**
 * Contract enforcement tests.
 *
 * These exist because the contracts are a promise to two other developers. A
 * shape that is only asserted in TypeScript is erased at runtime, so the moment
 * data arrives as JSON from another process the guarantee is gone. Everything
 * here tests the RUNTIME boundary.
 */

import { describe, expect, test } from "bun:test";
import {
  ArticleSchema,
  ContractViolationError,
  EntitySchema,
  FindingSchema,
  MediaAssetSchema,
  PostSchema,
  VideoAssetSchema,
  parseArticle,
  parseEntity,
  parseFinding,
  parseMany,
  parseMediaAsset,
  parsePost,
  parseVideoAsset,
} from "../src/types/core";
import {
  fromAnalysisArticle,
  fromSocialPost,
  toAnalysisArticle,
  toGeoPoint,
  toSocialPost,
} from "../src/types/core-adapters";
import {
  ARTICLES_FIXTURE,
  ARTICLE_FIXTURE,
  ARTICLE_FIXTURE_SPARSE,
  ENTITIES_FIXTURE,
  ENTITY_FIXTURE,
  FINDINGS_FIXTURE,
  FINDING_FIXTURE_GEO,
  INVALID,
  MEDIA_ASSETS_FIXTURE,
  MEDIA_ASSET_FIXTURE,
  POSTS_FIXTURE,
  POST_FIXTURE,
  POST_FIXTURE_MINIMAL,
  VIDEO_ASSET_FIXTURE,
} from "./helpers/core-fixtures";

// ─── Fixtures satisfy the contracts ────────────────────────────────────────

describe("fixtures match the frozen contracts", () => {
  test("every Article fixture parses", () => {
    for (const a of ARTICLES_FIXTURE) expect(() => parseArticle(a)).not.toThrow();
  });

  test("every Post fixture parses", () => {
    for (const p of POSTS_FIXTURE) expect(() => parsePost(p)).not.toThrow();
  });

  test("every Entity fixture parses", () => {
    for (const e of ENTITIES_FIXTURE) expect(() => parseEntity(e)).not.toThrow();
  });

  test("every Finding fixture parses", () => {
    for (const f of FINDINGS_FIXTURE) expect(() => parseFinding(f)).not.toThrow();
  });

  test("every MediaAsset fixture parses", () => {
    for (const m of MEDIA_ASSETS_FIXTURE) expect(() => parseMediaAsset(m)).not.toThrow();
  });

  test("the VideoAsset fixture parses, and also satisfies MediaAsset", () => {
    expect(() => parseVideoAsset(VIDEO_ASSET_FIXTURE)).not.toThrow();
    // VideoAsset extends MediaAsset, so any consumer typed on the parent must
    // accept it — that is what lets reports treat video and stills uniformly.
    expect(MediaAssetSchema.safeParse(VIDEO_ASSET_FIXTURE).success).toBe(true);
  });

  test("a MediaAsset is NOT accepted as a VideoAsset", () => {
    expect(VideoAssetSchema.safeParse(MEDIA_ASSET_FIXTURE).success).toBe(false);
  });
});

// ─── Absence survives the boundary ─────────────────────────────────────────

describe("unmeasured values stay unmeasured", () => {
  test("a null accountAgeDays is preserved, never coerced to 0", () => {
    const parsed = parsePost(POST_FIXTURE_MINIMAL);
    expect(parsed.accountAgeDays).toBeNull();
    expect(parsed.accountAgeDays).not.toBe(0);
  });

  test("a null lang is preserved, never defaulted to a language", () => {
    const parsed = parseArticle(ARTICLE_FIXTURE_SPARSE);
    expect(parsed.lang).toBeNull();
  });

  test("an absent body is empty, and is not confused with absent EXIF", () => {
    const parsed = parseArticle(ARTICLE_FIXTURE_SPARSE);
    expect(parsed.body).toBe("");
  });

  test("a stripped asset reports EXIF absent rather than omitting the block", () => {
    const stripped = MEDIA_ASSETS_FIXTURE.find((m) => m.id === "media-0002")!;
    expect(stripped.exif?.present).toBe(false);
    expect(stripped.gps).toBeUndefined();
  });

  test("a C2PA AI declaration is carried with its evidence string", () => {
    const signed = MEDIA_ASSETS_FIXTURE.find((m) => m.id === "media-0003")!;
    expect(signed.c2pa?.aiGenerated).toBe(true);
    expect(signed.c2pa?.status).toBe("valid");
    expect(signed.c2pa?.aiEvidence).toBeTruthy();
  });
});

// ─── Bad input is rejected, loudly ─────────────────────────────────────────

describe("contract violations throw and name the problem", () => {
  test("a malformed URL is rejected", () => {
    expect(() => parseArticle(INVALID.articleBadUrl)).toThrow(ContractViolationError);
  });

  test("a nullable field is still required to be present", () => {
    expect(() => parseArticle(INVALID.articleMissingLang)).toThrow(ContractViolationError);
  });

  test("a wrong-length sha256 is rejected", () => {
    expect(() => parseMediaAsset(INVALID.mediaShortHash)).toThrow(ContractViolationError);
  });

  test("an out-of-range confidence is rejected", () => {
    expect(() => parseEntity(INVALID.entityOutOfRange)).toThrow(ContractViolationError);
  });

  test("an out-of-bounds latitude is rejected", () => {
    expect(() => parseFinding(INVALID.findingBadLat)).toThrow(ContractViolationError);
  });

  test("the error names the contract, the producer and the offending field", () => {
    try {
      parseArticle(INVALID.articleBadUrl, "Dev 2");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolationError);
      const e = err as ContractViolationError;
      expect(e.contract).toBe("Article");
      expect(e.producer).toBe("Dev 2");
      expect(e.issues.join(" ")).toContain("url");
      // The message has to be actionable by the person who has to fix it.
      expect(e.message).toContain("Article");
      expect(e.message).toContain("Dev 2");
    }
  });
});

// ─── Batch parsing keeps the good records ──────────────────────────────────

describe("parseMany", () => {
  test("keeps valid records and reports the rejects by index", () => {
    const batch = [ARTICLE_FIXTURE, INVALID.articleBadUrl, ARTICLE_FIXTURE_SPARSE];
    const { ok, rejected } = parseMany(batch, (v) => parseArticle(v));

    expect(ok).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].index).toBe(1);
    expect(rejected[0].reason).toContain("url");
  });

  test("one bad record does not discard the batch", () => {
    const { ok } = parseMany([INVALID.articleBadUrl, ARTICLE_FIXTURE], (v) => parseArticle(v));
    expect(ok.map((a) => a.id)).toEqual([ARTICLE_FIXTURE.id]);
  });
});

// ─── Adapters ──────────────────────────────────────────────────────────────

describe("Article adapters", () => {
  test("contract → internal maps publishedAt onto pubDate", () => {
    const internal = toAnalysisArticle(ARTICLE_FIXTURE);
    expect(internal.pubDate).toBe(ARTICLE_FIXTURE.publishedAt);
    expect(internal.id).toBe(ARTICLE_FIXTURE.id);
    expect(internal.source).toBe(ARTICLE_FIXTURE.source);
  });

  test("an empty contract body becomes undefined, so citation depth skips", () => {
    expect(toAnalysisArticle(ARTICLE_FIXTURE_SPARSE).body).toBeUndefined();
  });

  test("internal → contract derives the domain with the same resolver Module 1 uses", () => {
    const internal = toAnalysisArticle(ARTICLE_FIXTURE);
    const back = fromAnalysisArticle(internal, { lang: "en", images: ARTICLE_FIXTURE.images });
    expect(back.domain).toBe(ARTICLE_FIXTURE.domain);
  });

  test("a round trip preserves every field the internal type carries", () => {
    const back = fromAnalysisArticle(toAnalysisArticle(ARTICLE_FIXTURE), {
      lang: ARTICLE_FIXTURE.lang,
      images: ARTICLE_FIXTURE.images,
    });
    expect(back).toEqual(ARTICLE_FIXTURE);
    expect(() => parseArticle(back)).not.toThrow();
  });
});

describe("Post adapters", () => {
  test("a fully populated post converts with nothing degraded", () => {
    const { post, degraded } = toSocialPost(POST_FIXTURE);
    expect(degraded).toHaveLength(0);
    expect(post.authorId).toBe("did:plc:fixture0001");
    expect(post.links).toEqual(POST_FIXTURE.links!);
    expect(post.url).toBe(POST_FIXTURE.uri);
  });

  test("a minimal post reports every CIB input it could not supply", () => {
    const { post, degraded } = toSocialPost(POST_FIXTURE_MINIMAL);
    const fields = degraded.map((d) => d.field).sort();

    expect(fields).toEqual(["authorId", "langs", "links"]);
    // Falls back so grouping still works — but the caller was told, because a
    // handle is not a stable identifier.
    expect(post.authorId).toBe(POST_FIXTURE_MINIMAL.author);
    expect(post.links).toEqual([]);
  });

  test("each degradation states the consequence, not just the missing field", () => {
    const { degraded } = toSocialPost(POST_FIXTURE_MINIMAL);
    for (const d of degraded) {
      expect(d.consequence.length).toBeGreaterThan(20);
    }
    expect(degraded.find((d) => d.field === "links")!.consequence).toContain("amplification");
  });

  test("an internally collected post round-trips losslessly", () => {
    const { post } = toSocialPost(POST_FIXTURE);
    const back = fromSocialPost(post, POST_FIXTURE.accountAgeDays);
    expect(back).toEqual(POST_FIXTURE);
    expect(() => parsePost(back)).not.toThrow();
  });

  test("a null account age survives the round trip", () => {
    const { post } = toSocialPost(POST_FIXTURE_MINIMAL);
    expect(fromSocialPost(post, null).accountAgeDays).toBeNull();
  });
});

// ─── Coordinate honesty at the boundary ────────────────────────────────────

describe("toGeoPoint", () => {
  test("accepts a real coordinate at its stated precision", () => {
    const p = toGeoPoint(13.0827, 80.2707, "exact");
    expect(p).not.toBeNull();
    expect(p!.precision).toBe("exact");
  });

  test("rejects 0,0 — a missing-value sentinel, not the Gulf of Guinea", () => {
    expect(toGeoPoint(0, 0, "exact")).toBeNull();
  });

  test("rejects out-of-range and non-numeric coordinates", () => {
    expect(toGeoPoint(91, 20, "city")).toBeNull();
    expect(toGeoPoint(20, 181, "city")).toBeNull();
    expect(toGeoPoint(null, null, "city")).toBeNull();
    expect(toGeoPoint("13.08", "80.27", "exact")).toBeNull();
  });

  test("a country-precision point is preserved as coarse, never promoted", () => {
    const p = toGeoPoint(22, 79, "country");
    expect(p!.precision).toBe("country");
  });
});

// ─── The contract file is the single source of truth ───────────────────────

describe("schema/type agreement", () => {
  test("the geo precision scale matches the map renderer's three levels", () => {
    // If a fourth precision is ever added, the map's circle-radius table must
    // gain a matching entry — this test fails first and says so.
    const levels = FindingSchema.shape.geo.unwrap().shape.precision.options;
    expect([...levels].sort()).toEqual(["city", "country", "exact"]);
  });

  test("a Finding may carry no credibility at all", () => {
    const noCred = { ...FINDING_FIXTURE_GEO };
    expect(noCred.credibility).toBeUndefined();
    expect(() => parseFinding(noCred)).not.toThrow();
  });

  test("Entity requires at least one source — no unattributed findings", () => {
    expect(EntitySchema.safeParse({ ...ENTITY_FIXTURE, sources: [] }).success).toBe(false);
  });

  test("Article and Post ids are non-empty, so evidence can always be keyed", () => {
    expect(ArticleSchema.safeParse({ ...ARTICLE_FIXTURE, id: "" }).success).toBe(false);
    expect(PostSchema.safeParse({ ...POST_FIXTURE, id: "" }).success).toBe(false);
  });
});
