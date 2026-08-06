/**
 * Reference fixtures for the frozen contracts in `src/types/core.ts`.
 *
 * All three developers build against these until the real producers land, so a
 * consumer can be finished and tested before its producer exists.
 *
 * THEY LIVE IN tests/ ON PURPOSE. Synthetic records that can be imported by app
 * code are one refactor away from being rendered as real findings, and this
 * project's first rule is that no fabricated data reaches a product. Nothing
 * under `src/` may import this file.
 *
 * Content is obviously-synthetic — example.test domains, round numbers — so a
 * fixture that leaks into a screenshot is recognisable as a fixture.
 */

import type {
  Article,
  Entity,
  Finding,
  MediaAsset,
  Post,
  VideoAsset,
} from "../../src/types/core";

// ─── Article ───────────────────────────────────────────────────────────────

export const ARTICLE_FIXTURE: Article = {
  id: "art-0001",
  title: "Fixture: coastal radar upgrade programme enters second phase",
  body:
    "FIXTURE BODY. The programme moves to its second phase this quarter. " +
    "Details were published at https://pib.gov.in/release/fixture and " +
    "https://drdo.gov.in/fixture-note for reference.",
  url: "https://news.example.test/fixture/radar-upgrade",
  source: "Example Wire",
  domain: "news.example.test",
  publishedAt: "2026-08-05T09:30:00.000Z",
  lang: "en",
  images: ["https://news.example.test/img/fixture-1.jpg"],
};

/** Same story, different outlet — gives corroboration something to find. */
export const ARTICLE_FIXTURE_CORROBORATING: Article = {
  id: "art-0002",
  title: "Fixture: second phase begins for coastal radar upgrade programme",
  body: "FIXTURE BODY. A second outlet carrying the same development.",
  url: "https://other.example.test/fixture/radar-second-phase",
  source: "Other Example Daily",
  domain: "other.example.test",
  publishedAt: "2026-08-05T11:00:00.000Z",
  lang: "en",
  images: [],
};

/** No body, no language detected — exercises the skip paths, not the zero paths. */
export const ARTICLE_FIXTURE_SPARSE: Article = {
  id: "art-0003",
  title: "Fixture: headline-only feed item",
  body: "",
  url: "https://sparse.example.test/fixture/headline-only",
  source: "Sparse Example Feed",
  domain: "sparse.example.test",
  publishedAt: "2026-08-04T22:15:00.000Z",
  lang: null,
  images: [],
};

export const ARTICLES_FIXTURE: Article[] = [
  ARTICLE_FIXTURE,
  ARTICLE_FIXTURE_CORROBORATING,
  ARTICLE_FIXTURE_SPARSE,
];

// ─── Post ──────────────────────────────────────────────────────────────────

/** Fully populated, including the Dev-3 extension fields. */
export const POST_FIXTURE: Post = {
  id: "at://did:plc:fixture0001/app.bsky.feed.post/aaaa",
  platform: "bluesky",
  author: "fixture-account.bsky.social",
  text: "FIXTURE POST. Referencing the radar upgrade reporting.",
  createdAt: "2026-08-05T10:05:00.000Z",
  accountAgeDays: 420,
  uri: "at://did:plc:fixture0001/app.bsky.feed.post/aaaa",
  authorId: "did:plc:fixture0001",
  langs: ["en"],
  links: ["https://news.example.test/fixture/radar-upgrade"],
};

/**
 * Minimal — only Appendix B's required fields, and an unresolvable profile.
 *
 * This is the case that matters most: it must stay distinguishable from a
 * brand-new account, and `toSocialPost` must report the two CIB signals it
 * disables rather than quietly returning a clean post.
 */
export const POST_FIXTURE_MINIMAL: Post = {
  id: "t3_fixture02",
  platform: "reddit",
  author: "fixture_user",
  text: "FIXTURE POST. Minimal contract fields only.",
  createdAt: "2026-08-05T12:40:00.000Z",
  accountAgeDays: null,
  uri: "https://www.reddit.com/r/fixture/comments/fixture02/",
};

export const POSTS_FIXTURE: Post[] = [POST_FIXTURE, POST_FIXTURE_MINIMAL];

// ─── Entity ────────────────────────────────────────────────────────────────

export const ENTITY_FIXTURE: Entity = {
  id: "ent-0001",
  type: "LOCATION",
  name: "Fixture Coastal Station",
  confidence: 0.82,
  sources: ["art-0001", "art-0002"],
};

export const ENTITIES_FIXTURE: Entity[] = [
  ENTITY_FIXTURE,
  {
    id: "ent-0002",
    type: "ORG",
    name: "Example Fixture Directorate",
    confidence: 0.91,
    sources: ["art-0001"],
  },
];

// ─── Finding ───────────────────────────────────────────────────────────────

export const FINDING_FIXTURE: Finding = {
  id: "find-0001",
  module: "M1",
  target: "news.example.test",
  data: { factor: "corroboration", independentDomains: 1 },
  credibility: 0.64,
};

/** Carries a real coordinate at declared precision — the map's happy path. */
export const FINDING_FIXTURE_GEO: Finding = {
  id: "find-0002",
  module: "M4",
  target: "media-0001",
  data: { note: "FIXTURE. EXIF GPS present." },
  geo: { lat: 13.0827, lon: 80.2707, precision: "exact" },
};

/** Country-precision, so the renderer must draw an uncertainty circle. */
export const FINDING_FIXTURE_COARSE: Finding = {
  id: "find-0003",
  module: "M5",
  target: "Example Wire",
  data: { note: "FIXTURE. Outlet country only, not an event location." },
  geo: { lat: 22.0, lon: 79.0, precision: "country" },
};

export const FINDINGS_FIXTURE: Finding[] = [
  FINDING_FIXTURE,
  FINDING_FIXTURE_GEO,
  FINDING_FIXTURE_COARSE,
];

// ─── MediaAsset ────────────────────────────────────────────────────────────

export const MEDIA_ASSET_FIXTURE: MediaAsset = {
  id: "media-0001",
  sha256: "a3f1c9e2b7d84506f1a2b3c4d5e6f7089a0b1c2d3e4f5061728394a5b6c7d8e9",
  phash: "f0e1d2c3b4a59687",
  source: "https://news.example.test/img/fixture-1.jpg",
  exif: {
    present: true,
    cameraMake: "FixtureCam",
    cameraModel: "FX-100",
    software: null,
    captureTime: "2026-08-05T08:12:00.000Z",
  },
  c2pa: {
    status: "absent",
    signedBy: null,
    generator: null,
    aiGenerated: false,
    aiEvidence: null,
  },
  ocrText: "FIXTURE OCR TEXT",
  gps: { lat: 13.0827, lon: 80.2707, precision: "exact" },
  detections: [
    {
      label: "antenna",
      confidence: 0.77,
      bbox: { x0: 120, y0: 64, x1: 310, y1: 402 },
      model: "grounding-dino-fixture",
    },
  ],
  faces: [],
  caption: "FIXTURE CAPTION. AI-generated.",
};

/**
 * Stripped on redistribution — no EXIF, no GPS, no detections.
 *
 * This is the NORMAL case for anything that passed through a social platform,
 * not an anomaly, and consumers must render it as absence rather than as a
 * tampering signal.
 */
export const MEDIA_ASSET_FIXTURE_STRIPPED: MediaAsset = {
  id: "media-0002",
  sha256: "b4e2da03c8195617e2b3c4d5f6a70819ab1c2d3e4f50617283940a5b6c7d8e9f",
  phash: "0123456789abcdef",
  source: "analyst upload",
  exif: {
    present: false,
    cameraMake: null,
    cameraModel: null,
    software: null,
    captureTime: null,
  },
  detections: [],
  faces: [],
};

/** The one high-confidence AI finding this system makes: a SIGNED declaration. */
export const MEDIA_ASSET_FIXTURE_C2PA_AI: MediaAsset = {
  id: "media-0003",
  sha256: "c5f3eb14d92a6728f3c4d5e607b8192abc2d3e4f5061728394a0b5c6d7e8f901",
  phash: "fedcba9876543210",
  source: "analyst upload",
  c2pa: {
    status: "valid",
    signedBy: "Fixture Signing Authority",
    generator: "FixtureDiffusion 2.0",
    aiGenerated: true,
    aiEvidence: "FIXTURE. Signed manifest declares generative provenance.",
  },
  detections: [],
  faces: [],
};

export const MEDIA_ASSETS_FIXTURE: MediaAsset[] = [
  MEDIA_ASSET_FIXTURE,
  MEDIA_ASSET_FIXTURE_STRIPPED,
  MEDIA_ASSET_FIXTURE_C2PA_AI,
];

// ─── VideoAsset ────────────────────────────────────────────────────────────

export const VIDEO_ASSET_FIXTURE: VideoAsset = {
  ...MEDIA_ASSET_FIXTURE_STRIPPED,
  id: "video-0001",
  source: "analyst upload",
  keyframes: [
    { timeSeconds: 0, phash: "1111222233334444" },
    { timeSeconds: 2, phash: "1111222233335555" },
    { timeSeconds: 4, phash: "aaaabbbbccccdddd" },
  ],
  sceneCuts: [{ index: 2, timeSeconds: 4, distanceFromPrevious: 31 }],
  transcript: [
    { startSeconds: 0, endSeconds: 3.5, text: "FIXTURE TRANSCRIPT segment one.", lang: "en" },
    { startSeconds: 3.5, endSeconds: 7, text: "FIXTURE TRANSCRIPT segment two.", lang: "en" },
  ],
  flagWords: [{ term: "fixture", atSeconds: [0, 3.5] }],
};

// ─── Deliberately invalid — for testing rejection ──────────────────────────

/**
 * Each of these must be REJECTED by its parser. Contract enforcement that is
 * never tested against bad input is a type annotation, not a guarantee.
 */
export const INVALID = {
  /** `url` is not a URL. */
  articleBadUrl: { ...ARTICLE_FIXTURE, url: "not-a-url" },
  /** `lang` omitted entirely — nullable, but not optional. */
  articleMissingLang: (() => {
    const { lang: _lang, ...rest } = ARTICLE_FIXTURE;
    return rest;
  })(),
  /** `accountAgeDays` defaulted to 0 instead of null — the exact failure the
   *  nullable typing exists to prevent, and legal at the type level, so it is
   *  caught by review rather than by zod. Kept here as documentation. */
  postZeroedAccountAge: { ...POST_FIXTURE, accountAgeDays: 0 },
  /** sha256 of the wrong length. */
  mediaShortHash: { ...MEDIA_ASSET_FIXTURE, sha256: "abc123" },
  /** Confidence outside 0-1. */
  entityOutOfRange: { ...ENTITY_FIXTURE, confidence: 1.4 },
  /** Latitude out of bounds. */
  findingBadLat: { ...FINDING_FIXTURE_GEO, geo: { lat: 99, lon: 80, precision: "exact" } },
} as const;
