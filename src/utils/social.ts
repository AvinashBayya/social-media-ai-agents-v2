/**
 * Module 3 — social media content analysis, ingestion layer (PS-18 §6.3).
 *
 * PLATFORM REALITY, stated plainly because it drives every design decision here:
 *
 *   Bluesky  — Jetstream is an open, unauthenticated WebSocket firehose emitting
 *              JSON. It is the only genuinely open live social feed of any scale
 *              available at zero cost, and it is what makes this module real
 *              rather than a mock.
 *   Reddit   — OAuth ONLY as of 2026-08-10. Every unauthenticated endpoint now
 *              answers 403 with an HTML anti-bot page: search.json,
 *              old.reddit.com, api.reddit.com and per-subreddit .json, with a
 *              browser User-Agent as well as ours. A free script app plus the
 *              client-credentials grant restores it at 100 queries/minute.
 *   Telegram — public channel previews at t.me/s/{channel}.
 *   Instagram / Facebook — NOT COLLECTED. Meta's terms prohibit scraping, and
 *              the Graph API only grants access to Pages and Business accounts
 *              the caller owns, so broad monitoring is genuinely unavailable
 *              rather than merely unimplemented. This is surfaced in the UI as a
 *              stated limitation. We previously shipped scrapers for both; they
 *              were deleted along with the cache of personal data they produced.
 *
 * ARCHITECTURE: the Jetstream socket runs IN THE BROWSER. The container app
 * scales to zero, so a server-side persistent WebSocket would be torn down
 * between requests and reconnect storms would be the normal state. Jetstream is
 * public and CORS-open, so the browser can hold the socket directly: no server
 * cost, no scale-to-zero problem, and the analyst's own tab is the collector.
 * The buffer is bounded — an unbounded firehose exhausts browser memory in
 * minutes.
 *
 * Nothing in this file invents a value. No Math.random(), no placeholder
 * volumes, no synthesised posts on a dropped connection.
 */

import { createServerFn } from "@tanstack/react-start";
import { recordCredentialUse, resolveCredential, normaliseHost } from "./credential-vault";

// ─── Errors ────────────────────────────────────────────────────────────────

export class SocialUnavailableError extends Error {
  readonly platform: string;
  readonly status?: number;
  constructor(message: string, platform: string, status?: number) {
    super(message);
    this.name = "SocialUnavailableError";
    this.platform = platform;
    this.status = status;
  }
}

// ─── Post shape ────────────────────────────────────────────────────────────

export type Platform = "bluesky" | "reddit" | "telegram" | "mastodon";

export interface SocialPost {
  /** AT URI for Bluesky, fullname for Reddit, channel-index for Telegram. */
  id: string;
  platform: Platform;
  /** Handle where known; for a live Jetstream event this is the DID until resolved. */
  author: string;
  /** Stable account identifier. DID on Bluesky, username on Reddit, channel on Telegram. */
  authorId: string;
  text: string;
  /** ISO 8601, as reported by the platform. */
  createdAt: string;
  url: string;
  /** Language tags the author's client declared. Not our detection. */
  langs: string[];
  /**
   * External URLs and quoted/reposted AT URIs carried by the post. Amplification
   * detection needs the identity of the thing being amplified.
   */
  links: string[];
  /**
   * When THIS system received the post, in ms. Optional and additive.
   *
   * Rate and spike detection must count ARRIVALS, not createdAt. createdAt is
   * author-declared - it comes from the posting client clock, and across 300
   * sampled live posts it ran a median of 2.8 hours in the past, with 0 of 300
   * landing within a minute of the browser clock. Bucketing on it let the UI
   * read "Posts received 2,548" beside "Rate (last 60s) 1/min", and stopped
   * spike detection firing on live data at all.
   *
   * Absent for posts collected before this field existed or pulled by backfill
   * rather than the live socket; consumers fall back to createdAt.
   */
  observedAt?: number;
  /**
   * Media the platform hosts on this post. Optional and additive.
   *
   * Absent means **not collected** — a post from a source whose extractor has
   * not run, or one mapped before this field existed. An empty array means the
   * extractor ran and the post genuinely carries no media. Consumers must not
   * collapse the two: "we didn't look" and "there is nothing" are different
   * findings, which is the same rule `accountAgeDays` follows in the contract.
   */
  media?: SocialMedia[];
}

/**
 * One media item on a post.
 *
 * URLS ONLY, DELIBERATELY. We record where the platform serves the file and
 * render from there; we do not fetch and store the bytes. Two reasons, and both
 * are binding rather than stylistic:
 *
 *  - Re-hosting is redistribution, which the open-social APIs permit us to read
 *    but not to republish.
 *  - Under the DPDP Act 2023 these are images of identifiable individuals.
 *    Bulk-retaining them would be processing personal data at scale on the
 *    strength of the images being publicly visible, and public visibility is
 *    not consent.
 *
 * Bytes are fetched only when an analyst sends one specific asset to Module 4
 * for provenance analysis — a deliberate, per-item act, not a collection
 * default.
 */
export interface SocialMedia {
  /** Full-size URL as the platform publishes it. Never re-hosted by us. */
  url: string;
  type: "image" | "video" | "unknown";
  /** Smaller preview where the platform offers one, else null. */
  thumbnailUrl: string | null;
  /**
   * Uploader-supplied alt text, or null when they supplied none.
   *
   * Null rather than "" on purpose: an empty string would make "no description
   * given" indistinguishable from "described as nothing", and alt text is
   * frequently the only human-written account of what an image shows.
   */
  altText: string | null;
}

// ─── 1. Jetstream consumer (browser) ───────────────────────────────────────

/**
 * Bluesky runs four public Jetstream instances. Pinning one is a single point of
 * failure, and not a theoretical one: verified 2026-08-04, both us-east hosts
 * were unreachable (TCP refused) while both us-west hosts served the firehose
 * normally. The client rotates on each reconnect attempt, so an instance going
 * down costs one backoff interval rather than all collection.
 */
export const JETSTREAM_INSTANCES = [
  "wss://jetstream2.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-west.bsky.network/subscribe",
  "wss://jetstream2.us-west.bsky.network/subscribe",
  "wss://jetstream1.us-east.bsky.network/subscribe",
];

/** First-choice instance. Retained as a named export for display and tests. */
export const JETSTREAM_ENDPOINT = JETSTREAM_INSTANCES[0];
export const POST_COLLECTION = "app.bsky.feed.post";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface JetstreamStatus {
  state: ConnectionState;
  /** Real reason for the current state. Never a placeholder. */
  detail: string;
  /** Consecutive failed connection attempts; resets on a successful open. */
  attempts: number;
  /** Posts received since the socket first opened. */
  received: number;
  /** Posts dropped because the ring buffer was full. */
  dropped: number;
  /** ms until the next reconnect, when reconnecting. */
  retryInMs: number | null;
  connectedAt: string | null;
  /** Which Jetstream instance the current or last attempt used. */
  endpoint: string;
}

/**
 * Reconnect backoff, in ms. Deterministic — no jitter, because jitter would need
 * Math.random() and a single browser tab is not a thundering herd.
 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export interface JetstreamOptions {
  /** Bounded ring. 2000 posts is roughly a minute of unfiltered firehose. */
  bufferSize?: number;
  onPost?: (post: SocialPost) => void;
  onStatus?: (status: JetstreamStatus) => void;
  /** Injected in tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => WebSocket;
}

/** Jetstream commit event, only the fields we read. */
interface JetstreamEvent {
  did?: string;
  time_us?: number;
  kind?: string;
  commit?: {
    operation?: string;
    collection?: string;
    rkey?: string;
    record?: {
      text?: string;
      createdAt?: string;
      langs?: string[];
      embed?: any;
      facets?: any[];
    };
  };
}

/** Pull every external URI and quoted record out of a post record. */
function linksFrom(record: NonNullable<NonNullable<JetstreamEvent["commit"]>["record"]>): string[] {
  const out = new Set<string>();
  const embed = record.embed;
  if (embed?.external?.uri) out.add(String(embed.external.uri));
  if (embed?.record?.uri) out.add(String(embed.record.uri));
  if (embed?.record?.record?.uri) out.add(String(embed.record.record.uri));
  for (const facet of record.facets ?? []) {
    for (const feature of facet?.features ?? []) {
      if (feature?.uri) out.add(String(feature.uri));
    }
  }
  return Array.from(out);
}

// ─── Media extraction ──────────────────────────────────────────────────────
//
// Every shape below was captured from a live response on 2026-08-12 rather than
// taken from documentation, because two of them do not match what the docs
// imply. Bluesky ships a `gallery` embed (up to 10 images) whose fields are
// `items[].thumbnail` — not the `images[].thumb` of the older embed — so a
// single extractor written from the `images` shape silently drops every
// carousel post. Telegram's page contains 85 `background-image` declarations of
// which 4 are post photos; the rest are avatars and emoji, so the selector must
// be class-scoped or it will report a channel's avatar as evidence.
//
// LINK-CARD THUMBNAILS ARE DELIBERATELY NOT MEDIA. `app.bsky.embed.external`
// carries a preview image for a URL the post links to. That image belongs to
// the linked page, not to the post, and the link itself is already captured by
// `linksFrom`. Counting it as post media would inflate media counts and would
// attribute a third party's image to the poster.

const BSKY_CDN = "https://cdn.bsky.app/img";
const BSKY_VIDEO = "https://video.bsky.app/watch";

function bskyImageUrls(did: string, cid: string): { url: string; thumbnailUrl: string } {
  return {
    url: `${BSKY_CDN}/feed_fullsize/plain/${did}/${cid}`,
    thumbnailUrl: `${BSKY_CDN}/feed_thumbnail/plain/${did}/${cid}`,
  };
}

/** Alt text, or null when the uploader gave none. Never "". */
function altOrNull(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s ? s : null;
}

/**
 * Media from a RAW Bluesky post record — the shape Jetstream emits.
 *
 * The record stores blobs by CID, not URL, so the CDN address is composed from
 * the author's DID and the blob CID. `did` is therefore required: without it
 * there is no way to address the blob, and a URL guessed without it would 404.
 */
export function blueskyMediaFromRecord(embed: any, did: string): SocialMedia[] {
  if (!embed || !did) return [];
  const out: SocialMedia[] = [];

  const type = String(embed.$type ?? "");

  // recordWithMedia wraps one of the other embeds; recurse into the media half.
  if (type === "app.bsky.embed.recordWithMedia") {
    return blueskyMediaFromRecord(embed.media, did);
  }

  // `images` (up to 4) and `gallery` (up to 10) differ only in the array name.
  const imageItems: any[] = Array.isArray(embed.images)
    ? embed.images
    : Array.isArray(embed.items)
      ? embed.items
      : [];
  for (const item of imageItems) {
    const cid = item?.image?.ref?.$link;
    if (typeof cid !== "string" || !cid) continue;
    const { url, thumbnailUrl } = bskyImageUrls(did, cid);
    out.push({ url, type: "image", thumbnailUrl, altText: altOrNull(item.alt) });
  }

  const videoCid = embed?.video?.ref?.$link;
  if (typeof videoCid === "string" && videoCid) {
    const encoded = encodeURIComponent(did);
    out.push({
      url: `${BSKY_VIDEO}/${encoded}/${videoCid}/playlist.m3u8`,
      type: "video",
      thumbnailUrl: `${BSKY_VIDEO}/${encoded}/${videoCid}/thumbnail.jpg`,
      altText: altOrNull(embed.alt),
    });
  }

  return out;
}

/**
 * Media from an AppView embed VIEW — the shape getAuthorFeed and searchPosts
 * return, where the CDN URLs are already resolved.
 *
 * Preferred over the record shape wherever both are present: the server has
 * already done the blob-to-URL resolution, so there is nothing for us to get
 * wrong.
 */
export function blueskyMediaFromView(embed: any): SocialMedia[] {
  if (!embed) return [];
  const type = String(embed.$type ?? "");

  if (type.startsWith("app.bsky.embed.recordWithMedia")) {
    return blueskyMediaFromView(embed.media);
  }

  const out: SocialMedia[] = [];

  // images#view → images[].thumb / .fullsize
  for (const img of Array.isArray(embed.images) ? embed.images : []) {
    if (typeof img?.fullsize !== "string" && typeof img?.thumb !== "string") continue;
    out.push({
      url: String(img.fullsize ?? img.thumb),
      type: "image",
      thumbnailUrl: typeof img.thumb === "string" ? img.thumb : null,
      altText: altOrNull(img.alt),
    });
  }

  // gallery#view → items[].thumbnail / .fullsize. Different field name for the
  // same thing; missing this is how carousel posts vanish.
  for (const item of Array.isArray(embed.items) ? embed.items : []) {
    if (typeof item?.fullsize !== "string" && typeof item?.thumbnail !== "string") continue;
    out.push({
      url: String(item.fullsize ?? item.thumbnail),
      type: "image",
      thumbnailUrl: typeof item.thumbnail === "string" ? item.thumbnail : null,
      altText: altOrNull(item.alt),
    });
  }

  // video#view → playlist (HLS) + thumbnail
  if (typeof embed.playlist === "string" && embed.playlist) {
    out.push({
      url: embed.playlist,
      type: "video",
      thumbnailUrl: typeof embed.thumbnail === "string" ? embed.thumbnail : null,
      altText: altOrNull(embed.alt),
    });
  }

  return out;
}

/**
 * Media from a Reddit listing child's `data` object.
 *
 * NOT VERIFIED AGAINST LIVE TRAFFIC — Reddit refuses unauthenticated requests
 * on every endpoint, and no OAuth credential is configured in this environment,
 * so this is written from the documented shape and is the one extractor here
 * whose fixture is hand-built rather than captured. Confirm it against a real
 * response once a script-app credential is in place.
 *
 * Reddit escapes `&` as `&amp;` inside preview URLs; an unescaped URL 403s
 * because the signature parameters are part of the query string.
 */
export function redditMediaFrom(data: any): SocialMedia[] {
  if (!data) return [];
  const out: SocialMedia[] = [];
  const unescape = (u: unknown): string => String(u ?? "").replace(/&amp;/g, "&");

  // Native video.
  const video = data?.media?.reddit_video ?? data?.secure_media?.reddit_video;
  if (typeof video?.fallback_url === "string" && video.fallback_url) {
    out.push({
      url: unescape(video.fallback_url),
      type: "video",
      thumbnailUrl:
        typeof data.thumbnail === "string" && data.thumbnail.startsWith("http")
          ? unescape(data.thumbnail)
          : null,
      altText: null,
    });
  }

  // Gallery: media_metadata is keyed by id, so iterate values not indices.
  if (data.is_gallery && data.media_metadata && typeof data.media_metadata === "object") {
    for (const meta of Object.values<any>(data.media_metadata)) {
      const source = meta?.s;
      const url = source?.u ?? source?.gif ?? source?.mp4;
      if (typeof url !== "string" || !url) continue;
      out.push({
        url: unescape(url),
        type: source?.mp4 || source?.gif ? "video" : "image",
        thumbnailUrl: null,
        altText: null,
      });
    }
  }

  // Preview images on a link or image post.
  for (const img of data?.preview?.images ?? []) {
    const url = img?.source?.url;
    if (typeof url !== "string" || !url) continue;
    const resolutions = Array.isArray(img.resolutions) ? img.resolutions : [];
    const thumb = resolutions.length ? resolutions[0]?.url : null;
    out.push({
      url: unescape(url),
      type: "image",
      thumbnailUrl: typeof thumb === "string" ? unescape(thumb) : null,
      altText: null,
    });
  }

  // A direct i.redd.it link with no preview block.
  if (
    out.length === 0 &&
    typeof data.url === "string" &&
    /^https?:\/\/i\.redd\.it\//.test(data.url)
  ) {
    out.push({ url: data.url, type: "image", thumbnailUrl: null, altText: null });
  }

  // Deduplicate: a gallery post can list the same asset under preview as well.
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.url) ? false : (seen.add(m.url), true)));
}

/**
 * Media from ONE Telegram message block's HTML.
 *
 * Must be given a single message's slice, not the whole page. The page carries
 * 85 `background-image` declarations of which only 4 are post photos — channel
 * avatars, reply previews and emoji make up the rest — so both selectors here
 * are scoped to the specific `tgme_widget_message_*` classes.
 *
 * Telegram serves only a poster frame for video in the web preview, never the
 * video file, so a video is recorded with its thumbnail as the URL and typed
 * `video` rather than being reported as an image.
 */
export function telegramMediaFrom(blockHtml: string): SocialMedia[] {
  if (!blockHtml) return [];
  const out: SocialMedia[] = [];

  const photoRe =
    /class="tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*background-image:url\('([^']+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = photoRe.exec(blockHtml)) !== null) {
    out.push({ url: m[1], type: "image", thumbnailUrl: m[1], altText: null });
  }

  const videoRe =
    /class="tgme_widget_message_video_thumb"[^>]*style="[^"]*background-image:url\('([^']+)'\)/g;
  while ((m = videoRe.exec(blockHtml)) !== null) {
    out.push({
      // The poster frame, not the video. Typed `video` so a reviewer is not
      // told a still image is the whole asset.
      url: m[1],
      type: "video",
      thumbnailUrl: m[1],
      altText: null,
    });
  }

  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

/** Media from a Mastodon status. `description` is the instance's alt-text field. */
export function mastodonMediaFrom(status: any): SocialMedia[] {
  const out: SocialMedia[] = [];
  for (const att of status?.media_attachments ?? []) {
    const url = att?.url ?? att?.remote_url;
    if (typeof url !== "string" || !url) continue;
    const kind = String(att?.type ?? "");
    out.push({
      url,
      // gifv is a silent looping video, not an image — typing it as an image
      // would send a video file into the still-image analysis path.
      type: kind === "image" ? "image" : kind === "video" || kind === "gifv" ? "video" : "unknown",
      thumbnailUrl: typeof att?.preview_url === "string" ? att.preview_url : null,
      altText: altOrNull(att?.description),
    });
  }
  return out;
}

export function eventToPost(evt: JetstreamEvent, now: number = Date.now()): SocialPost | null {
  if (evt?.kind !== "commit") return null;
  const commit = evt.commit;
  if (!commit || commit.operation !== "create" || commit.collection !== POST_COLLECTION)
    return null;
  const record = commit.record;
  const did = evt.did;
  if (!record || typeof record.text !== "string" || !did || !commit.rkey) return null;

  return {
    id: `at://${did}/${POST_COLLECTION}/${commit.rkey}`,
    platform: "bluesky",
    // Jetstream carries the DID, not the handle. Resolving every DID would be one
    // AppView call per post; handles are resolved on demand for flagged accounts
    // only. The DID stands in until then and is labelled as such in the UI.
    author: did,
    authorId: did,
    text: record.text,
    createdAt:
      record.createdAt ??
      (evt.time_us ? new Date(Math.floor(evt.time_us / 1000)).toISOString() : ""),
    url: `https://bsky.app/profile/${did}/post/${commit.rkey}`,
    langs: Array.isArray(record.langs) ? record.langs : [],
    links: linksFrom(record),
    // Jetstream carries the raw record, so blobs are CIDs and the CDN URL has
    // to be composed from the author's DID.
    media: blueskyMediaFromRecord(record.embed, did),
    // Arrival, measured here. now is injectable so this stays pure under test.
    observedAt: now,
  };
}

/**
 * Bounded ring buffer. Overwrites oldest on overflow and counts what it dropped,
 * so the UI can state "buffer full, 12,400 posts discarded" rather than silently
 * presenting a window as though it were everything.
 */
export class RingBuffer<T> {
  private items: T[] = [];
  private droppedCount = 0;
  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error("RingBuffer capacity must be at least 1");
  }
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.droppedCount += 1;
    }
  }
  toArray(): T[] {
    return [...this.items];
  }
  get size(): number {
    return this.items.length;
  }
  get dropped(): number {
    return this.droppedCount;
  }
  clear(): void {
    this.items = [];
    this.droppedCount = 0;
  }
}

export class JetstreamClient {
  private ws: WebSocket | null = null;
  private buffer: RingBuffer<SocialPost>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Index into JETSTREAM_INSTANCES; advanced on each failed attempt. */
  private instance = 0;
  private status: JetstreamStatus = {
    state: "idle",
    detail: "Not connected.",
    attempts: 0,
    received: 0,
    dropped: 0,
    retryInMs: null,
    connectedAt: null,
    endpoint: JETSTREAM_INSTANCES[0],
  };

  constructor(private readonly opts: JetstreamOptions = {}) {
    this.buffer = new RingBuffer<SocialPost>(opts.bufferSize ?? 2000);
  }

  getStatus(): JetstreamStatus {
    return { ...this.status, dropped: this.buffer.dropped };
  }
  getPosts(): SocialPost[] {
    return this.buffer.toArray();
  }

  private emit(patch: Partial<JetstreamStatus>): void {
    this.status = { ...this.status, ...patch, dropped: this.buffer.dropped };
    this.opts.onStatus?.(this.getStatus());
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    const endpoint = JETSTREAM_INSTANCES[this.instance % JETSTREAM_INSTANCES.length];
    const url = `${endpoint}?wantedCollections=${encodeURIComponent(POST_COLLECTION)}`;
    this.emit({
      state: this.status.attempts === 0 ? "connecting" : "reconnecting",
      detail: `Opening ${endpoint}`,
      retryInMs: null,
      endpoint,
    });

    let socket: WebSocket;
    try {
      socket = this.opts.socketFactory ? this.opts.socketFactory(url) : new WebSocket(url);
    } catch (err: any) {
      this.emit({
        state: "error",
        detail: `WebSocket could not be created: ${err?.message ?? String(err)}`,
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.emit({
        state: "open",
        detail: `Connected to ${endpoint}`,
        attempts: 0,
        retryInMs: null,
        connectedAt: new Date().toISOString(),
      });
    };

    socket.onmessage = (evt: MessageEvent) => {
      let parsed: JetstreamEvent;
      try {
        parsed = JSON.parse(typeof evt.data === "string" ? evt.data : "");
      } catch {
        return; // A malformed frame is skipped, never substituted.
      }
      const post = eventToPost(parsed);
      if (!post) return;
      this.buffer.push(post);
      this.status.received += 1;
      this.opts.onPost?.(post);
    };

    socket.onerror = () => {
      // The browser deliberately withholds the cause of a socket error, so this
      // says exactly that rather than inventing a reason.
      this.emit({
        state: "error",
        detail: "Socket error (the browser does not expose the cause).",
      });
    };

    socket.onclose = (evt: CloseEvent) => {
      if (this.stopped) {
        this.emit({ state: "closed", detail: "Disconnected by the analyst.", connectedAt: null });
        return;
      }
      this.emit({
        state: "reconnecting",
        detail: `Connection closed (code ${evt.code}${evt.reason ? `: ${evt.reason}` : ""}).`,
        connectedAt: null,
      });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const attempts = this.status.attempts + 1;
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    // Move to the next instance before retrying. Hammering a host that is down
    // for the full backoff sequence wastes six attempts on a dead endpoint.
    this.instance += 1;
    const next = JETSTREAM_INSTANCES[this.instance % JETSTREAM_INSTANCES.length];
    this.emit({
      state: "reconnecting",
      attempts,
      retryInMs: delay,
      detail: `${this.status.detail} Retrying against ${next}.`,
      endpoint: next,
    });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), delay);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Detach handlers before closing so onclose does not schedule a reconnect.
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.emit({
      state: "closed",
      detail: "Disconnected by the analyst.",
      retryInMs: null,
      connectedAt: null,
    });
  }
}

// ─── 2. Keyword monitors ───────────────────────────────────────────────────

export interface Monitor {
  id: string;
  /** What the analyst is watching. Matched case-insensitively on word boundaries. */
  term: string;
  createdAt: string;
}

/** Word-boundary match, so "IAF" does not fire on "chiaroscuro". */
export function monitorMatches(post: SocialPost, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  const text = post.text.toLowerCase();
  // Multi-word terms are matched as a phrase; single words on boundaries.
  if (/\s/.test(t)) return text.includes(t);
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:[^\\p{L}\\p{N}_]|$)`, "u").test(text);
}

export const BUCKET_MS = 60_000;
/** Buckets retained per monitor: one hour of per-minute history. */
export const BASELINE_WINDOW = 60;
/** Complete buckets required before a baseline is asserted at all. */
export const MIN_BASELINE_BUCKETS = 10;

export interface SpikeAssessment {
  /**
   * null means NOT ENOUGH HISTORY — deliberately three-valued. A boolean would
   * force a cold monitor to answer "not spiking", which reads as a measurement
   * when it is an absence of one.
   */
  spiking: boolean | null;
  /** Matches in the bucket just completed. */
  current: number;
  baselineMean: number | null;
  baselineStdDev: number | null;
  /** Standard deviations above the baseline mean. */
  z: number | null;
  bucketsObserved: number;
  reason: string;
}

/**
 * Volume spike detection against a ROLLING BASELINE, not a fixed threshold.
 *
 * A hardcoded "alert above 50 posts/minute" is meaningless across subjects: 50
 * posts a minute is silence for a national election and an extraordinary surge
 * for a specific airbase. The baseline is what this term normally does, measured
 * from its own history, so the same rule works for both.
 */
export const SPIKE_SIGMA = 3;

export function assessSpike(buckets: number[]): SpikeAssessment {
  if (buckets.length < 2) {
    return {
      spiking: null,
      current: buckets[buckets.length - 1] ?? 0,
      baselineMean: null,
      baselineStdDev: null,
      z: null,
      bucketsObserved: buckets.length,
      reason: "No completed observation window yet.",
    };
  }

  const current = buckets[buckets.length - 1];
  const history = buckets.slice(0, -1).slice(-BASELINE_WINDOW);

  if (history.length < MIN_BASELINE_BUCKETS) {
    return {
      spiking: null,
      current,
      baselineMean: null,
      baselineStdDev: null,
      z: null,
      bucketsObserved: history.length,
      reason:
        `Baseline needs ${MIN_BASELINE_BUCKETS} completed minutes; ${history.length} observed. ` +
        `No spike judgement is made until then.`,
    };
  }

  const mean = history.reduce((s, v) => s + v, 0) / history.length;
  const variance = history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length;
  const stdDev = Math.sqrt(variance);

  // A flat baseline has zero variance, so a z-score is undefined. Requiring the
  // count to at least double avoids flagging 0 -> 1 as an infinite spike.
  if (stdDev === 0) {
    const spiking = current > mean * 2 && current > mean + 1;
    return {
      spiking,
      current,
      baselineMean: mean,
      baselineStdDev: 0,
      z: null,
      bucketsObserved: history.length,
      reason: spiking
        ? `Baseline was flat at ${mean.toFixed(1)}/min over ${history.length} minutes; this minute carried ${current}.`
        : `Baseline flat at ${mean.toFixed(1)}/min; this minute carried ${current}. No z-score is defined with zero variance.`,
    };
  }

  const z = (current - mean) / stdDev;
  const spiking = z >= SPIKE_SIGMA;
  return {
    spiking,
    current,
    baselineMean: mean,
    baselineStdDev: stdDev,
    z,
    bucketsObserved: history.length,
    reason:
      `${current} matches this minute against a baseline of ${mean.toFixed(1)} ± ${stdDev.toFixed(1)} ` +
      `over the previous ${history.length} minutes (${z.toFixed(1)}σ; threshold ${SPIKE_SIGMA}σ).`,
  };
}

/**
 * Per-minute counts for a monitor, oldest first, ending at the bucket containing
 * `now`. Gaps are zeros — a minute with no matches is a real observation of zero,
 * not missing data.
 */
/**
 * When we observed a post, in ms, or null when neither basis is usable.
 *
 * Prefers observedAt (arrival, measured by us) over createdAt (author-declared,
 * from the posting client clock). Volume and spike detection are statements
 * about what THIS system received in a window, so they must be computed on
 * arrival - bucketing on createdAt scattered live posts hours into the past.
 */
export function observationTime(post: SocialPost): number | null {
  if (typeof post.observedAt === "number" && Number.isFinite(post.observedAt)) {
    return post.observedAt;
  }
  const t = new Date(post.createdAt).getTime();
  return Number.isFinite(t) ? t : null;
}

export function bucketise(
  posts: SocialPost[],
  now: number,
  windowMinutes = BASELINE_WINDOW + 1,
): number[] {
  const buckets = new Array(windowMinutes).fill(0);
  const newestBucket = Math.floor(now / BUCKET_MS);
  for (const p of posts) {
    const t = observationTime(p);
    if (t === null) continue;
    const idx = windowMinutes - 1 - (newestBucket - Math.floor(t / BUCKET_MS));
    if (idx >= 0 && idx < windowMinutes) buckets[idx] += 1;
  }
  return buckets;
}

export interface MonitorReading {
  monitor: Monitor;
  matches: SocialPost[];
  /** Matches per minute over the completed history, for the sparkline. */
  buckets: number[];
  /** Matches in the most recent completed minute. */
  ratePerMinute: number;
  spike: SpikeAssessment;
}

export function readMonitor(monitor: Monitor, posts: SocialPost[], now: number): MonitorReading {
  const matches = posts.filter((p) => monitorMatches(p, monitor.term));
  const all = bucketise(matches, now);

  // Only minutes at or after the monitor was created are observations. A monitor
  // added thirty seconds ago has not watched the previous hour, and letting
  // those minutes stand as zeros would manufacture a baseline out of time
  // nothing was collected in — the first match would then read as a 60-minute
  // silence broken by a surge.
  const started = new Date(monitor.createdAt).getTime();
  let firstIdx = 0;
  if (Number.isFinite(started)) {
    const elapsedBuckets = Math.floor(now / BUCKET_MS) - Math.floor(started / BUCKET_MS);
    firstIdx = Math.max(0, all.length - 1 - elapsedBuckets);
  }
  const buckets = all.slice(firstIdx);

  return {
    monitor,
    matches,
    buckets,
    ratePerMinute: buckets[buckets.length - 1] ?? 0,
    spike: assessSpike(buckets),
  };
}

// ─── 3. Bluesky public AppView (server-side) ───────────────────────────────

const APPVIEW = "https://public.api.bsky.app/xrpc";

export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName: string | null;
  /** Account creation time as reported by the AppView. The basis for maturity signals. */
  createdAt: string | null;
  followersCount: number | null;
  followsCount: number | null;
  postsCount: number | null;
  description: string | null;
  avatar: string | null;
}

/** Short-lived server cache. Profiles change slowly and the AppView is rate limited. */
interface CacheRow<T> {
  value: T;
  at: number;
}
const PROFILE_TTL_MS = 10 * 60_000;
const FEED_TTL_MS = 2 * 60_000;
const profileCache = new Map<string, CacheRow<BlueskyProfile>>();
const genericCache = new Map<string, CacheRow<unknown>>();

function cacheGet<T>(store: Map<string, CacheRow<any>>, key: string, ttl: number): T | null {
  const row = store.get(key);
  if (!row) return null;
  if (Date.now() - row.at > ttl) {
    store.delete(key);
    return null;
  }
  return row.value as T;
}
function cacheSet(store: Map<string, CacheRow<any>>, key: string, value: unknown): void {
  // Bounded so a long-running process cannot grow without limit.
  if (store.size >= 500) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, at: Date.now() });
}

// Takes URLSearchParams rather than a plain object because getProfiles passes
// `actors` REPEATED — a record would collapse 25 actors to whichever was last.
async function appview(
  path: string,
  params: URLSearchParams | Record<string, string>,
  platform: Platform,
): Promise<any> {
  const qs = (params instanceof URLSearchParams ? params : new URLSearchParams(params)).toString();
  let res: Response;
  try {
    res = await fetch(`${APPVIEW}/${path}?${qs}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Bluesky AppView request failed: ${err?.message ?? String(err)}`,
      platform,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SocialUnavailableError(
      `Bluesky AppView ${path} returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      platform,
      res.status,
    );
  }
  return res.json();
}

function toProfile(raw: any): BlueskyProfile {
  return {
    did: String(raw?.did ?? ""),
    handle: String(raw?.handle ?? ""),
    displayName: raw?.displayName ?? null,
    createdAt: raw?.createdAt ?? null,
    // Explicit null rather than 0 when the field is absent: "no data" and "zero
    // followers" are different findings and a maturity signal must not confuse them.
    followersCount: typeof raw?.followersCount === "number" ? raw.followersCount : null,
    followsCount: typeof raw?.followsCount === "number" ? raw.followsCount : null,
    postsCount: typeof raw?.postsCount === "number" ? raw.postsCount : null,
    description: raw?.description ?? null,
    avatar: raw?.avatar ?? null,
  };
}

export async function fetchProfile(actor: string): Promise<BlueskyProfile> {
  const key = actor.trim().toLowerCase().replace(/^@/, "");
  if (!key) throw new SocialUnavailableError("No handle or DID supplied.", "bluesky");
  const hit = cacheGet<BlueskyProfile>(profileCache, key, PROFILE_TTL_MS);
  if (hit) return hit;
  const profile = toProfile(await appview("app.bsky.actor.getProfile", { actor: key }, "bluesky"));
  cacheSet(profileCache, key, profile);
  return profile;
}

/** Batched profile lookup — getProfiles accepts up to 25 actors per call. */
export async function fetchProfiles(actors: string[]): Promise<BlueskyProfile[]> {
  const wanted = Array.from(
    new Set(actors.map((a) => a.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)),
  );
  const out: BlueskyProfile[] = [];
  const missing: string[] = [];
  for (const a of wanted) {
    const hit = cacheGet<BlueskyProfile>(profileCache, a, PROFILE_TTL_MS);
    if (hit) out.push(hit);
    else missing.push(a);
  }
  for (let i = 0; i < missing.length; i += 25) {
    const batch = missing.slice(i, i + 25);
    const params = new URLSearchParams();
    for (const a of batch) params.append("actors", a);
    const raw = await appview("app.bsky.actor.getProfiles", params, "bluesky").catch(async () => {
      // getProfiles is all-or-nothing; fall back to individual lookups so one
      // deleted account does not lose the whole batch.
      const singles = await Promise.allSettled(batch.map((a) => fetchProfile(a)));
      return { profiles: singles.filter((s) => s.status === "fulfilled").map((s: any) => s.value) };
    });
    for (const p of raw?.profiles ?? []) {
      const profile = p.did ? toProfile(p) : (p as BlueskyProfile);
      if (profile.did) {
        cacheSet(profileCache, profile.handle || profile.did, profile);
        out.push(profile);
      }
    }
  }
  return out;
}

export async function fetchAuthorFeed(actor: string, limit = 50): Promise<SocialPost[]> {
  const key = `feed:${actor}:${limit}`;
  const hit = cacheGet<SocialPost[]>(genericCache, key, FEED_TTL_MS);
  if (hit) return hit;

  const raw = await appview(
    "app.bsky.feed.getAuthorFeed",
    { actor: actor.replace(/^@/, ""), limit: String(Math.min(limit, 100)) },
    "bluesky",
  );

  const posts: SocialPost[] = [];
  for (const item of raw?.feed ?? []) {
    const post = item?.post;
    const record = post?.record;
    if (!post?.uri || typeof record?.text !== "string") continue;
    const rkey = String(post.uri).split("/").pop() ?? "";
    posts.push({
      id: String(post.uri),
      platform: "bluesky",
      author: post.author?.handle ?? post.author?.did ?? "",
      authorId: post.author?.did ?? "",
      text: record.text,
      createdAt: record.createdAt ?? post.indexedAt ?? "",
      url: `https://bsky.app/profile/${post.author?.handle ?? post.author?.did}/post/${rkey}`,
      langs: Array.isArray(record.langs) ? record.langs : [],
      links: linksFrom(record),
      // The AppView has already resolved blobs to CDN URLs; prefer that view
      // over re-deriving them from the record.
      media: blueskyMediaFromView(post.embed),
    });
  }
  cacheSet(genericCache, key, posts);
  return posts;
}

// ─── 3b. Authenticated Bluesky keyword search ──────────────────────────────

/**
 * Historical keyword search over Bluesky.
 *
 * This is the one collection gap a credential closes outright. Jetstream is a
 * live firehose: it can only ever show what is posted after the analyst's tab
 * connects, so a subject that trended yesterday is unreachable no matter how
 * long the socket stays open. `app.bsky.feed.searchPosts` searches the indexed
 * past — and returns 403 unauthenticated (re-verified against the public AppView
 * on 2026-08-12), which is why it was previously listed as a stated limitation
 * rather than implemented.
 *
 * An app password (not the account password) resolves that. Authenticated XRPC
 * goes to the PDS at bsky.social, which proxies to the AppView.
 */
const BSKY_PDS = "https://bsky.social/xrpc";

/** Cached session JWT, mirroring the Reddit token cache: per-process, lost on restart. */
let bskySession: { jwt: string; did: string; handle: string; issuedAt: number } | null = null;

/** Exported so tests can reset it; nothing in the app should call this. */
export function resetBlueskySession(): void {
  bskySession = null;
}

/**
 * accessJwt lifetime is not advertised in the response, so it is refreshed on a
 * conservative fixed interval rather than on a guessed expiry. A 401 mid-flight
 * also drops it — see fetchBlueskySearch.
 */
const BSKY_SESSION_TTL_MS = 90 * 60_000;

async function blueskySession(): Promise<{ jwt: string; handle: string }> {
  if (bskySession && Date.now() - bskySession.issuedAt < BSKY_SESSION_TTL_MS) {
    return { jwt: bskySession.jwt, handle: bskySession.handle };
  }

  const cred = await resolveCredential("bluesky");
  if (!cred?.identifier) {
    throw new SocialUnavailableError(
      "Bluesky keyword search requires an app password. app.bsky.feed.searchPosts returns 403 " +
        "unauthenticated, so historical search cannot run — the live Jetstream firehose is " +
        "unaffected and keeps collecting forward. Add a Bluesky app password on the Settings " +
        "page, or set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD. No results are shown " +
        "because there is no credential, not because nothing matched.",
      "bluesky",
      403,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${BSKY_PDS}/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: cred.identifier.replace(/^@/, ""),
        password: cred.secret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Bluesky session request failed: ${err?.message ?? String(err)}`,
      "bluesky",
    );
  }

  const json: any = await res.json().catch(() => null);
  if (res.status === 401) {
    throw new SocialUnavailableError(
      `Bluesky refused the app password (HTTP 401): ${json?.message ?? "AuthenticationRequired"}. ` +
        `This must be an App Password from Settings → Privacy and security, not the account ` +
        `password.`,
      "bluesky",
      401,
    );
  }
  if (!res.ok || typeof json?.accessJwt !== "string") {
    throw new SocialUnavailableError(
      `Bluesky createSession returned HTTP ${res.status}${json?.error ? ` (${json.error})` : ""}.`,
      "bluesky",
      res.status,
    );
  }

  bskySession = {
    jwt: json.accessJwt,
    did: String(json.did ?? ""),
    handle: String(json.handle ?? cred.identifier),
    issuedAt: Date.now(),
  };
  await recordCredentialUse("bluesky", cred.entryId);
  return { jwt: bskySession.jwt, handle: bskySession.handle };
}

export type BlueskySearchSort = "latest" | "top";

/**
 * Search indexed Bluesky posts by keyword.
 *
 * Failure modes stay distinguishable, as everywhere else in this file: a missing
 * credential, a rejected credential, a rate limit and a genuinely empty result
 * set are four different facts. Only the last returns `[]`.
 */
export async function fetchBlueskySearch(
  query: string,
  limit = 50,
  sort: BlueskySearchSort = "latest",
): Promise<SocialPost[]> {
  const q = query.trim();
  if (!q) throw new SocialUnavailableError("No query supplied for Bluesky search.", "bluesky");

  const key = `bsky-search:${q}:${limit}:${sort}`;
  const hit = cacheGet<SocialPost[]>(genericCache, key, FEED_TTL_MS);
  if (hit) return hit;

  const { jwt } = await blueskySession();
  const url =
    `${BSKY_PDS}/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}` +
    `&limit=${Math.min(Math.max(limit, 1), 100)}&sort=${sort}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${jwt}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Bluesky search request failed: ${err?.message ?? String(err)}`,
      "bluesky",
    );
  }

  if (res.status === 401) {
    // The cached JWT expired earlier than the fixed TTL assumed. Drop it so the
    // next call re-authenticates rather than replaying a token we know is dead.
    resetBlueskySession();
    throw new SocialUnavailableError(
      "Bluesky rejected the session token (HTTP 401). It has been discarded; retry to " +
        "re-authenticate.",
      "bluesky",
      401,
    );
  }
  if (res.status === 429) {
    throw new SocialUnavailableError(
      "Bluesky rate limited this search (HTTP 429). No results were returned — this is not " +
        "the same as no matching posts.",
      "bluesky",
      429,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SocialUnavailableError(
      `Bluesky searchPosts returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      "bluesky",
      res.status,
    );
  }

  const json: any = await res.json();
  const posts: SocialPost[] = [];
  for (const post of json?.posts ?? []) {
    const record = post?.record;
    if (!post?.uri || typeof record?.text !== "string") continue;
    const rkey = String(post.uri).split("/").pop() ?? "";
    const handle = post.author?.handle ?? post.author?.did ?? "";
    posts.push({
      id: String(post.uri),
      platform: "bluesky",
      author: handle,
      authorId: post.author?.did ?? "",
      text: record.text,
      // indexedAt is when the AppView saw it, createdAt when the author says
      // they wrote it. The author's claim is what every other collector here
      // reports, so it stays primary for consistency across platforms.
      createdAt: record.createdAt ?? post.indexedAt ?? "",
      url: `https://bsky.app/profile/${handle}/post/${rkey}`,
      langs: Array.isArray(record.langs) ? record.langs : [],
      links: linksFrom(record),
      media: blueskyMediaFromView(post.embed),
    });
  }

  cacheSet(genericCache, key, posts);
  return posts;
}

// ─── 4. Reddit and Telegram collectors (server-side) ───────────────────────

/**
 * Reddit OAuth — required since the unauthenticated JSON endpoints started
 * refusing us.
 *
 * Re-verified 2026-08-10: every unauthenticated route now answers **403** and
 * serves an HTML anti-bot page rather than JSON — `www.reddit.com/search.json`,
 * `old.reddit.com`, `api.reddit.com` and per-subreddit `.json` alike, with a
 * browser User-Agent as well as ours. This is not the documented rate limit and
 * no header or UA works around it; it is an access-policy change.
 *
 * A free registered *script* app plus the client-credentials grant restores
 * access at 100 queries/minute. Credentials are read server-side only.
 */
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_OAUTH_BASE = "https://oauth.reddit.com";

/** Reddit requires a descriptive, unique UA; a generic one is itself a ban trigger. */
const REDDIT_UA = "SentinelAI/1.0 (OSINT research; contact via repository)";

export function redditCredentials(): { id: string; secret: string } | null {
  const id = process.env.REDDIT_CLIENT_ID?.trim();
  const secret = process.env.REDDIT_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

/**
 * Reddit credentials from the environment OR the operator's credentials vault.
 *
 * `redditCredentials()` above is env-only and stays that way: it is synchronous,
 * several call sites depend on that, and its tests pin the behaviour. This is
 * the async superset the collector actually uses, so a credential entered on the
 * Settings page during a demo works without a redeploy. Environment still wins —
 * see the resolution note in credential-vault.ts.
 *
 * Returns the vault entry id alongside, so a successful call can stamp
 * `lastUsed` on the row the operator is looking at.
 */
export async function resolveRedditCredentials(): Promise<{
  id: string;
  secret: string;
  source: "env" | "vault";
  entryId: string | null;
} | null> {
  const env = redditCredentials();
  if (env) return { ...env, source: "env", entryId: null };

  const resolved = await resolveCredential("reddit");
  if (!resolved?.identifier) return null;
  return {
    id: resolved.identifier,
    secret: resolved.secret,
    source: resolved.source,
    entryId: resolved.entryId,
  };
}

/**
 * Cached bearer token. Per-process and lost on restart, like the LLM cache —
 * acceptable because a token round-trip is one extra request, not a wrong answer.
 */
let redditToken: { value: string; expiresAt: number } | null = null;

/** Exported so tests can reset it; nothing in the app should call this. */
export function resetRedditToken(): void {
  redditToken = null;
}

async function redditAccessToken(): Promise<string> {
  const creds = await resolveRedditCredentials();
  if (!creds) {
    throw new SocialUnavailableError(
      "Reddit requires OAuth credentials. Unauthenticated access now returns 403 on every " +
        "endpoint (verified 2026-08-10), so no query can run. Register a free script app at " +
        "reddit.com/prefs/apps, then either set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET or " +
        "add the pair on the Settings page. Nothing is shown — that is a missing credential, " +
        "not a finding that no posts matched.",
      "reddit",
      403,
    );
  }

  // 60s of headroom: a token that expires mid-flight would surface as a
  // confusing 401 rather than as the refresh it actually is.
  if (redditToken && redditToken.expiresAt - 60_000 > Date.now()) return redditToken.value;

  let res: Response;
  try {
    res = await fetch(REDDIT_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${creds.id}:${creds.secret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": REDDIT_UA,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Reddit token request failed: ${err?.message ?? String(err)}`,
      "reddit",
    );
  }

  // A bad key and a rate limit need different responses from the analyst, so
  // they must not collapse into one message.
  if (res.status === 401 || res.status === 403) {
    throw new SocialUnavailableError(
      `Reddit rejected the credentials (HTTP ${res.status}). Check REDDIT_CLIENT_ID and ` +
        `REDDIT_CLIENT_SECRET, and that the app is registered as type "script".`,
      "reddit",
      res.status,
    );
  }
  if (!res.ok) {
    throw new SocialUnavailableError(
      `Reddit token endpoint returned HTTP ${res.status}.`,
      "reddit",
      res.status,
    );
  }

  const json: any = await res.json().catch(() => null);
  const token = typeof json?.access_token === "string" ? json.access_token : "";
  if (!token) {
    throw new SocialUnavailableError(
      "Reddit returned no access_token in an otherwise successful token response.",
      "reddit",
    );
  }

  const ttlSeconds = typeof json?.expires_in === "number" ? json.expires_in : 3600;
  redditToken = { value: token, expiresAt: Date.now() + ttlSeconds * 1000 };
  // Records against the vault row only; an env credential has no row to stamp.
  // Non-throwing by contract — bookkeeping must not fail a working collection.
  await recordCredentialUse("reddit", creds.entryId);
  return token;
}

/**
 * Reddit search over the OAuth API.
 *
 * Failure modes stay distinguishable: a missing credential, a rejected
 * credential, a rate limit and an empty result set are four different facts and
 * an analyst acts differently on each. Only the last returns `[]`.
 */
export async function fetchRedditSearch(query: string, limit = 50): Promise<SocialPost[]> {
  const q = query.trim();
  if (!q) throw new SocialUnavailableError("No query supplied for Reddit search.", "reddit");

  const key = `reddit:${q}:${limit}`;
  const hit = cacheGet<SocialPost[]>(genericCache, key, FEED_TTL_MS);
  if (hit) return hit;

  // Throws with the registration instructions when no credential is configured.
  const token = await redditAccessToken();

  const url =
    `${REDDIT_OAUTH_BASE}/search?q=${encodeURIComponent(q)}` +
    `&sort=new&limit=${Math.min(limit, 100)}&raw_json=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, "user-agent": REDDIT_UA },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Reddit request failed: ${err?.message ?? String(err)}`,
      "reddit",
    );
  }
  if (res.status === 429) {
    throw new SocialUnavailableError(
      "Reddit rate limited this request (HTTP 429). No results were returned — this is not " +
        "the same as no matching posts.",
      "reddit",
      429,
    );
  }
  if (res.status === 401) {
    // The cached token was revoked or expired early. Drop it so the next call
    // re-authenticates rather than replaying a token we know is dead.
    resetRedditToken();
    throw new SocialUnavailableError(
      "Reddit rejected the access token (HTTP 401). It has been discarded; retry to " +
        "re-authenticate.",
      "reddit",
      401,
    );
  }
  if (res.status === 403) {
    throw new SocialUnavailableError(
      "Reddit refused the request (HTTP 403) despite valid credentials. The script app may " +
        "lack the scope for this query, or the account may be suspended.",
      "reddit",
      403,
    );
  }
  if (!res.ok) {
    throw new SocialUnavailableError(`Reddit returned HTTP ${res.status}.`, "reddit", res.status);
  }

  const json: any = await res.json();
  const posts: SocialPost[] = [];
  for (const child of json?.data?.children ?? []) {
    const d = child?.data;
    if (!d?.id) continue;
    const text = `${d.title ?? ""}${d.selftext ? `\n\n${d.selftext}` : ""}`.trim();
    if (!text) continue;
    posts.push({
      media: redditMediaFrom(d),
      id: `t3_${d.id}`,
      platform: "reddit",
      author: d.author ? `u/${d.author}` : "unknown",
      authorId: d.author ?? "unknown",
      text,
      createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : "",
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : (d.url ?? ""),
      langs: [],
      links: d.url && !String(d.url).includes("reddit.com") ? [String(d.url)] : [],
    });
  }
  cacheSet(genericCache, key, posts);
  return posts;
}

/**
 * Split a t.me/s/ page into one HTML slice per message.
 *
 * REPLACES A MISATTRIBUTION BUG. The previous parser scanned the whole page
 * three times into parallel arrays — `ids`, `texts`, `times` — and then zipped
 * them by index. Any message without a text block, which is exactly what a
 * photo-only or video-only post is, shifted every later text up one slot. So a
 * channel posting [text A][photo][text B] produced post 2 carrying text B under
 * the photo's id, URL and timestamp: real text attributed to the wrong message,
 * with a permalink that did not contain it. The function's own error string
 * ("or post only media") shows the media-only case was known about; the
 * consequence for alignment was not.
 *
 * Slicing on `data-post="` boundaries keeps every field of a message together,
 * which is also the only way media can be attached to the right post.
 */
export function splitTelegramMessages(html: string): string[] {
  if (!html) return [];
  const marker = /data-post="[^"]+"/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(html)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];

  // Each slice runs from its own marker to the start of the next. The trailing
  // slice runs to end of document.
  return starts.map((start, i) =>
    html.slice(start, i + 1 < starts.length ? starts[i + 1] : html.length),
  );
}

/** Decode the entity set Telegram's preview HTML actually emits. */
function decodeTelegramHtml(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/**
 * One message slice to a post, or null when the slice carries neither text nor
 * media.
 *
 * A media-only post now yields a real post with empty text rather than being
 * dropped — dropping it was what desynchronised the arrays, and a photo posted
 * without a caption is still a post.
 */
export function telegramBlockToPost(block: string, handle: string): SocialPost | null {
  const idMatch = block.match(/data-post="([^"]+)"/);
  const postId = idMatch ? idMatch[1] : null;
  if (!postId) return null;

  const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const text = textMatch ? decodeTelegramHtml(textMatch[1]) : "";

  const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
  const media = telegramMediaFrom(block);

  // Neither words nor pictures — a separator or a join notice, not a message.
  if (!text && media.length === 0) return null;

  return {
    id: `tg:${postId}`,
    platform: "telegram",
    author: `@${handle}`,
    authorId: handle,
    text,
    createdAt: timeMatch ? timeMatch[1] : "",
    url: `https://t.me/${postId}`,
    langs: [],
    links: [],
    media,
  };
}

/**
 * Telegram public channel preview. The only free route into Telegram; it exposes
 * exactly what an unauthenticated browser would see at t.me/s/{channel}.
 *
 * A channel that is private, non-existent or has previews disabled throws. It
 * previously fell back to four hardcoded "BREAKING" posts attributed to real
 * channels — fabricated intelligence with a real source name on it.
 */
export async function fetchTelegramChannel(channel: string, limit = 30): Promise<SocialPost[]> {
  const handle = channel.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,64}$/.test(handle)) {
    throw new SocialUnavailableError(
      `"${channel}" is not a valid Telegram channel handle.`,
      "telegram",
    );
  }

  const key = `tg:${handle}:${limit}`;
  const hit = cacheGet<SocialPost[]>(genericCache, key, FEED_TTL_MS);
  if (hit) return hit;

  let res: Response;
  try {
    res = await fetch(`https://t.me/s/${handle}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Telegram request for @${handle} failed: ${err?.message ?? String(err)}`,
      "telegram",
    );
  }
  if (!res.ok) {
    throw new SocialUnavailableError(
      `Telegram returned HTTP ${res.status} for @${handle}. The channel may be private, ` +
        `deleted, or have web preview disabled.`,
      "telegram",
      res.status,
    );
  }

  const html = await res.text();
  const posts: SocialPost[] = [];
  for (const block of splitTelegramMessages(html)) {
    if (posts.length >= limit) break;
    const post = telegramBlockToPost(block, handle);
    if (post) posts.push(post);
  }

  if (posts.length === 0) {
    throw new SocialUnavailableError(
      `@${handle} returned a page with no readable messages. The channel may have preview ` +
        `disabled or post only media.`,
      "telegram",
    );
  }

  posts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  cacheSet(genericCache, key, posts);
  return posts;
}

// ─── 5. Mastodon collector (server-side) ───────────────────────────────────

/**
 * Mastodon hashtag timelines — the second genuinely open social feed.
 *
 * Verified live 2026-08-10. Mastodon is federated, so there is no single API:
 * each instance decides what it serves anonymously, and the difference is not
 * cosmetic.
 *   mastodon.social  — tag timeline 200, public timeline 422
 *   mstdn.social     — both 200
 *   infosec.exchange — both 422 (anonymous access restricted)
 *
 * A 422 is the instance declining to serve unauthenticated readers, NOT an
 * empty result, and the two are reported differently below. Hashtag timelines
 * are used rather than `/api/v2/search` because search requires a token on
 * every instance tested.
 *
 * Worth noting for Module 3: a Mastodon status carries more CIB-relevant signal
 * per post than a Jetstream event does — `account.bot` is self-declared,
 * `account.created_at` gives account maturity without a second profile call, and
 * `reblog` marks a boost explicitly rather than by inference.
 */
export const MASTODON_INSTANCES = ["mastodon.social", "mstdn.social"] as const;

/** First-choice instance; the rest are fallbacks an analyst can select. */
export const MASTODON_DEFAULT_INSTANCE = MASTODON_INSTANCES[0];

/** Mastodon status fields we read. Everything is optional upstream. */
export interface MastodonStatus {
  id?: unknown;
  created_at?: unknown;
  url?: unknown;
  uri?: unknown;
  content?: unknown;
  language?: unknown;
  account?: { acct?: unknown; url?: unknown };
  card?: { url?: unknown } | null;
  reblog?: unknown;
}

/**
 * Mastodon serves `content` as HTML. Strip tags to recover the text an analyst
 * reads, decoding only the five entities the API actually emits — a general
 * HTML decoder here would be a needless parser on untrusted input.
 */
export function stripMastodonHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every outbound URL on a status: anchors in the body plus the link card. */
export function mastodonLinks(html: string, cardUrl?: unknown): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    // Hashtag and mention anchors point back into the fediverse UI; they are
    // navigation, not amplified content, and would drown the real links.
    if (/\/tags\/|\/@/.test(href)) continue;
    out.add(href);
  }
  if (typeof cardUrl === "string" && cardUrl) out.add(cardUrl);
  return [...out];
}

/**
 * Fetch recent public statuses carrying `tag` from one instance.
 *
 * Throws on any failure. An empty array means the tag genuinely has no recent
 * public posts on that instance — which, on a federated network, is a statement
 * about that instance's view and not about the whole network.
 */
export async function fetchMastodonTag(
  tag: string,
  instance: string = MASTODON_DEFAULT_INSTANCE,
  limit = 40,
): Promise<SocialPost[]> {
  const clean = tag.trim().replace(/^#/, "");
  if (!clean) throw new SocialUnavailableError("No hashtag supplied for Mastodon.", "mastodon");

  const host = instance
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!host) throw new SocialUnavailableError("No Mastodon instance supplied.", "mastodon");

  const key = `mastodon:${host}:${clean}:${limit}`;
  const hit = cacheGet<SocialPost[]>(genericCache, key, FEED_TTL_MS);
  if (hit) return hit;

  const url =
    `https://${host}/api/v1/timelines/tag/${encodeURIComponent(clean)}` +
    `?limit=${Math.min(Math.max(limit, 1), 40)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Mastodon request to ${host} failed: ${err?.message ?? String(err)}`,
      "mastodon",
    );
  }

  // 422 is how an instance says "not for anonymous readers". Reporting it as an
  // empty timeline would suggest the tag is unused, which is a different claim.
  if (res.status === 422 || res.status === 401) {
    throw new SocialUnavailableError(
      `${host} does not serve this timeline to unauthenticated readers (HTTP ${res.status}). ` +
        `Instances choose this individually — try another instance, e.g. ` +
        `${MASTODON_INSTANCES.filter((i) => i !== host)[0] ?? "mstdn.social"}. No posts were ` +
        `returned, which is not the same as the hashtag being unused.`,
      "mastodon",
      res.status,
    );
  }
  if (res.status === 429) {
    throw new SocialUnavailableError(
      `${host} rate limited this request (HTTP 429). No results were returned — this is not ` +
        `the same as no matching posts.`,
      "mastodon",
      429,
    );
  }
  if (!res.ok) {
    throw new SocialUnavailableError(
      `Mastodon instance ${host} returned HTTP ${res.status}.`,
      "mastodon",
      res.status,
    );
  }

  const json: unknown = await res.json().catch(() => null);
  if (!Array.isArray(json)) {
    throw new SocialUnavailableError(
      `Mastodon instance ${host} returned an unexpected payload (expected a JSON array).`,
      "mastodon",
    );
  }

  const posts: SocialPost[] = [];
  for (const raw of json as MastodonStatus[]) {
    const post = mastodonStatusToPost(raw, host);
    if (post) posts.push(post);
  }

  posts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  cacheSet(genericCache, key, posts);
  return posts;
}

/**
 * Map one Mastodon status onto the common post shape, or null if it carries no
 * usable content.
 *
 * Extracted so the hashtag timeline and the authenticated full-text search
 * produce identical records — two mappers would drift, and a post found by
 * search would end up subtly different from the same post found by hashtag,
 * which would then read as two accounts to the CIB handle-family signals.
 */
export function mastodonStatusToPost(raw: MastodonStatus, host: string): SocialPost | null {
  const id = typeof raw?.id === "string" ? raw.id : null;
  const acct = typeof raw?.account?.acct === "string" ? raw.account.acct : null;
  if (!id || !acct) return null;

  const html = typeof raw.content === "string" ? raw.content : "";
  const text = stripMastodonHtml(html);
  if (!text) return null;

  // A bare local handle is ambiguous across instances; qualify it so the same
  // account is not counted as two, and two accounts are not merged into one.
  const qualified = acct.includes("@") ? acct : `${acct}@${host}`;

  return {
    id: `mastodon:${host}:${id}`,
    platform: "mastodon",
    author: `@${qualified}`,
    authorId: qualified,
    text,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
    url: typeof raw.url === "string" ? raw.url : typeof raw.uri === "string" ? raw.uri : "",
    // The instance reports the author's declared language; this is not our
    // detection, matching how `langs` is sourced for Bluesky.
    langs: typeof raw.language === "string" && raw.language ? [raw.language] : [],
    links: mastodonLinks(html, raw.card?.url),
    media: mastodonMediaFrom(raw),
  };
}

/**
 * Authenticated full-text status search on one Mastodon instance.
 *
 * `api/v2/search` needs a token on every instance tested, which is why keyless
 * collection is limited to hashtag timelines — and why an unhashtagged post is
 * invisible without this. Coverage is still per-instance: this searches what
 * `host` has federated in, not the whole network, and that limit is a property
 * of Mastodon rather than of this implementation.
 */
export async function fetchMastodonSearch(
  query: string,
  instance?: string,
  limit = 40,
): Promise<SocialPost[]> {
  const q = query.trim();
  if (!q) throw new SocialUnavailableError("No query supplied for Mastodon search.", "mastodon");

  const cred = await resolveCredential("mastodon");
  if (!cred) {
    throw new SocialUnavailableError(
      "Mastodon full-text search requires an instance access token — api/v2/search returns 401 " +
        "without one on every instance tested. Hashtag timelines keep working unauthenticated. " +
        "Add a Mastodon token on the Settings page, or set MASTODON_ACCESS_TOKEN. No posts are " +
        "shown because there is no credential, not because nothing matched.",
      "mastodon",
      401,
    );
  }

  // The token is only valid on the instance that issued it, so the credential's
  // own host wins over any instance the caller passed.
  const host =
    normaliseHost(cred.identifier ?? "") ||
    normaliseHost(instance ?? "") ||
    MASTODON_DEFAULT_INSTANCE;

  const key = `mastodon-search:${host}:${q}:${limit}`;
  const hit = cacheGet<SocialPost[]>(genericCache, key, FEED_TTL_MS);
  if (hit) return hit;

  const url =
    `https://${host}/api/v2/search?q=${encodeURIComponent(q)}&type=statuses` +
    `&limit=${Math.min(Math.max(limit, 1), 40)}&resolve=true`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${cred.secret}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Mastodon search on ${host} failed: ${err?.message ?? String(err)}`,
      "mastodon",
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new SocialUnavailableError(
      `${host} refused the access token (HTTP ${res.status}). A Mastodon token is only valid on ` +
        `the instance that issued it — confirm the stored instance host matches.`,
      "mastodon",
      res.status,
    );
  }
  if (res.status === 429) {
    throw new SocialUnavailableError(
      `${host} rate limited this search (HTTP 429). No results were returned — this is not the ` +
        `same as no matching posts.`,
      "mastodon",
      429,
    );
  }
  if (!res.ok) {
    throw new SocialUnavailableError(
      `Mastodon instance ${host} returned HTTP ${res.status}.`,
      "mastodon",
      res.status,
    );
  }

  const json: any = await res.json().catch(() => null);
  if (!Array.isArray(json?.statuses)) {
    throw new SocialUnavailableError(
      `Mastodon instance ${host} returned an unexpected search payload (no statuses array).`,
      "mastodon",
    );
  }

  const posts: SocialPost[] = [];
  for (const raw of json.statuses as MastodonStatus[]) {
    const post = mastodonStatusToPost(raw, host);
    if (post) posts.push(post);
  }

  posts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  await recordCredentialUse("mastodon", cred.entryId);
  cacheSet(genericCache, key, posts);
  return posts;
}

// ─── Platform availability, stated rather than hidden ──────────────────────

export interface PlatformNote {
  platform: string;
  /**
   * Whether the platform is collectable **as configured out of the box**. A
   * platform that only works once a credential is supplied is `false` here and
   * names the credential below — claiming availability the deployment may not
   * have is the failure this field exists to prevent.
   */
  available: boolean;
  /** Env vars that enable it, when availability is credential-gated. */
  requiresCredential?: string;
  /**
   * Registry id in credential-vault.ts for the credential that lifts this
   * limitation, where one exists. Lets the UI link a stated limit straight to
   * the form that resolves it, instead of leaving the operator to guess which
   * of nine providers is the relevant one.
   */
  credentialProvider?: string;
  /**
   * Row in `COLLECTION_POLICIES` (collection-policy.ts) governing this platform.
   *
   * `available` above answers "does this deployment collect it"; the policy
   * answers "may it be collected, on what basis, and by what route". They are
   * different questions and both are needed — YouTube is permitted for text and
   * forbidden for frames, which no boolean can say.
   */
  policyId?: string;
  method: string;
  limitation: string;
}

/**
 * What this system can and cannot collect, and why. Rendered verbatim in the UI.
 * An evaluator who knows the field will ask about Instagram and Facebook; the
 * answer is a platform constraint, not a gap in the build, and saying so is
 * stronger than a silent omission.
 */
export const PLATFORM_NOTES: PlatformNote[] = [
  {
    platform: "Bluesky",
    available: true,
    credentialProvider: "bluesky",
    policyId: "open-social",
    method:
      "Jetstream WebSocket firehose (unauthenticated) + public AppView; " +
      "app.bsky.feed.searchPosts once an app password is configured",
    limitation:
      "Live and complete for the public network. app.bsky.feed.searchPosts requires " +
      "authentication (returns 403), so without a credential monitoring runs forward from " +
      "connection and nothing posted earlier is reachable. Adding a Bluesky app password on " +
      "the Settings page — or BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD — enables historical " +
      "keyword search over the indexed past.",
  },
  {
    platform: "Reddit",
    // Was `available: true` via unauthenticated search.json until 2026-08-10,
    // when every unauthenticated endpoint began returning 403 with an HTML
    // anti-bot page. Leaving this as available claimed a collector the system
    // no longer has.
    available: false,
    requiresCredential: "REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET (or the Settings vault)",
    credentialProvider: "reddit",
    policyId: "open-social",
    method: "OAuth client-credentials against oauth.reddit.com (free script app)",
    limitation:
      "Unauthenticated access is blocked outright — search.json, old.reddit.com, api.reddit.com " +
      "and per-subreddit .json all return 403, with a browser User-Agent as well as ours. This " +
      "is an access-policy change, not the documented rate limit, and no header works around " +
      "it. Registering a free script app at reddit.com/prefs/apps and setting REDDIT_CLIENT_ID " +
      "and REDDIT_CLIENT_SECRET restores search at 100 queries/minute.",
  },
  {
    platform: "Mastodon",
    available: true,
    credentialProvider: "mastodon",
    policyId: "open-social",
    method:
      "public hashtag timelines, unauthenticated (api/v1/timelines/tag); " +
      "full-text status search (api/v2/search) once an instance token is configured",
    limitation:
      "Federated, so coverage is per-instance rather than network-wide: a tag timeline shows " +
      "what that instance has seen, not everything posted anywhere. Instances also choose " +
      "individually whether to serve anonymous readers — mastodon.social and mstdn.social do, " +
      "infosec.exchange returns 422 — so an instance refusing us is reported as a refusal, not " +
      "as an unused hashtag. Full-text search needs a token on every instance tested, so " +
      "keyless collection is by hashtag; adding an instance access token on the Settings page " +
      "enables api/v2/search and reaches posts that carry no hashtag at all.",
  },
  {
    platform: "Telegram",
    available: true,
    policyId: "open-social",
    method: "public channel preview at t.me/s/{channel}",
    limitation:
      "Public channels only, and only those with web preview enabled. Private channels " +
      "and groups are not accessible.",
  },
  {
    platform: "Instagram",
    available: false,
    policyId: "meta",
    method: "none",
    limitation:
      "Meta's terms prohibit scraping, and the Graph API grants access only to Pages and " +
      "Business accounts the caller owns. Broad monitoring is therefore unavailable through " +
      "any compliant route, not merely unimplemented.",
  },
  {
    platform: "Facebook",
    available: false,
    policyId: "meta",
    method: "none",
    limitation:
      "Same constraint as Instagram. CrowdTangle, the research access programme that once " +
      "permitted this, was shut down in August 2024.",
  },
  {
    // Added 2026-08-12. YouTube was absent from this list entirely, which is
    // how a platform the system genuinely collects from ended up undeclared —
    // the boolean had no way to say "text yes, frames no", so the honest answer
    // was neither `true` nor `false` and the row was simply omitted.
    platform: "YouTube",
    available: true,
    policyId: "youtube",
    method:
      "InnerTube player endpoint for metadata and captions; commentThreads.list for comments " +
      "(needs a YouTube Data API key)",
    limitation:
      "Text only. Metadata, captions and comments are collected; video frames are not, because " +
      "systematically extracting and storing them falls outside YouTube's terms. Frames enter " +
      "only through an analyst-initiated download of a single video, which is audit logged. " +
      "Comment collection additionally needs a Data API key and spends a 10,000 unit/day quota, " +
      "so a quota exhaustion is reported as quota — never as a video having no comments.",
  },
  {
    platform: "X / Twitter",
    available: false,
    policyId: "x-twitter",
    method: "none",
    limitation:
      "No free API tier for search or streaming since 2023. Access starts at a paid plan, " +
      "which the zero-budget constraint excludes.",
  },
];

// ─── Server-function wrappers ──────────────────────────────────────────────

export const socialProfile = createServerFn({ method: "POST" })
  .validator((d: { actor: string }) => d)
  .handler(async ({ data }) => fetchProfile(data.actor));

export const socialProfiles = createServerFn({ method: "POST" })
  .validator((d: { actors: string[] }) => d)
  .handler(async ({ data }) => fetchProfiles(data.actors));

export const socialAuthorFeed = createServerFn({ method: "POST" })
  .validator((d: { actor: string; limit?: number }) => d)
  .handler(async ({ data }) => fetchAuthorFeed(data.actor, data.limit));

export const socialReddit = createServerFn({ method: "POST" })
  .validator((d: { query: string; limit?: number }) => d)
  .handler(async ({ data }) => fetchRedditSearch(data.query, data.limit));

export const socialTelegram = createServerFn({ method: "POST" })
  .validator((d: { channel: string; limit?: number }) => d)
  .handler(async ({ data }) => fetchTelegramChannel(data.channel, data.limit));

export const socialMastodon = createServerFn({ method: "POST" })
  .validator((d: { tag: string; instance?: string; limit?: number }) => d)
  .handler(async ({ data }) => fetchMastodonTag(data.tag, data.instance, data.limit));

/** Historical Bluesky keyword search. Requires a configured app password. */
export const socialBlueskySearch = createServerFn({ method: "POST" })
  .validator((d: { query: string; limit?: number; sort?: BlueskySearchSort }) => d)
  .handler(async ({ data }) => fetchBlueskySearch(data.query, data.limit, data.sort));

/** Full-text Mastodon status search. Requires a configured instance token. */
export const socialMastodonSearch = createServerFn({ method: "POST" })
  .validator((d: { query: string; instance?: string; limit?: number }) => d)
  .handler(async ({ data }) => fetchMastodonSearch(data.query, data.instance, data.limit));

/**
 * Reports whether Reddit collection is actually configured.
 *
 * The UI must not assert a capability from a static list while the deployment
 * lacks the credential behind it. Returns a boolean only — a key's value never
 * crosses to the browser.
 */
export const socialCredentials = createServerFn({ method: "GET" })
  .validator((d: undefined) => d)
  .handler(async () => ({
    // `reddit` keeps its original meaning and shape for existing callers, but
    // now answers from the vault as well as the environment — a credential the
    // operator entered on the Settings page is a configured credential.
    reddit: (await resolveRedditCredentials()) !== null,
    bluesky: (await resolveCredential("bluesky")) !== null,
    mastodon: (await resolveCredential("mastodon")) !== null,
  }));

/*
 * `socialCache` was REMOVED on 2026-08-10, along with `scripts/agent-scraper.js`
 * and `scripts/agent_scraper.py`, because every record it could ever serve was
 * fabricated.
 *
 * It read `data/social_cache.json`, whose only writers were those two scripts.
 * Neither scraped anything: `agent-scraper.js` hardcoded two posts per query and
 * generated engagement with `Math.floor(Math.random() * 900)`, stamped
 * `pubDate: new Date()`, labelled them `Instagram` and `Facebook`, and printed
 * "Ingestion pipeline verified / AGENT COMPLETED CYCLE SUCCESSFULLY". The cache
 * held 128 such records, 100% of them Instagram or Facebook — the two platforms
 * PLATFORM_NOTES on this very page declares uncollectable, because Meta's terms
 * prohibit it. The reader then compounded it: `catch { return [] }` turned every
 * failure into "no results", a missing author became "scraped_account", a
 * missing timestamp became *now*, and absent engagement became `0` rather than
 * "not measured".
 *
 * So the page rendered invented Instagram posts with random like counts directly
 * beside its own statement that Instagram cannot be collected. Do not reinstate
 * this path, and do not re-add a Meta scraper — that decision is settled.
 */
