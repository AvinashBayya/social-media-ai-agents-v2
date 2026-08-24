import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownReport } from "@/components/markdown-report";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Youtube,
  Search,
  Loader2,
  AlertTriangle,
  Download,
  Play,
  Subtitles,
  FileText,
  Clock,
  Eye,
  User,
  Calendar,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  Languages,
  FileBarChart,
} from "lucide-react";
import {
  serverFetchYoutubeMetadata,
  serverFetchYoutubeSubtitles,
  serverDownloadYoutubeVideo,
  extractYoutubeId,
  isYoutubeUrl,
  type YoutubeMetadata,
  type YoutubeSubtitlesResponse,
  type YoutubeDownloadResponse,
  type YoutubeError,
} from "@/utils/youtube-collector";
import { llmTranslateTranscript, llmReport } from "@/utils/llm";
import { LANGUAGES } from "@/i18n/languages";

export const Route = createFileRoute("/youtube")({
  head: () => ({ meta: [{ title: "YouTube Video Intelligence — Sentinel AI" }] }),
  /**
   * `?url=` hands one video over from another module — /videos' "Related
   * YouTube Videos" panel's Analyze button is the first caller. Same
   * validation convention as /images' own `?url=` hand-off: only an absolute
   * http(s) URL is accepted, so a crafted `javascript:`/`data:` search param
   * cannot reach the fetch below.
   */
  validateSearch: (search: Record<string, unknown>): { url?: string } => {
    const raw = typeof search.url === "string" ? search.url.trim() : "";
    if (!raw) return {};
    try {
      const u = new URL(raw);
      return u.protocol === "http:" || u.protocol === "https:" ? { url: raw } : {};
    } catch {
      return {};
    }
  },
  component: YoutubePage,
});

const CARD = "bg-console-surface border-console-border";

function fmtDuration(seconds?: number): string {
  if (!seconds) return "Unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function fmtViews(count?: number): string {
  if (!count && count !== 0) return "Unknown";
  return new Intl.NumberFormat("en-US").format(count);
}

function YoutubePage() {
  const navigate = useNavigate();
  const [urlInput, setUrlInput] = useState("");
  const [activeUrl, setActiveUrl] = useState("");
  const [metadata, setMetadata] = useState<YoutubeMetadata | null>(null);
  const [subtitles, setSubtitles] = useState<YoutubeSubtitlesResponse | null>(null);
  const [selectedLang, setSelectedLang] = useState("en");
  // A video can carry both a manual and an auto-generated ("asr") track for
  // the same language code, so the code alone cannot identify which one is
  // selected — this tracks that separately rather than conflating the two.
  const [selectedIsAuto, setSelectedIsAuto] = useState(false);
  const [downloadResult, setDownloadResult] = useState<YoutubeDownloadResponse | null>(null);

  // AI translation of the page's own real, collected text (title,
  // description, transcript) — a real LLM call, never a substitute for a
  // caption track YouTube doesn't have. Separate from `subtitles` so it's
  // impossible to render a translation as if it were an official YouTube track.
  const [translateTarget, setTranslateTarget] = useState("en");
  const [translation, setTranslation] = useState<{
    text: string;
    model: string;
    targetLanguage: string;
    truncated: boolean;
  } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);

  // AI intelligence report over the real, already-collected metadata (and
  // transcript/translation, when loaded) — reuses reportOf()'s existing
  // "use ONLY the collected data below, never introduce facts absent from
  // it" prompt, the same one /reports uses for other intelligence products,
  // rather than a bespoke prompt with its own honesty guarantees to get right.
  const [report, setReport] = useState<{ text: string; model: string } | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  // Loading states
  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [fetchingSubs, setFetchingSubs] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Errors
  const [metaError, setMetaError] = useState<YoutubeError | null>(null);
  const [subsError, setSubsError] = useState<YoutubeError | null>(null);
  const [downloadError, setDownloadError] = useState<YoutubeError | null>(null);

  // UI toggle states
  const [showFullDescription, setShowFullDescription] = useState(false);
  // Click-to-load iframe — prevents browser Tracking Prevention noise on page load
  const [iframeActivated, setIframeActivated] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // 1. Fetch Metadata
  const handleFetchMetadata = async (urlOverride?: string) => {
    const raw = urlOverride ?? urlInput;
    if (!raw.trim()) return;
    setFetchingMeta(true);
    setMetaError(null);
    setMetadata(null);
    setSubtitles(null);
    setSubsError(null);
    setDownloadResult(null);
    setDownloadError(null);
    // A prior report or translation was about a *different* video — leaving
    // either on screen next to fresh metadata would misattribute it. The
    // translate result now renders independent of the metadata gate (its
    // trigger moved into the page header), so this reset matters more than
    // it used to — without it, a stale translation would stay visible
    // through the entire fetch, not just flash briefly.
    setReport(null);
    setReportError(null);
    setTranslation(null);
    setTranslationError(null);

    const targetUrl = raw.trim();
    setActiveUrl(targetUrl);
    setIframeActivated(false); // reset poster on new video

    try {
      const res = await serverFetchYoutubeMetadata({ data: { url: targetUrl } });
      if (res.success) {
        setMetadata(res.data);
        if (res.data.available_subtitles.length > 0) {
          const hasEn = res.data.available_subtitles.some((s) => s.code === "en");
          if (!hasEn) {
            const first = res.data.available_subtitles[0];
            setSelectedLang(first.code);
            setSelectedIsAuto(first.isAuto);
          } else {
            // Prefer the manual "en" track over an auto-generated one of the
            // same code, if both exist — matching the old code's incidental
            // behavior (tracks.find always returned the first match, which
            // YouTube lists manual-before-auto), now made deliberate.
            const manualEn = res.data.available_subtitles.find(
              (s) => s.code === "en" && !s.isAuto,
            );
            const anyEn = manualEn ?? res.data.available_subtitles.find((s) => s.code === "en");
            setSelectedIsAuto(anyEn?.isAuto ?? false);
          }
        }
      } else {
        setMetaError({ error: res.error, cause: res.cause });
      }
    } catch (err: any) {
      setMetaError({ error: "MetadataError", cause: err?.message || String(err) });
    } finally {
      setFetchingMeta(false);
    }
  };

  // Hand-off from another module via ?url= (/videos' "Related YouTube
  // Videos" panel). Runs once per distinct URL — matching /images' own
  // ?url= hand-off — so a re-render cannot re-trigger a fetch of the same video.
  const handoffUrl = Route.useSearch().url;
  const handledHandoffRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoffUrl || handledHandoffRef.current === handoffUrl) return;
    handledHandoffRef.current = handoffUrl;
    setUrlInput(handoffUrl);
    void handleFetchMetadata(handoffUrl);
    // handleFetchMetadata is a stable-enough closure; depending on it would
    // re-run this on every one of its identity changes rather than on a new URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffUrl]);

  // 2. Fetch Subtitles
  const handleFetchSubtitles = async (langToFetch?: string, isAutoToFetch?: boolean) => {
    if (!activeUrl) return;
    const lang = langToFetch || selectedLang;
    const isAuto = langToFetch === undefined ? selectedIsAuto : (isAutoToFetch ?? false);
    setFetchingSubs(true);
    setSubsError(null);
    // A prior translation was of a *different* transcript (or the same one,
    // now being reloaded) — stale AI output left on screen next to a fresh
    // transcript would misattribute one for the other.
    setTranslation(null);
    setTranslationError(null);

    try {
      const res = await serverFetchYoutubeSubtitles({ data: { url: activeUrl, lang, isAuto } });
      if (res.success) {
        setSubtitles(res.data);
      } else {
        setSubsError({ error: res.error, cause: res.cause });
        setSubtitles(null);
      }
    } catch (err: any) {
      setSubsError({ error: "SubtitlesError", cause: err?.message || String(err) });
      setSubtitles(null);
    } finally {
      setFetchingSubs(false);
    }
  };

  // AI translation of the page's own real, already-collected text — title,
  // description, and the transcript when one is loaded. Real LLM call over
  // real content only; never offered before metadata exists, and never
  // rendered anywhere without an explicit AI-translation label (see the JSX
  // below) so it can't be mistaken for something YouTube itself supplied.
  const handleTranslate = async () => {
    if (!metadata) return;
    setTranslating(true);
    setTranslationError(null);
    setTranslation(null);

    const targetMeta = LANGUAGES.find((l) => l.code === translateTarget);
    const targetLabel = targetMeta ? `${targetMeta.label} (${targetMeta.native})` : translateTarget;
    // Only English, among the 16 languages this selector offers, uses Latin
    // script — the other 15 are all scheduled Indian languages in their own
    // native scripts (see src/i18n/languages.ts). llm.ts uses this to verify
    // the model actually switched languages rather than staying in the
    // source's script.
    const targetIsLatinScript = translateTarget === "en";

    const parts = [`Title: ${metadata.title}`];
    if (metadata.description?.trim()) parts.push(`Description:\n${metadata.description.trim()}`);
    if (subtitles && subtitles.segments.length > 0) {
      parts.push(`Transcript:\n${subtitles.segments.map((s) => s.text).join(" ")}`);
    }
    const fullText = parts.join("\n\n");

    try {
      const res = await llmTranslateTranscript({
        data: { text: fullText, targetLanguage: targetLabel, targetIsLatinScript },
      });
      setTranslation({
        text: res.text,
        model: res.model,
        targetLanguage: targetLabel,
        truncated: res.truncated,
      });
    } catch (err: any) {
      setTranslationError(err?.message ?? String(err));
    } finally {
      setTranslating(false);
    }
  };

  // AI intelligence report — synthesizes whatever real data is currently on
  // screen (metadata always; transcript and its translation only if the
  // analyst loaded them) into a structured brief. Available as soon as
  // metadata exists; sections the loaded data can't support come back
  // honestly labeled "No supporting data collected" by reportOf()'s own
  // prompt, not silently invented.
  const handleGenerateReport = async () => {
    if (!metadata) return;
    setGeneratingReport(true);
    setReportError(null);
    setReport(null);

    const MAX_REPORT_TRANSCRIPT_CHARS = 6000;
    const parts: string[] = [
      `Title: ${metadata.title}`,
      `Channel: ${metadata.uploader}`,
      `Upload date: ${metadata.upload_date || "not reported"}`,
      `Duration: ${fmtDuration(metadata.duration)}`,
      `Views: ${fmtViews(metadata.view_count)}`,
      `URL: ${metadata.webpage_url}`,
    ];
    if (metadata.description?.trim()) {
      parts.push(`Description:\n${metadata.description.trim()}`);
    }
    if (subtitles && subtitles.segments.length > 0) {
      const full = subtitles.segments.map((s) => s.text).join(" ");
      const clipped = full.length > MAX_REPORT_TRANSCRIPT_CHARS;
      parts.push(
        `Transcript (${subtitles.lang}${subtitles.isAuto ? ", auto-generated" : ", manual"}` +
          `${clipped ? ", truncated to the first " + MAX_REPORT_TRANSCRIPT_CHARS + " characters" : ""}):\n` +
          (clipped ? full.slice(0, MAX_REPORT_TRANSCRIPT_CHARS) : full),
      );
    }
    if (translation) {
      const clipped = translation.text.length > MAX_REPORT_TRANSCRIPT_CHARS;
      parts.push(
        `AI translation to ${translation.targetLanguage} of the transcript above (machine ` +
          `translation, not independently verified${clipped ? ", truncated" : ""}):\n` +
          (clipped ? translation.text.slice(0, MAX_REPORT_TRANSCRIPT_CHARS) : translation.text),
      );
    }

    try {
      const res = await llmReport({
        data: { type: "YouTube Video Intelligence", target: metadata.title, data: parts.join("\n\n") },
      });
      setReport({ text: res.text, model: res.model });
    } catch (err: any) {
      setReportError(err?.message ?? String(err));
    } finally {
      setGeneratingReport(false);
    }
  };

  // 3. Analyst-Initiated Download
  const handleDownload = async () => {
    if (!activeUrl) return;
    setDownloading(true);
    setDownloadError(null);

    try {
      const res = await serverDownloadYoutubeVideo({ data: { url: activeUrl, quality: "720p" } });
      if (res.success) {
        setDownloadResult(res.data);
        const anchor = document.createElement("a");
        anchor.href = res.data.directUrl;
        anchor.download = `${res.data.id}_720p.mp4`;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      } else {
        setDownloadError({ error: res.error, cause: res.cause });
      }
    } catch (err: any) {
      setDownloadError({ error: "DownloadError", cause: err?.message || String(err) });
    } finally {
      setDownloading(false);
    }
  };

  // Seek iframe player to segment timestamp
  const seekToSegment = (seconds: number) => {
    if (iframeRef.current && metadata?.id) {
      iframeRef.current.src = `https://www.youtube-nocookie.com/embed/${metadata.id}?autoplay=1&start=${Math.floor(seconds)}`;
    }
  };

  const videoId = metadata ? metadata.id : extractYoutubeId(urlInput);

  return (
    <AppShell>
      <PageHeader
        title="YouTube Video Intelligence"
        description="Analyst ingestion tool for YouTube video metadata, timestamped subtitle transcripts, and forensic video artifact downloads."
        actions={
          metadata ? (
            <div className="flex items-center gap-2">
              <Select value={translateTarget} onValueChange={setTranslateTarget}>
                <SelectTrigger className="h-8 w-40 border-console-border bg-console-deep font-mono text-[10px] text-console-text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64 border-console-border bg-console-surface font-mono text-[10px] text-console-text">
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.label} ({l.native})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleTranslate()}
                disabled={translating}
                className="h-8 gap-1.5 font-mono text-[10px]"
                title={`Translate this video's title and description${
                  subtitles && subtitles.segments.length > 0 ? ", and the loaded transcript," : ""
                } into the selected language`}
              >
                {translating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Languages className="size-3.5" />
                )}
                Translate Page
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="space-y-6 p-6 font-mono text-xs text-console-text">
        {/* AI translation result/error — the trigger controls live in the page
            header, beside the title (on request); this is just where the
            output lands once requested. */}
        {(translation || translationError) && (
          <Card className={`${CARD} border-console-purple/40 p-4`}>
            {translationError && (
              <div className="flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                <span className="text-[10px] leading-relaxed text-console-red">
                  Translation unavailable: {translationError}
                </span>
              </div>
            )}
            {translation && (
              <div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Languages className="size-3.5 shrink-0 text-console-purple" />
                  <Badge className="border-console-purple/40 bg-console-purple/10 text-[9px] uppercase text-console-purple">
                    AI translation · {translation.model}
                  </Badge>
                  <span className="font-mono text-[9px] text-console-label">
                    Not an official YouTube caption — machine-translated to {translation.targetLanguage}
                    . Verify before treating as evidence.
                  </span>
                </div>
                {translation.truncated && (
                  <p className="mt-1.5 text-[9px] text-console-amber">
                    Source text was long and was truncated before translation — this covers the
                    beginning only.
                  </p>
                )}
                <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-console-text">
                  {translation.text}
                </p>
              </div>
            )}
          </Card>
        )}

        {/* Input Bar */}
        <Card className={`${CARD} p-4`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Youtube className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-console-red" />
              <Input
                placeholder="Paste YouTube Video URL (e.g. https://www.youtube.com/watch?v=...)"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleFetchMetadata()}
                className="h-10 border-console-border bg-console-deep pl-10 pr-4 font-mono text-xs text-console-text placeholder:text-console-label focus-visible:ring-console-cyan"
              />
            </div>
            <Button
              onClick={() => handleFetchMetadata()}
              disabled={fetchingMeta || !urlInput.trim()}
              className="h-10 rounded bg-console-cyan px-5 font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-cyan/90"
            >
              {fetchingMeta ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Search className="mr-2 size-4" />
              )}
              Fetch Metadata
            </Button>
          </div>
          <p className="mt-2 text-[10px] text-console-label">
            Supports standard watch URLs and shortlinks (youtube.com/watch?v=..., youtu.be/...).
            Single-video analyst initiated actions only.
          </p>
        </Card>

        {/* Error Banner: Video Unavailable */}
        {metaError && (
          <div className="flex items-start gap-3 rounded border border-console-red/40 bg-console-red/10 p-4">
            <AlertTriangle className="size-5 shrink-0 text-console-red" />
            <div>
              <h4 className="font-bold text-console-red">
                {metaError.error === "VideoUnavailable"
                  ? "Video Unavailable"
                  : "Metadata Extraction Error"}
              </h4>
              <p className="mt-1 text-[11px] leading-relaxed text-[#FCA5A5]">{metaError.cause}</p>
            </div>
          </div>
        )}

        {/* Active Analysis View */}
        {metadata && (
          <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left Column: Embed Player & Metadata (7 cols) */}
            <div className="space-y-6 lg:col-span-7">
              {/* Embed Player — click-to-load to avoid Edge Tracking Prevention noise */}
              <Card className={`${CARD} overflow-hidden p-0`}>
                <div className="relative aspect-video w-full bg-black">
                  {iframeActivated ? (
                    <iframe
                      ref={iframeRef}
                      title={metadata.title}
                      src={`https://www.youtube-nocookie.com/embed/${metadata.id}?autoplay=1&rel=0`}
                      className="size-full border-0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      referrerPolicy="strict-origin-when-cross-origin"
                    />
                  ) : (
                    /* Poster — click activates the iframe, no cross-origin storage touched until user opts in */
                    <button
                      type="button"
                      aria-label="Play video"
                      onClick={() => setIframeActivated(true)}
                      className="group relative size-full flex items-center justify-center bg-black cursor-pointer"
                    >
                      <img
                        src={`https://i.ytimg.com/vi/${metadata.id}/maxresdefault.jpg`}
                        onError={(e) => {
                          (e.target as HTMLImageElement).src =
                            `https://i.ytimg.com/vi/${metadata.id}/hqdefault.jpg`;
                        }}
                        alt={metadata.title}
                        className="size-full object-cover opacity-80 group-hover:opacity-60 transition-opacity duration-200"
                      />
                      <span className="absolute flex size-16 items-center justify-center rounded-full bg-console-red/90 shadow-lg ring-2 ring-white/20 transition-transform duration-200 group-hover:scale-110">
                        <Play className="ml-1 size-7 text-white fill-white" />
                      </span>
                      <span className="absolute bottom-3 left-3 rounded bg-black/70 px-2 py-0.5 text-[10px] font-mono text-console-cyan backdrop-blur-sm">
                        Click to load player
                      </span>
                    </button>
                  )}
                </div>
                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge className="border-console-cyan/30 bg-console-cyan/10 text-console-cyan text-[9px] uppercase">
                      Privacy-Enhanced Embed (youtube-nocookie.com)
                    </Badge>
                    <span className="text-[10px] text-console-label">Video ID: {metadata.id}</span>
                  </div>
                  <h2 className="text-sm font-bold leading-tight text-console-text">
                    {metadata.title}
                  </h2>
                </div>
              </Card>

              {/* Metadata Panel */}
              <Card className={`${CARD} p-4 space-y-4`}>
                <div className="border-b border-console-border pb-3 flex items-center justify-between">
                  <h3 className="font-bold uppercase text-console-text flex items-center gap-2">
                    <FileText className="size-4 text-console-cyan" /> Video Metadata
                  </h3>
                  {/* Names the source that actually answered. This asserted
                      "Verified ytdl-core" for anything that was not oEmbed,
                      which would now mislabel every InnerTube record — and it
                      called a record "verified" on the strength of which code
                      path produced it. */}
                  <Badge
                    className={
                      metadata.provenance.model === "yt-oembed-fallback"
                        ? "bg-console-amber/10 text-console-amber border-console-amber/30 text-[9px]"
                        : "bg-console-green/10 text-console-green border-console-green/30 text-[9px]"
                    }
                    title={`Metadata source: ${metadata.provenance.model}`}
                  >
                    {metadata.provenance.model === "yt-oembed-fallback"
                      ? "oEmbed — title and channel only"
                      : metadata.provenance.model.startsWith("innertube")
                        ? `InnerTube ${metadata.provenance.model.replace("innertube-", "").toUpperCase()}`
                        : metadata.provenance.model}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-3 text-[11px] md:grid-cols-4">
                  <div className="bg-console-deep border border-console-border p-2.5 rounded">
                    <span className="text-console-label flex items-center gap-1 text-[9px] uppercase">
                      <User className="size-3 text-console-cyan" /> Channel
                    </span>
                    <span className="font-bold text-console-text truncate block mt-0.5">
                      {metadata.uploader}
                    </span>
                  </div>
                  <div className="bg-console-deep border border-console-border p-2.5 rounded">
                    <span className="text-console-label flex items-center gap-1 text-[9px] uppercase">
                      <Calendar className="size-3 text-console-cyan" /> Upload Date
                    </span>
                    <span className="font-bold text-console-text block mt-0.5">
                      {metadata.upload_date || "Unknown"}
                    </span>
                  </div>
                  <div className="bg-console-deep border border-console-border p-2.5 rounded">
                    <span className="text-console-label flex items-center gap-1 text-[9px] uppercase">
                      <Clock className="size-3 text-console-cyan" /> Duration
                    </span>
                    <span className="font-bold text-console-text block mt-0.5">
                      {fmtDuration(metadata.duration)}
                    </span>
                  </div>
                  <div className="bg-console-deep border border-console-border p-2.5 rounded">
                    <span className="text-console-label flex items-center gap-1 text-[9px] uppercase">
                      <Eye className="size-3 text-console-cyan" /> Views
                    </span>
                    <span className="font-bold text-console-text block mt-0.5">
                      {fmtViews(metadata.view_count)}
                    </span>
                  </div>
                </div>

                {/* Description */}
                {metadata.description && (
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold text-console-muted">
                      Description
                    </span>
                    <div className="rounded border border-console-border bg-console-deep p-3 text-[11px] leading-relaxed text-console-muted">
                      <p className={showFullDescription ? "" : "line-clamp-4"}>
                        {metadata.description}
                      </p>
                      {metadata.description.length > 200 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowFullDescription(!showFullDescription)}
                          className="mt-2 h-6 px-2 text-[10px] text-console-cyan hover:bg-console-cyan/10"
                        >
                          {showFullDescription ? (
                            <>
                              <ChevronUp className="mr-1 size-3" /> Show Less
                            </>
                          ) : (
                            <>
                              <ChevronDown className="mr-1 size-3" /> Show Full Description
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </Card>

              {/* Analyst Download Action Panel */}
              <Card className={`${CARD} p-4 space-y-3`}>
                <div className="flex items-center justify-between border-b border-console-border pb-2">
                  <h3 className="font-bold uppercase text-console-text flex items-center gap-2">
                    <Download className="size-4 text-console-amber" /> Video Artifact Download
                  </h3>
                  <Badge className="bg-console-amber/10 text-console-amber border-console-amber/30 text-[9px] uppercase">
                    Analyst Initiated
                  </Badge>
                </div>
                <p className="text-[10px] text-console-label">
                  {/* Said "(720p)". The runtime has no ffmpeg, so only YouTube's
                      muxed format is downloadable as a single file — that is
                      itag 18 at 360p. Higher resolutions exist only as separate
                      video and audio streams. */}
                  Download the muxed MP4 artifact (360p — the highest single-file format YouTube
                  serves; higher resolutions are adaptive and need ffmpeg to join) to your own disk,
                  then open it on the Video Analysis page for in-browser keyframe extraction,
                  scene-cut detection and OCR. There is no audio transcription: Whisper is not
                  deployed. No download is recorded either — nothing in this system keeps an audit
                  trail, and the file transfers straight from YouTube to your browser.
                </p>

                {downloadError &&
                  (() => {
                    // Sniffs YouTube's OWN playability verdict, which the collector
                    // now passes through verbatim. It used to match on
                    // "age-restricted"/"region-locked" — words the collector wrote
                    // into every failure cause as a guess, so the amber
                    // "Restricted" banner fired on faults that were nothing of the
                    // sort, including our own parser and transport errors.
                    const c = downloadError.cause ?? "";
                    const isBlocked =
                      /LOGIN_REQUIRED|AGE_VERIFICATION|UNPLAYABLE|CONTENT_CHECK_REQUIRED/i.test(c);
                    return (
                      <div
                        className={`rounded border p-3 text-xs space-y-1 ${
                          isBlocked
                            ? "border-console-amber/30 bg-console-amber/5 text-console-amber"
                            : "border-console-red/30 bg-console-red/10 text-console-red"
                        }`}
                      >
                        <span className="font-bold">
                          {isBlocked ? "Download Restricted by YouTube: " : "Download Failed: "}
                        </span>
                        {downloadError.cause}
                      </div>
                    );
                  })()}

                {downloadResult ? (
                  <div className="space-y-3 rounded border border-console-green/30 bg-console-green/10 p-3">
                    <div className="flex items-center gap-2 text-console-green font-bold">
                      <CheckCircle2 className="size-4" /> Direct Download URL Retrieved
                    </div>
                    <div className="text-[10px] text-console-muted space-y-1 font-mono break-all">
                      <div>
                        <span className="text-console-label">Format: </span>
                        {downloadResult.format}
                      </div>
                      {downloadResult.filesize && (
                        <div>
                          <span className="text-console-label">Size: </span>
                          {(downloadResult.filesize / 1024 / 1024).toFixed(1)} MB
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => {
                          const anchor = document.createElement("a");
                          anchor.href = downloadResult.directUrl;
                          anchor.download = `${downloadResult.id}_720p.mp4`;
                          anchor.target = "_blank";
                          anchor.rel = "noopener noreferrer";
                          document.body.appendChild(anchor);
                          anchor.click();
                          document.body.removeChild(anchor);
                        }}
                        className="h-8 flex-1 rounded bg-console-green px-3 text-[10px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-green/90"
                      >
                        <Download className="mr-1 size-3" /> Save MP4 to Disk
                      </Button>
                      <Button
                        onClick={() => navigate({ to: "/videos" })}
                        className="h-8 rounded bg-console-border px-3 text-[10px] font-bold uppercase tracking-wider text-console-text hover:bg-console-border/90"
                      >
                        Run Analysis →
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    onClick={handleDownload}
                    disabled={downloading}
                    className="h-9 w-full rounded bg-console-amber font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-amber/90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {downloading ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 size-4" />
                    )}
                    Download MP4 Artifact for Forensic Analysis
                  </Button>
                )}
              </Card>
            </div>

            {/* Right Column: Subtitles Viewer (5 cols) */}
            <div className="space-y-6 lg:col-span-5">
              <Card className={`${CARD} p-4 space-y-4`}>
                <div className="border-b border-console-border pb-3 flex items-center justify-between">
                  <h3 className="font-bold uppercase text-console-text flex items-center gap-2">
                    <Subtitles className="size-4 text-console-cyan" /> Subtitles & Transcripts
                  </h3>
                  {subtitles && (
                    <Badge
                      className={`text-[9px] uppercase border ${subtitles.isAuto ? "bg-console-purple/10 text-console-purple border-console-purple/30" : "bg-console-green/10 text-console-green border-console-green/30"}`}
                    >
                      {subtitles.isAuto ? "Auto Captions" : "Manual Subtitles"}
                    </Badge>
                  )}
                </div>

                {/* Subtitle controls */}
                <div className="flex items-center gap-2">
                  <Select
                    // A video can offer both a manual and an auto-generated
                    // track for the same language code, so the code alone
                    // cannot be a unique React/Select key or identify which
                    // variant is selected — this composite key carries both.
                    value={`${selectedLang}::${selectedIsAuto ? "auto" : "manual"}`}
                    onValueChange={(val) => {
                      const sep = val.lastIndexOf("::");
                      const code = val.slice(0, sep);
                      const isAuto = val.slice(sep + 2) === "auto";
                      setSelectedLang(code);
                      setSelectedIsAuto(isAuto);
                      handleFetchSubtitles(code, isAuto);
                    }}
                  >
                    <SelectTrigger className="h-8 border-console-border bg-console-deep font-mono text-xs text-console-text">
                      <SelectValue placeholder="Select Language" />
                    </SelectTrigger>
                    <SelectContent className="bg-console-surface border-console-border font-mono text-xs text-console-text">
                      {metadata.available_subtitles.length > 0 ? (
                        metadata.available_subtitles.map((s) => (
                          <SelectItem
                            key={`${s.code}::${s.isAuto ? "auto" : "manual"}`}
                            value={`${s.code}::${s.isAuto ? "auto" : "manual"}`}
                          >
                            {s.name} ({s.code}) {s.isAuto ? "[Auto]" : "[Manual]"}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="en::manual">English (en)</SelectItem>
                      )}
                    </SelectContent>
                  </Select>

                  <Button
                    size="sm"
                    onClick={() => handleFetchSubtitles()}
                    disabled={fetchingSubs}
                    className="h-8 rounded bg-console-cyan px-3 text-[10px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-cyan/90"
                  >
                    {fetchingSubs ? <Loader2 className="size-3 animate-spin" /> : "Load"}
                  </Button>
                </div>

                {/* Subtitle Error Banner */}
                {subsError && (
                  <div className="rounded border border-console-red/30 bg-console-red/10 p-3 text-[11px] text-console-red">
                    <span className="font-bold">Subtitles Unavailable: </span>
                    {subsError.cause}
                    <p className="mt-2 text-[10px] text-console-label">
                      No captions were returned, and there is no fallback: audio transcription is
                      not implemented — Whisper needs GPU inference this system does not have. You
                      can still download the artifact above and run keyframe extraction, scene-cut
                      detection and OCR on the Video Analysis page.
                    </p>
                  </div>
                )}

                {/* Subtitle Segments List */}
                {subtitles && (
                  <div className="max-h-[500px] overflow-y-auto space-y-2 pr-1 font-mono text-xs">
                    {subtitles.segments.map((seg, idx) => (
                      <div
                        key={idx}
                        onClick={() => seekToSegment(seg.start)}
                        className="group flex items-start gap-3 rounded border border-console-border bg-console-deep p-2.5 hover:border-console-cyan hover:bg-console-elevated cursor-pointer transition-colors"
                      >
                        <span className="shrink-0 rounded bg-console-cyan/10 px-1.5 py-0.5 text-[10px] font-bold text-console-cyan group-hover:bg-console-cyan group-hover:text-console-accent-foreground">
                          {fmtDuration(seg.start)}
                        </span>
                        <p className="text-[11px] leading-relaxed text-console-muted group-hover:text-console-text">
                          {seg.text}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {!subtitles && !subsError && !fetchingSubs && (
                  <div className="py-8 text-center text-console-label">
                    Select language and click Load to view timestamped subtitle transcript.
                  </div>
                )}
              </Card>
            </div>
          </div>

          {/* AI intelligence report — full width, below both columns, since it
              synthesizes metadata from the left column with the transcript
              from the right one. Available once metadata exists; the
              transcript and its translation are optional inputs, included
              automatically when loaded. */}
          <Card className={`${CARD} mt-6 p-4 space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-console-border pb-3">
              <h3 className="flex items-center gap-2 font-bold uppercase text-console-text">
                <FileBarChart className="size-4 text-console-cyan" /> AI Intelligence Report
              </h3>
              <Button
                onClick={() => void handleGenerateReport()}
                disabled={generatingReport}
                className="h-7 rounded bg-console-cyan px-3 text-[10px] font-bold uppercase text-console-accent-foreground hover:bg-console-cyan/90"
              >
                {generatingReport ? (
                  <Loader2 className="mr-1.5 size-3 animate-spin" />
                ) : (
                  <FileBarChart className="mr-1.5 size-3" />
                )}
                Generate Report
              </Button>
            </div>

            <p className="text-[10px] leading-relaxed text-console-label">
              Synthesizes the title, channel, upload date, duration, view count, description
              {subtitles && subtitles.segments.length > 0 ? ", the loaded transcript" : ""}
              {translation ? ", and its AI translation" : ""} above into a structured brief. Uses
              only the collected data shown on this page — where a section isn't supported by it,
              the report says so rather than inventing anything.
              {!subtitles && " Load a transcript above first for a fuller report."}
            </p>

            {reportError && (
              <div className="flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                <span className="text-[11px] leading-relaxed text-console-red">
                  Report unavailable: {reportError}
                </span>
              </div>
            )}

            {report && (
              <div className="rounded border border-console-cyan/30 bg-console-cyan/5 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge className="border-console-cyan/40 bg-console-cyan/10 text-[9px] uppercase text-console-cyan">
                    AI-generated · {report.model}
                  </Badge>
                  <span className="font-mono text-[9px] text-console-label">
                    Not verified — an analyst-review starting point, not a finding.
                  </span>
                </div>
                <MarkdownReport text={report.text} className="mt-2 text-[12px] text-console-text" />
              </div>
            )}

            {!report && !reportError && !generatingReport && (
              <div className="py-6 text-center text-[10px] text-console-label">
                Click Generate Report to compile the data above into a brief.
              </div>
            )}
          </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
