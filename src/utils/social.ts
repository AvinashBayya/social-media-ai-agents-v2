/**
 * Module 3 — social media content analysis, ingestion layer (PS-18 §6.3).
 *
 * PLATFORM REALITY, stated plainly because it drives every design decision here:
 *
 *   Bluesky  — Jetstream is an open, unauthenticated WebSocket firehose emitting
 *              JSON. It is the only genuinely open live social feed of any scale
 *              available at zero cost, and it is what makes this module real
 *              rather than a mock.
 *   Reddit   — public search JSON, unauthenticated, rate limited.
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

export type Platform = "bluesky" | "reddit" | "telegram";

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
}

// ─── 1. Jetstream consumer (browser) ───────────────────────────────────────

export const JETSTREAM_ENDPOINT = "wss://jetstream2.us-east.bsky.network/subscribe";
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

export function eventToPost(evt: JetstreamEvent): SocialPost | null {
  if (evt?.kind !== "commit") return null;
  const commit = evt.commit;
  if (!commit || commit.operation !== "create" || commit.collection !== POST_COLLECTION) return null;
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
  toArray(): T[] { return [...this.items]; }
  get size(): number { return this.items.length; }
  get dropped(): number { return this.droppedCount; }
  clear(): void { this.items = []; this.droppedCount = 0; }
}

export class JetstreamClient {
  private ws: WebSocket | null = null;
  private buffer: RingBuffer<SocialPost>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private status: JetstreamStatus = {
    state: "idle",
    detail: "Not connected.",
    attempts: 0,
    received: 0,
    dropped: 0,
    retryInMs: null,
    connectedAt: null,
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
    const url = `${JETSTREAM_ENDPOINT}?wantedCollections=${encodeURIComponent(POST_COLLECTION)}`;
    this.emit({ state: this.status.attempts === 0 ? "connecting" : "reconnecting", detail: `Opening ${JETSTREAM_ENDPOINT}`, retryInMs: null });

    let socket: WebSocket;
    try {
      socket = this.opts.socketFactory ? this.opts.socketFactory(url) : new WebSocket(url);
    } catch (err: any) {
      this.emit({ state: "error", detail: `WebSocket could not be created: ${err?.message ?? String(err)}` });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.emit({
        state: "open",
        detail: "Connected to Bluesky Jetstream.",
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
      this.emit({ state: "error", detail: "Socket error (the browser does not expose the cause)." });
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
    this.emit({ state: "reconnecting", attempts, retryInMs: delay });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), delay);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // Detach handlers before closing so onclose does not schedule a reconnect.
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    this.emit({ state: "closed", detail: "Disconnected by the analyst.", retryInMs: null, connectedAt: null });
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
      spiking: null, current: buckets[buckets.length - 1] ?? 0,
      baselineMean: null, baselineStdDev: null, z: null,
      bucketsObserved: buckets.length,
      reason: "No completed observation window yet.",
    };
  }

  const current = buckets[buckets.length - 1];
  const history = buckets.slice(0, -1).slice(-BASELINE_WINDOW);

  if (history.length < MIN_BASELINE_BUCKETS) {
    return {
      spiking: null, current, baselineMean: null, baselineStdDev: null, z: null,
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
      spiking, current, baselineMean: mean, baselineStdDev: 0, z: null,
      bucketsObserved: history.length,
      reason: spiking
        ? `Baseline was flat at ${mean.toFixed(1)}/min over ${history.length} minutes; this minute carried ${current}.`
        : `Baseline flat at ${mean.toFixed(1)}/min; this minute carried ${current}. No z-score is defined with zero variance.`,
    };
  }

  const z = (current - mean) / stdDev;
  const spiking = z >= SPIKE_SIGMA;
  return {
    spiking, current, baselineMean: mean, baselineStdDev: stdDev, z,
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
export function bucketise(posts: SocialPost[], now: number, windowMinutes = BASELINE_WINDOW + 1): number[] {
  const buckets = new Array(windowMinutes).fill(0);
  const newestBucket = Math.floor(now / BUCKET_MS);
  for (const p of posts) {
    const t = new Date(p.createdAt).getTime();
    if (!Number.isFinite(t)) continue;
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
interface CacheRow<T> { value: T; at: number }
const PROFILE_TTL_MS = 10 * 60_000;
const FEED_TTL_MS = 2 * 60_000;
const profileCache = new Map<string, CacheRow<BlueskyProfile>>();
const genericCache = new Map<string, CacheRow<unknown>>();

function cacheGet<T>(store: Map<string, CacheRow<any>>, key: string, ttl: number): T | null {
  const row = store.get(key);
  if (!row) return null;
  if (Date.now() - row.at > ttl) { store.delete(key); return null; }
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

async function appview(path: string, params: Record<string, string>, platform: Platform): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${APPVIEW}/${path}?${qs}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(
      `Bluesky AppView request failed: ${err?.message ?? String(err)}`, platform,
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
  const wanted = Array.from(new Set(actors.map((a) => a.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)));
  const out: BlueskyProfile[] = [];
  const missing: string[] = [];
  for (const a of wanted) {
    const hit = cacheGet<BlueskyProfile>(profileCache, a, PROFILE_TTL_MS);
    if (hit) out.push(hit); else missing.push(a);
  }
  for (let i = 0; i < missing.length; i += 25) {
    const batch = missing.slice(i, i + 25);
    const params = new URLSearchParams();
    for (const a of batch) params.append("actors", a);
    const raw = await appview("app.bsky.actor.getProfiles", Object.fromEntries(params as any), "bluesky")
      .catch(async () => {
        // getProfiles is all-or-nothing; fall back to individual lookups so one
        // deleted account does not lose the whole batch.
        const singles = await Promise.allSettled(batch.map((a) => fetchProfile(a)));
        return { profiles: singles.filter((s) => s.status === "fulfilled").map((s: any) => s.value) };
      });
    for (const p of raw?.profiles ?? []) {
      const profile = p.did ? toProfile(p) : (p as BlueskyProfile);
      if (profile.did) { cacheSet(profileCache, profile.handle || profile.did, profile); out.push(profile); }
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
    });
  }
  cacheSet(genericCache, key, posts);
  return posts;
}

// ─── 4. Reddit and Telegram collectors (server-side) ───────────────────────

/**
 * Reddit public search. Unauthenticated and rate limited; a 429 is reported as a
 * rate limit rather than as "no results", because those mean opposite things to
 * an analyst. Registering a free script app for OAuth would raise the limit and
 * is the obvious next step if this is used at volume.
 */
export async function fetchRedditSearch(query: string, limit = 50): Promise<SocialPost[]> {
  const q = query.trim();
  if (!q) throw new SocialUnavailableError("No query supplied for Reddit search.", "reddit");

  const key = `reddit:${q}:${limit}`;
  const hit = cacheGet<SocialPost[]>(genericCache, key, FEED_TTL_MS);
  if (hit) return hit;

  const url =
    `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}` +
    `&sort=new&limit=${Math.min(limit, 100)}&raw_json=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "SentinelAI/1.0 (OSINT research; contact via repository)" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new SocialUnavailableError(`Reddit request failed: ${err?.message ?? String(err)}`, "reddit");
  }
  if (res.status === 429) {
    throw new SocialUnavailableError(
      "Reddit rate limited this request (HTTP 429). No results were returned — this is not " +
        "the same as no matching posts.",
      "reddit", 429,
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
    throw new SocialUnavailableError(`"${channel}" is not a valid Telegram channel handle.`, "telegram");
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
      `Telegram request for @${handle} failed: ${err?.message ?? String(err)}`, "telegram",
    );
  }
  if (!res.ok) {
    throw new SocialUnavailableError(
      `Telegram returned HTTP ${res.status} for @${handle}. The channel may be private, ` +
        `deleted, or have web preview disabled.`,
      "telegram", res.status,
    );
  }

  const html = await res.text();
  const posts: SocialPost[] = [];
  const blockRe = /<div class="tgme_widget_message(?:_wrap)?[\s\S]*?data-post="([^"]+)"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  const textRe = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const timeRe = /<time[^>]*datetime="([^"]+)"/g;

  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) ids.push(m[1]);

  const texts: string[] = [];
  while ((m = textRe.exec(html)) !== null) {
    const clean = m[1]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
    if (clean) texts.push(clean);
  }

  const times: string[] = [];
  while ((m = timeRe.exec(html)) !== null) times.push(m[1]);

  for (let i = 0; i < texts.length && posts.length < limit; i += 1) {
    const postId = ids[i] ?? `${handle}/${i}`;
    posts.push({
      id: `tg:${postId}`,
      platform: "telegram",
      author: `@${handle}`,
      authorId: handle,
      text: texts[i],
      createdAt: times[i] ?? "",
      url: `https://t.me/${postId}`,
      langs: [],
      links: [],
    });
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

// ─── Platform availability, stated rather than hidden ──────────────────────

export interface PlatformNote {
  platform: string;
  available: boolean;
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
    method: "Jetstream WebSocket firehose (unauthenticated) + public AppView",
    limitation:
      "Live and complete for the public network. app.bsky.feed.searchPosts requires " +
      "authentication (returns 403), so historical keyword search is unavailable without " +
      "an account; monitoring runs forward from connection.",
  },
  {
    platform: "Reddit",
    available: true,
    method: "public search.json, unauthenticated",
    limitation:
      "Rate limited. A free registered script app would raise the ceiling via OAuth.",
  },
  {
    platform: "Telegram",
    available: true,
    method: "public channel preview at t.me/s/{channel}",
    limitation:
      "Public channels only, and only those with web preview enabled. Private channels " +
      "and groups are not accessible.",
  },
  {
    platform: "Instagram",
    available: false,
    method: "none",
    limitation:
      "Meta's terms prohibit scraping, and the Graph API grants access only to Pages and " +
      "Business accounts the caller owns. Broad monitoring is therefore unavailable through " +
      "any compliant route, not merely unimplemented.",
  },
  {
    platform: "Facebook",
    available: false,
    method: "none",
    limitation:
      "Same constraint as Instagram. CrowdTangle, the research access programme that once " +
      "permitted this, was shut down in August 2024.",
  },
  {
    platform: "X / Twitter",
    available: false,
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
