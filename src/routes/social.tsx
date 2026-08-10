import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, PageHeader, StatusDot } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Radio,
  Plus,
  X,
  AlertTriangle,
  Loader2,
  ShieldAlert,
  Ban,
  ChevronDown,
  ChevronRight,
  Activity,
  Link2,
  Users,
} from "lucide-react";
import {
  JetstreamClient,
  readMonitor,
  socialReddit,
  socialTelegram,
  socialMastodon,
  socialProfiles,
  socialCredentials,
  JETSTREAM_ENDPOINT,
  JETSTREAM_INSTANCES,
  PLATFORM_NOTES,
  type JetstreamStatus,
  type Monitor,
  type MonitorReading,
  type SocialPost,
  type BlueskyProfile,
} from "@/utils/social";
import {
  assessCluster,
  observationWindowOf,
  CIB_CAVEAT,
  MIN_OBSERVATION_MINUTES,
  type CibCluster,
} from "@/utils/cib";
import { assessSocialCorpus } from "@/utils/social-credibility";
import { PinButton } from "@/components/pin-button";

export const Route = createFileRoute("/social")({
  head: () => ({ meta: [{ title: "Social Intelligence — Sentinel AI" }] }),
  component: SocialPage,
});

const MONITOR_KEY = "sentinel_social_monitors";
const RENDER_LIMIT = 120;
const CIB_WINDOW = 400;
const FLUSH_MS = 1000;

function loadMonitors(): Monitor[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MONITOR_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const CARD = "bg-[#111827] border-[#263548]";

function Sparkline({ values }: { values: number[] }) {
  const shown = values.slice(-40);
  const max = Math.max(1, ...shown);
  return (
    <div className="flex h-6 items-end gap-[1px]">
      {shown.map((v, i) => (
        <div
          key={i}
          className="w-[3px] shrink-0 bg-[#3B82F6]"
          style={{ height: `${Math.max(1, (v / max) * 100)}%` }}
          title={`${v} in that minute`}
        />
      ))}
      {shown.length === 0 && <span className="text-[9px] text-[#64748B]">no history yet</span>}
    </div>
  );
}

function SocialPage() {
  const clientRef = useRef<JetstreamClient | null>(null);
  const [status, setStatus] = useState<JetstreamStatus | null>(null);
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [termDraft, setTermDraft] = useState("");
  const [activeMonitor, setActiveMonitor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [cibClusters, setCibClusters] = useState<CibCluster[] | null>(null);
  const [cibBusy, setCibBusy] = useState(false);
  const [cibError, setCibError] = useState("");
  const [openCluster, setOpenCluster] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<BlueskyProfile[]>([]);

  const [pullTarget, setPullTarget] = useState("");
  const [pullBusy, setPullBusy] = useState<"reddit" | "telegram" | "mastodon" | null>(null);
  const [pullError, setPullError] = useState("");
  const [pulled, setPulled] = useState<SocialPost[]>([]);
  /** null = not yet checked. Distinct from false, which is "checked, absent". */
  const [redditReady, setRedditReady] = useState<boolean | null>(null);

  useEffect(() => setMonitors(loadMonitors()), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MONITOR_KEY, JSON.stringify(monitors));
  }, [monitors]);

  // The data/social_cache.json loader was REMOVED on 2026-08-10. Every record it
  // seeded `pulled` with was fabricated by scripts/agent-scraper.js — hardcoded
  // Instagram and Facebook posts with Math.random() engagement counts — so this
  // page opened showing invented posts from the two platforms it simultaneously
  // declares uncollectable. Posts now come only from the live collectors.

  // Reddit needs OAuth credentials since 2026-08-10; ask the server whether they
  // are configured rather than claiming availability from a static list.
  useEffect(() => {
    (async () => {
      try {
        const c = (await socialCredentials()) as unknown as { reddit: boolean };
        setRedditReady(Boolean(c?.reddit));
      } catch {
        setRedditReady(false);
      }
    })();
  }, []);

  // ── The socket. Browser-side, bounded buffer, flushed to React on a timer. ──
  useEffect(() => {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;

    const client = new JetstreamClient({
      bufferSize: 2000,
      onStatus: (s) => setStatus(s),
    });
    clientRef.current = client;
    client.connect();

    // Rendering per post would re-render several hundred times a second. The
    // buffer is the source of truth; React sees a snapshot once a second.
    const flush = setInterval(() => {
      setPosts(client.getPosts());
      setStatus(client.getStatus());
      setNow(Date.now());
    }, FLUSH_MS);

    return () => {
      clearInterval(flush);
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  const allPosts = useMemo(() => [...pulled, ...posts], [pulled, posts]);

  const readings = useMemo<MonitorReading[]>(
    () => monitors.map((m) => readMonitor(m, allPosts, now)),
    [monitors, allPosts, now],
  );

  const active = readings.find((r) => r.monitor.id === activeMonitor) ?? null;
  const feed = (active ? active.matches : allPosts).slice(-RENDER_LIMIT).reverse();

  /** Posts received in the last complete minute across the whole stream. */
  const observedRate = useMemo(() => {
    const cutoff = now - 60_000;
    return posts.filter((p) => {
      const t = new Date(p.createdAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    }).length;
  }, [posts, now]);

  const addMonitor = () => {
    const term = termDraft.trim();
    if (!term || monitors.some((m) => m.term.toLowerCase() === term.toLowerCase())) return;
    setMonitors((prev) => [
      ...prev,
      // Deterministic id — no Math.random anywhere in this module.
      {
        id: `m${Date.now().toString(36)}${prev.length}`,
        term,
        createdAt: new Date().toISOString(),
      },
    ]);
    setTermDraft("");
  };

  const removeMonitor = (id: string) => {
    setMonitors((prev) => prev.filter((m) => m.id !== id));
    if (activeMonitor === id) setActiveMonitor(null);
  };

  const runCib = useCallback(async () => {
    setCibBusy(true);
    setCibError("");
    try {
      const window_ = (active ? active.matches : allPosts).slice(-CIB_WINDOW);
      if (window_.length < 4) {
        throw new Error(
          `Only ${window_.length} post(s) in the window. Coordination is a property of a group; ` +
            `let the stream run, or select a monitor with more traffic.`,
        );
      }

      // First pass with no profiles — enough to find candidate clusters.
      const first = assessSocialCorpus(window_, { now: Date.now() });

      // Then fetch profiles ONLY for accounts in flagged clusters. The AppView is
      // rate limited and most of the buffer is irrelevant.
      let fetched: BlueskyProfile[] = [];
      if (first.accountsWorthResolving.length > 0) {
        try {
          fetched = (await socialProfiles({
            data: { actors: first.accountsWorthResolving.slice(0, 50) },
          })) as unknown as BlueskyProfile[];
          setProfiles(fetched);
        } catch (err: any) {
          // A failed profile fetch degrades the assessment; it does not
          // invalidate it, and the maturity signal will report itself skipped.
          setCibError(
            `Profiles unavailable (maturity signal will show as skipped): ${err?.message ?? err}`,
          );
        }
      }

      // The window must carry into the re-assessment. Passing only the cluster's
      // own posts would make every cluster look perfectly synchronised, since a
      // cluster is by definition a tight group inside a wider collection.
      const observationWindowMinutes = observationWindowOf(window_);
      const withProfiles = fetched.length
        ? first.cibClusters.map((c) =>
            assessCluster(c.posts, {
              profiles: fetched,
              now: Date.now(),
              observationWindowMinutes,
            }),
          )
        : first.cibClusters;

      setCibClusters(
        [...withProfiles].sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1)),
      );
    } catch (err: any) {
      setCibError(err?.message ?? String(err));
      setCibClusters(null);
    } finally {
      setCibBusy(false);
    }
  }, [active, allPosts]);

  const pull = async (kind: "reddit" | "telegram" | "mastodon") => {
    const target = pullTarget.trim();
    if (!target) return;
    setPullBusy(kind);
    setPullError("");
    try {
      const res: any =
        kind === "reddit"
          ? await socialReddit({ data: { query: target, limit: 50 } })
          : kind === "mastodon"
            ? await socialMastodon({ data: { tag: target, limit: 40 } })
            : await socialTelegram({ data: { channel: target, limit: 30 } });
      setPulled((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...(res as SocialPost[]).filter((p) => !seen.has(p.id))];
      });
    } catch (err: any) {
      setPullError(err?.message ?? String(err));
    } finally {
      setPullBusy(null);
    }
  };

  const stateTone =
    status?.state === "open" ? "success" : status?.state === "closed" ? "warning" : "danger";

  return (
    <AppShell>
      <PageHeader
        title="Social Intelligence"
        description="Live open social collection with coordinated-behaviour signals. Bluesky Jetstream runs in this browser tab; Reddit and Telegram are pulled server-side on request."
      />

      {/* ── Platform status: genuine connection state, not a hardcoded "Active" ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 font-mono text-xs">
        <Card className={`${CARD} sm:col-span-2 lg:col-span-1`}>
          <CardContent className="space-y-2 p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold uppercase text-white">Bluesky</span>
              <StatusDot tone={stateTone as any} />
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[#64748B]">
              {status?.state ?? "initialising"}
            </div>
            <p className="text-[10px] leading-relaxed text-[#94A3B8]">
              {status?.detail ?? "Opening the socket…"}
              {status?.retryInMs != null && ` Retrying in ${Math.round(status.retryInMs / 1000)}s.`}
            </p>
            <dl className="space-y-0.5 border-t border-[#263548] pt-2 text-[10px] text-[#94A3B8]">
              <div className="flex justify-between">
                <dt>Posts received</dt>
                <dd className="tabular-nums text-white">
                  {status?.received.toLocaleString() ?? 0}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Rate (last 60s)</dt>
                <dd className="tabular-nums text-white">{observedRate}/min</dd>
              </div>
              <div className="flex justify-between">
                <dt>Buffer</dt>
                <dd className="tabular-nums text-white">{posts.length}/2000</dd>
              </div>
              <div className="flex justify-between">
                <dt>Dropped (buffer full)</dt>
                <dd className="tabular-nums text-white">{status?.dropped.toLocaleString() ?? 0}</dd>
              </div>
            </dl>
            <p className="break-all text-[9px] leading-relaxed text-[#64748B]">
              {status?.endpoint ?? JETSTREAM_ENDPOINT} · unauthenticated · one of{" "}
              {JETSTREAM_INSTANCES.length} public instances, rotated on reconnect · socket held by
              this tab, so collection stops when you close it.
            </p>
          </CardContent>
        </Card>

        <Card className={`${CARD} sm:col-span-2`}>
          <CardContent className="p-3.5">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
              <Ban className="size-3.5 text-[#F59E0B]" />
              Platform coverage and its limits
            </h3>
            <div className="mt-2 space-y-1.5">
              {PLATFORM_NOTES.map((p) => (
                <div
                  key={p.platform}
                  className="flex items-start gap-2 text-[10px] leading-relaxed"
                >
                  <Badge
                    variant="outline"
                    className={`mt-0.5 shrink-0 text-[9px] font-normal ${
                      p.available
                        ? "border-[#10B981]/40 bg-[#10B981]/10 text-[#10B981]"
                        : "border-[#EF4444]/40 bg-[#EF4444]/10 text-[#EF4444]"
                    }`}
                  >
                    {p.available ? "collected" : "unavailable"}
                  </Badge>
                  <div className="min-w-0">
                    <span className="font-semibold text-white">{p.platform}</span>
                    <span className="text-[#64748B]"> · {p.method}</span>
                    <p className="text-[#94A3B8]">{p.limitation}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* ── Monitors ─────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                <Radio className="size-3.5 text-[#3B82F6]" />
                Keyword monitors
              </h3>
              <p className="mt-1 text-[10px] leading-relaxed text-[#64748B]">
                Subjects filtered out of the live stream. Spikes are measured against each term's
                own rolling baseline, not a fixed threshold — 50 posts a minute is silence for one
                subject and a surge for another.
              </p>

              <div className="mt-3 flex gap-1.5">
                <Input
                  value={termDraft}
                  onChange={(e) => setTermDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMonitor()}
                  placeholder="e.g. hypersonic, IAF, Odisha"
                  className="h-7 border-[#263548] bg-[#0B1220] text-[11px] text-white"
                />
                <Button size="sm" onClick={addMonitor} className="h-7 shrink-0 px-2">
                  <Plus className="size-3" />
                </Button>
              </div>

              <div className="mt-3 space-y-2">
                {readings.length === 0 && (
                  <p className="text-[10px] text-[#64748B]">
                    No monitors defined. Add a subject above to filter the stream.
                  </p>
                )}
                {readings.map((r) => {
                  const selected = activeMonitor === r.monitor.id;
                  const spiking = r.spike.spiking;
                  return (
                    <div
                      key={r.monitor.id}
                      className={`rounded border p-2 ${
                        spiking === true
                          ? "border-[#EF4444]/50 bg-[#EF4444]/5"
                          : "border-[#263548] bg-[#0B1220]/60"
                      } ${selected ? "ring-1 ring-[#3B82F6]" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setActiveMonitor(selected ? null : r.monitor.id)}
                          className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white"
                        >
                          {r.monitor.term}
                        </button>
                        <span className="shrink-0 tabular-nums text-[10px] text-[#94A3B8]">
                          {r.matches.length} total · {r.ratePerMinute}/min
                        </span>
                        <button
                          onClick={() => removeMonitor(r.monitor.id)}
                          className="shrink-0 text-[#64748B] hover:text-[#EF4444]"
                          aria-label={`Remove monitor ${r.monitor.term}`}
                        >
                          <X className="size-3" />
                        </button>
                      </div>

                      <div className="mt-1.5">
                        <Sparkline values={r.buckets} />
                      </div>

                      <p
                        className={`mt-1 text-[9px] leading-relaxed ${
                          spiking === true ? "text-[#EF4444]" : "text-[#64748B]"
                        }`}
                      >
                        {spiking === true && <strong>SPIKE. </strong>}
                        {spiking === null && <em>No judgement yet. </em>}
                        {r.spike.reason}
                      </p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ── Server-side collectors ─────────────────────────────────────── */}
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                <Link2 className="size-3.5 text-[#8B5CF6]" />
                Pull Mastodon / Reddit / Telegram
              </h3>
              <p className="mt-1 text-[10px] leading-relaxed text-[#64748B]">
                Fetched server-side into the same buffer, so monitors and CIB analysis span every
                platform. Mastodon takes a hashtag; Reddit takes a search query; Telegram takes a
                public channel handle.
              </p>
              {redditReady === false && (
                <p className="mt-1.5 rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2 text-[10px] leading-relaxed text-[#F59E0B]">
                  Reddit is unavailable: it began refusing all unauthenticated requests with HTTP
                  403 on 2026-08-10. Register a free script app at reddit.com/prefs/apps and set
                  REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to re-enable it. Telegram and Bluesky
                  are unaffected.
                </p>
              )}
              <Input
                value={pullTarget}
                onChange={(e) => setPullTarget(e.target.value)}
                placeholder="query, or channel handle"
                className="mt-2 h-7 border-[#263548] bg-[#0B1220] text-[11px] text-white"
              />
              <div className="mt-1.5 flex gap-1.5">
                {/*
                  Disabled without credentials rather than left clickable to fail:
                  Reddit blocks all unauthenticated access as of 2026-08-10, so
                  the button could only ever produce an error.
                */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pullBusy !== null || !pullTarget.trim() || redditReady === false}
                  onClick={() => pull("reddit")}
                  title={
                    redditReady === false
                      ? "Reddit needs OAuth credentials — set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET"
                      : undefined
                  }
                  className="h-7 flex-1 text-[10px]"
                >
                  {pullBusy === "reddit" ? <Loader2 className="size-3 animate-spin" /> : "Reddit"}
                </Button>
                {/* Keyless and unrestricted — the only pull needing no credential. */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pullBusy !== null || !pullTarget.trim()}
                  onClick={() => pull("mastodon")}
                  title="Mastodon hashtag timeline (no credential required)"
                  className="h-7 flex-1 text-[10px]"
                >
                  {pullBusy === "mastodon" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    "Mastodon"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pullBusy !== null || !pullTarget.trim()}
                  onClick={() => pull("telegram")}
                  className="h-7 flex-1 text-[10px]"
                >
                  {pullBusy === "telegram" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    "Telegram"
                  )}
                </Button>
              </div>
              {pulled.length > 0 && (
                <p className="mt-1.5 text-[10px] text-[#10B981]">
                  {pulled.length} post(s) pulled into the buffer.
                </p>
              )}
              {pullError && (
                <div className="mt-2 flex items-start gap-1.5 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-1.5">
                  <AlertTriangle className="size-3 shrink-0 text-[#EF4444]" />
                  <span className="text-[9px] leading-relaxed text-[#EF4444]">{pullError}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Live feed + CIB ──────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#263548] px-4 py-2.5">
                <div>
                  <h3 className="text-xs font-bold uppercase text-white">
                    Live stream
                    {active && (
                      <span className="text-[#06B6D4]"> · filtered to "{active.monitor.term}"</span>
                    )}
                  </h3>
                  <p className="text-[9px] text-[#64748B]">
                    Showing the most recent {Math.min(feed.length, RENDER_LIMIT)} of{" "}
                    {(active ? active.matches.length : allPosts.length).toLocaleString()} buffered.
                  </p>
                </div>
                {status?.state === "open" && (
                  <span className="flex items-center gap-1 text-[9px] text-[#10B981]">
                    <Activity className="size-3 animate-pulse" /> {observedRate}/min
                  </span>
                )}
              </div>

              <div className="max-h-[420px] divide-y divide-[#263548]/40 overflow-y-auto">
                {feed.length === 0 ? (
                  <div className="p-10 text-center text-[11px] text-[#64748B]">
                    {status?.state === "open"
                      ? active
                        ? `No post matching "${active.monitor.term}" has come through yet. Monitoring runs forward from connection — Bluesky's search endpoint needs authentication, so there is no backfill.`
                        : "Connected. Waiting for the first post."
                      : "Not receiving. The feed stays empty rather than showing anything while disconnected."}
                  </div>
                ) : (
                  feed.map((p) => (
                    <div key={p.id} className="px-4 py-2.5 hover:bg-[#1A2332]/30">
                      <div className="flex items-center gap-2 text-[9px]">
                        <Badge
                          variant="secondary"
                          className="h-4 rounded-none border-[#263548] bg-[#0B1220] px-1.5 text-[8px] uppercase"
                        >
                          {p.platform}
                        </Badge>
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate font-mono text-[#3B82F6] hover:underline"
                          title={
                            p.author.startsWith("did:")
                              ? "DID — Jetstream does not carry handles; resolved on demand for flagged accounts"
                              : p.author
                          }
                        >
                          {p.author.startsWith("did:") ? `${p.author.slice(0, 24)}…` : p.author}
                        </a>
                        {p.langs.length > 0 && (
                          <span className="text-[#64748B]">{p.langs.join(", ")}</span>
                        )}
                        <span className="ml-auto shrink-0 text-[#64748B]">
                          {p.createdAt ? new Date(p.createdAt).toLocaleTimeString() : "undated"}
                        </span>
                        <PinButton
                          payload={{
                            kind: "social",
                            title: p.text.slice(0, 140),
                            source: `${p.author} (${p.platform})`,
                            url: p.url,
                            publishedAt: p.createdAt,
                            excerpt: p.text,
                            credibility: null,
                            credibilityRationale:
                              "Social post. Module 1 bypasses domain reputation for social " +
                              "sources — the platform is a host, not a publisher. Run the CIB " +
                              "panel to assess the account and its cluster.",
                            data: { platform: p.platform, langs: p.langs, links: p.links },
                          }}
                        />
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-[#F3F4F6]">
                        {p.text}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <ShieldAlert className="size-4 text-[#F59E0B]" />
                <h3 className="text-xs font-bold uppercase text-white">
                  Coordinated behaviour signals
                </h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cibBusy}
                  onClick={runCib}
                  className="ml-auto h-7 gap-1 text-[10px]"
                >
                  {cibBusy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <ShieldAlert className="size-3" />
                  )}
                  Analyse last {CIB_WINDOW}
                </Button>
              </div>

              <p className="mt-2 rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2 text-[10px] leading-relaxed text-[#F59E0B]">
                {CIB_CAVEAT}
              </p>

              {cibError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                  <span className="text-[10px] leading-relaxed text-[#EF4444]">{cibError}</span>
                </div>
              )}

              {cibClusters === null && !cibError && (
                <p className="mt-3 text-[11px] leading-relaxed text-[#64748B]">
                  Not yet run. Analysis covers the most recent {CIB_WINDOW} buffered posts —
                  clustering is quadratic, so the whole 2,000-post buffer would lock the tab. Select
                  a monitor first to analyse only its matches. Note the stream delivers roughly{" "}
                  {CIB_WINDOW} posts in well under a minute, so the temporal-synchrony signal will
                  abstain until at least {MIN_OBSERVATION_MINUTES} minutes have been collected: in a
                  window that short every post is close in time regardless of who posted it.
                </p>
              )}

              {cibClusters !== null && cibClusters.length === 0 && (
                <p className="mt-3 text-[11px] text-[#64748B]">
                  No group of two or more similar posts was found in the window. That is an absence
                  of clusters, not a finding of authenticity.
                </p>
              )}

              {cibClusters !== null && cibClusters.length > 0 && (
                <>
                  <p className="mt-3 text-[10px] text-[#64748B]">
                    {cibClusters.length} cluster(s) assessed ·{" "}
                    {cibClusters.filter((c) => c.flagged).length} above the review threshold ·{" "}
                    {profiles.length} profile(s) resolved for maturity scoring.
                  </p>
                  <div className="mt-2 space-y-2">
                    {cibClusters.slice(0, 12).map((c) => {
                      const open = openCluster === c.id;
                      return (
                        <div
                          key={c.id}
                          className={`rounded border p-2.5 ${
                            c.flagged
                              ? "border-[#EF4444]/50 bg-[#EF4444]/5"
                              : "border-[#263548] bg-[#0B1220]/60"
                          }`}
                        >
                          <button
                            onClick={() => setOpenCluster(open ? null : c.id)}
                            className="flex w-full items-center gap-2 text-left"
                          >
                            {open ? (
                              <ChevronDown className="size-3.5 shrink-0 text-[#64748B]" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-[#64748B]" />
                            )}
                            <Users className="size-3 shrink-0 text-[#94A3B8]" />
                            <span className="text-[11px] font-semibold text-white">
                              {c.accounts.length} account(s), {c.posts.length} posts
                            </span>
                            <span className="ml-auto shrink-0 font-mono text-[10px] text-[#94A3B8]">
                              {c.compositeScore === null
                                ? "unscored"
                                : `${c.compositeScore.toFixed(2)} · ${c.signalsComputed}/5 signals`}
                            </span>
                            {c.flagged && (
                              <Badge className="shrink-0 border-[#EF4444]/40 bg-[#EF4444]/10 text-[9px] font-normal text-[#EF4444]">
                                review
                              </Badge>
                            )}
                          </button>

                          <p className="mt-1 truncate pl-5 text-[10px] italic text-[#64748B]">
                            "{c.posts[0]?.text.slice(0, 140)}"
                          </p>

                          {open && (
                            <div className="mt-2 space-y-2 pl-5">
                              {c.signals.map((s) => (
                                <div
                                  key={s.id}
                                  className="rounded border border-[#263548] bg-[#111827] p-2"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-semibold text-white">
                                      {s.label}
                                    </span>
                                    <span
                                      className={`ml-auto font-mono text-[10px] ${
                                        s.score === null
                                          ? "text-[#64748B]"
                                          : s.score >= 0.6
                                            ? "text-[#EF4444]"
                                            : "text-[#10B981]"
                                      }`}
                                    >
                                      {s.score === null ? "not computed" : s.score.toFixed(2)}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-[10px] leading-relaxed text-[#94A3B8]">
                                    {s.score === null ? s.skipped : s.evidence}
                                  </p>
                                </div>
                              ))}

                              <div className="rounded border border-[#263548] bg-[#111827] p-2">
                                <div className="text-[10px] font-semibold text-white">
                                  Accounts in this cluster
                                </div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {c.posts.map((p) => (
                                    <a
                                      key={p.id}
                                      href={p.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="rounded border border-[#263548] px-1.5 py-0.5 font-mono text-[9px] text-[#3B82F6] hover:underline"
                                      title={`${p.author} at ${p.createdAt}`}
                                    >
                                      {p.author.startsWith("did:")
                                        ? `${p.author.slice(8, 20)}…`
                                        : p.author}
                                    </a>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {cibClusters.length > 12 && (
                    <p className="mt-2 text-[10px] text-[#64748B]">
                      {cibClusters.length - 12} further cluster(s) not shown; they scored below
                      those listed.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
