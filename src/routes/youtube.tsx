import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

export const Route = createFileRoute("/youtube")({
  head: () => ({ meta: [{ title: "YouTube Video Intelligence — Sentinel AI" }] }),
  component: YoutubePage,
});

const CARD = "bg-[#111827] border-[#263548]";

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
  const [downloadResult, setDownloadResult] = useState<YoutubeDownloadResponse | null>(null);

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
  const handleFetchMetadata = async () => {
    if (!urlInput.trim()) return;
    setFetchingMeta(true);
    setMetaError(null);
    setMetadata(null);
    setSubtitles(null);
    setSubsError(null);
    setDownloadResult(null);
    setDownloadError(null);

    const targetUrl = urlInput.trim();
    setActiveUrl(targetUrl);
    setIframeActivated(false); // reset poster on new video

    try {
      const res = await serverFetchYoutubeMetadata({ data: { url: targetUrl } });
      if (res.success) {
        setMetadata(res.data);
        if (res.data.available_subtitles.length > 0) {
          const hasEn = res.data.available_subtitles.some((s) => s.code === "en");
          if (!hasEn) {
            setSelectedLang(res.data.available_subtitles[0].code);
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

  // 2. Fetch Subtitles
  const handleFetchSubtitles = async (langToFetch?: string) => {
    if (!activeUrl) return;
    const lang = langToFetch || selectedLang;
    setFetchingSubs(true);
    setSubsError(null);

    try {
      const res = await serverFetchYoutubeSubtitles({ data: { url: activeUrl, lang } });
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
      />

      <div className="space-y-6 p-6 font-mono text-xs text-[#F3F4F6]">
        {/* Input Bar */}
        <Card className={`${CARD} p-4`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Youtube className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#EF4444]" />
              <Input
                placeholder="Paste YouTube Video URL (e.g. https://www.youtube.com/watch?v=...)"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleFetchMetadata()}
                className="h-10 border-[#263548] bg-[#0B1220] pl-10 pr-4 font-mono text-xs text-[#F3F4F6] placeholder:text-[#64748B] focus-visible:ring-[#06B6D4]"
              />
            </div>
            <Button
              onClick={handleFetchMetadata}
              disabled={fetchingMeta || !urlInput.trim()}
              className="h-10 rounded bg-[#06B6D4] px-5 font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#06B6D4]/90"
            >
              {fetchingMeta ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Search className="mr-2 size-4" />
              )}
              Fetch Metadata
            </Button>
          </div>
          <p className="mt-2 text-[10px] text-[#64748B]">
            Supports standard watch URLs and shortlinks (youtube.com/watch?v=..., youtu.be/...). Single-video analyst initiated actions only.
          </p>
        </Card>

        {/* Error Banner: Video Unavailable */}
        {metaError && (
          <div className="flex items-start gap-3 rounded border border-[#EF4444]/40 bg-[#EF4444]/10 p-4">
            <AlertTriangle className="size-5 shrink-0 text-[#EF4444]" />
            <div>
              <h4 className="font-bold text-[#EF4444]">
                {metaError.error === "VideoUnavailable" ? "Video Unavailable" : "Metadata Extraction Error"}
              </h4>
              <p className="mt-1 text-[11px] leading-relaxed text-[#FCA5A5]">
                {metaError.cause}
              </p>
            </div>
          </div>
        )}

        {/* Active Analysis View */}
        {metadata && (
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
                        onError={(e) => { (e.target as HTMLImageElement).src = `https://i.ytimg.com/vi/${metadata.id}/hqdefault.jpg`; }}
                        alt={metadata.title}
                        className="size-full object-cover opacity-80 group-hover:opacity-60 transition-opacity duration-200"
                      />
                      <span className="absolute flex size-16 items-center justify-center rounded-full bg-[#EF4444]/90 shadow-lg ring-2 ring-white/20 transition-transform duration-200 group-hover:scale-110">
                        <Play className="ml-1 size-7 text-white fill-white" />
                      </span>
                      <span className="absolute bottom-3 left-3 rounded bg-black/70 px-2 py-0.5 text-[10px] font-mono text-[#06B6D4] backdrop-blur-sm">
                        Click to load player
                      </span>
                    </button>
                  )}
                </div>
                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge className="border-[#06B6D4]/30 bg-[#06B6D4]/10 text-[#06B6D4] text-[9px] uppercase">
                      Privacy-Enhanced Embed (youtube-nocookie.com)
                    </Badge>
                    <span className="text-[10px] text-[#64748B]">
                      Video ID: {metadata.id}
                    </span>
                  </div>
                  <h2 className="text-sm font-bold leading-tight text-[#F3F4F6]">
                    {metadata.title}
                  </h2>
                </div>
              </Card>

              {/* Metadata Panel */}
              <Card className={`${CARD} p-4 space-y-4`}>
                <div className="border-b border-[#263548] pb-3 flex items-center justify-between">
                  <h3 className="font-bold uppercase text-[#F3F4F6] flex items-center gap-2">
                    <FileText className="size-4 text-[#06B6D4]" /> Video Metadata
                  </h3>
                  {/* Names the source that actually answered. This asserted
                      "Verified ytdl-core" for anything that was not oEmbed,
                      which would now mislabel every InnerTube record — and it
                      called a record "verified" on the strength of which code
                      path produced it. */}
                  <Badge
                    className={
                      metadata.provenance.model === "yt-oembed-fallback"
                        ? "bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30 text-[9px]"
                        : "bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 text-[9px]"
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
                  <div className="bg-[#0B1220] border border-[#263548] p-2.5 rounded">
                    <span className="text-[#64748B] flex items-center gap-1 text-[9px] uppercase">
                      <User className="size-3 text-[#06B6D4]" /> Channel
                    </span>
                    <span className="font-bold text-[#F3F4F6] truncate block mt-0.5">
                      {metadata.uploader}
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-[#263548] p-2.5 rounded">
                    <span className="text-[#64748B] flex items-center gap-1 text-[9px] uppercase">
                      <Calendar className="size-3 text-[#06B6D4]" /> Upload Date
                    </span>
                    <span className="font-bold text-[#F3F4F6] block mt-0.5">
                      {metadata.upload_date || "Unknown"}
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-[#263548] p-2.5 rounded">
                    <span className="text-[#64748B] flex items-center gap-1 text-[9px] uppercase">
                      <Clock className="size-3 text-[#06B6D4]" /> Duration
                    </span>
                    <span className="font-bold text-[#F3F4F6] block mt-0.5">
                      {fmtDuration(metadata.duration)}
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-[#263548] p-2.5 rounded">
                    <span className="text-[#64748B] flex items-center gap-1 text-[9px] uppercase">
                      <Eye className="size-3 text-[#06B6D4]" /> Views
                    </span>
                    <span className="font-bold text-[#F3F4F6] block mt-0.5">
                      {fmtViews(metadata.view_count)}
                    </span>
                  </div>
                </div>

                {/* Description */}
                {metadata.description && (
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold text-[#94A3B8]">Description</span>
                    <div className="rounded border border-[#263548] bg-[#0B1220] p-3 text-[11px] leading-relaxed text-[#94A3B8]">
                      <p className={showFullDescription ? "" : "line-clamp-4"}>
                        {metadata.description}
                      </p>
                      {metadata.description.length > 200 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowFullDescription(!showFullDescription)}
                          className="mt-2 h-6 px-2 text-[10px] text-[#06B6D4] hover:bg-[#06B6D4]/10"
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
                <div className="flex items-center justify-between border-b border-[#263548] pb-2">
                  <h3 className="font-bold uppercase text-[#F3F4F6] flex items-center gap-2">
                    <Download className="size-4 text-[#F59E0B]" /> Video Artifact Download
                  </h3>
                  <Badge className="bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30 text-[9px] uppercase">
                    Analyst Initiated
                  </Badge>
                </div>
                <p className="text-[10px] text-[#64748B]">
                  {/* Said "(720p)". The runtime has no ffmpeg, so only YouTube's
                      muxed format is downloadable as a single file — that is
                      itag 18 at 360p. Higher resolutions exist only as separate
                      video and audio streams. */}
                  Download the muxed MP4 artifact (360p — the highest single-file format YouTube
                  serves; higher resolutions are adaptive and need ffmpeg to join) into local
                  storage for keyframe extraction, OCR, and Whisper audio analysis. Each download is
                  audit logged.
                </p>

                {downloadError && (() => {
                  // Sniffs YouTube's OWN playability verdict, which the collector
                  // now passes through verbatim. It used to match on
                  // "age-restricted"/"region-locked" — words the collector wrote
                  // into every failure cause as a guess, so the amber
                  // "Restricted" banner fired on faults that were nothing of the
                  // sort, including our own parser and transport errors.
                  const c = downloadError.cause ?? "";
                  const isBlocked = /LOGIN_REQUIRED|AGE_VERIFICATION|UNPLAYABLE|CONTENT_CHECK_REQUIRED/i.test(c);
                  return (
                    <div className={`rounded border p-3 text-xs space-y-1 ${
                      isBlocked
                        ? "border-[#F59E0B]/30 bg-[#F59E0B]/5 text-[#F59E0B]"
                        : "border-[#EF4444]/30 bg-[#EF4444]/10 text-[#EF4444]"
                    }`}>
                      <span className="font-bold">{isBlocked ? "Download Restricted by YouTube: " : "Download Failed: "}</span>
                      {downloadError.cause}
                    </div>
                  );
                })()}

                {downloadResult ? (
                  <div className="space-y-3 rounded border border-[#10B981]/30 bg-[#10B981]/10 p-3">
                    <div className="flex items-center gap-2 text-[#10B981] font-bold">
                      <CheckCircle2 className="size-4" /> Direct Download URL Retrieved
                    </div>
                    <div className="text-[10px] text-[#94A3B8] space-y-1 font-mono break-all">
                      <div><span className="text-[#64748B]">Format: </span>{downloadResult.format}</div>
                      {downloadResult.filesize && (
                        <div><span className="text-[#64748B]">Size: </span>{(downloadResult.filesize / 1024 / 1024).toFixed(1)} MB</div>
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
                        className="h-8 flex-1 rounded bg-[#10B981] px-3 text-[10px] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#10B981]/90"
                      >
                        <Download className="mr-1 size-3" /> Save MP4 to Disk
                      </Button>
                      <Button
                        onClick={() => navigate({ to: "/videos" })}
                        className="h-8 rounded bg-[#263548] px-3 text-[10px] font-bold uppercase tracking-wider text-[#F3F4F6] hover:bg-[#263548]/90"
                      >
                        Run Analysis →
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    onClick={handleDownload}
                    disabled={downloading}
                    className="h-9 w-full rounded bg-[#F59E0B] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#F59E0B]/90 disabled:opacity-40 disabled:cursor-not-allowed"
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
                <div className="border-b border-[#263548] pb-3 flex items-center justify-between">
                  <h3 className="font-bold uppercase text-[#F3F4F6] flex items-center gap-2">
                    <Subtitles className="size-4 text-[#06B6D4]" /> Subtitles & Transcripts
                  </h3>
                  {subtitles && (
                    <Badge className={`text-[9px] uppercase border ${subtitles.isAuto ? "bg-[#8B5CF6]/10 text-[#8B5CF6] border-[#8B5CF6]/30" : "bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30"}`}>
                      {subtitles.isAuto ? "Auto Captions" : "Manual Subtitles"}
                    </Badge>
                  )}
                </div>

                {/* Subtitle controls */}
                <div className="flex items-center gap-2">
                  <Select value={selectedLang} onValueChange={(val) => { setSelectedLang(val); handleFetchSubtitles(val); }}>
                    <SelectTrigger className="h-8 border-[#263548] bg-[#0B1220] font-mono text-xs text-[#F3F4F6]">
                      <SelectValue placeholder="Select Language" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#111827] border-[#263548] font-mono text-xs text-[#F3F4F6]">
                      {metadata.available_subtitles.length > 0 ? (
                        metadata.available_subtitles.map((s) => (
                          <SelectItem key={s.code} value={s.code}>
                            {s.name} ({s.code}) {s.isAuto ? "[Auto]" : "[Manual]"}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="en">English (en)</SelectItem>
                      )}
                    </SelectContent>
                  </Select>

                  <Button
                    size="sm"
                    onClick={() => handleFetchSubtitles()}
                    disabled={fetchingSubs}
                    className="h-8 rounded bg-[#06B6D4] px-3 text-[10px] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#06B6D4]/90"
                  >
                    {fetchingSubs ? <Loader2 className="size-3 animate-spin" /> : "Load"}
                  </Button>
                </div>

                {/* Subtitle Error Banner */}
                {subsError && (
                  <div className="rounded border border-[#EF4444]/30 bg-[#EF4444]/10 p-3 text-[11px] text-[#EF4444]">
                    <span className="font-bold">Subtitles Unavailable: </span>
                    {subsError.cause}
                    <p className="mt-2 text-[10px] text-[#64748B]">
                      You can download the video artifact above and run Whisper audio transcription on the Video Analysis page.
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
                        className="group flex items-start gap-3 rounded border border-[#263548] bg-[#0B1220] p-2.5 hover:border-[#06B6D4] hover:bg-[#1A2332] cursor-pointer transition-colors"
                      >
                        <span className="shrink-0 rounded bg-[#06B6D4]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#06B6D4] group-hover:bg-[#06B6D4] group-hover:text-[#0B1220]">
                          {fmtDuration(seg.start)}
                        </span>
                        <p className="text-[11px] leading-relaxed text-[#94A3B8] group-hover:text-[#F3F4F6]">
                          {seg.text}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {!subtitles && !subsError && !fetchingSubs && (
                  <div className="py-8 text-center text-[#64748B]">
                    Select language and click Load to view timestamped subtitle transcript.
                  </div>
                )}
              </Card>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
