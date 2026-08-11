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
  fetchYoutubeMetadata,
  fetchYoutubeSubtitles,
  downloadYoutubeVideo,
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

    try {
      const data = await fetchYoutubeMetadata(targetUrl);
      setMetadata(data);
      // Default to first available subtitle language if 'en' is missing
      if (data.available_subtitles.length > 0) {
        const hasEn = data.available_subtitles.some((s) => s.code === "en");
        if (!hasEn) {
          setSelectedLang(data.available_subtitles[0].code);
        }
      }
    } catch (err: any) {
      setMetaError(err as YoutubeError);
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
      const data = await fetchYoutubeSubtitles(activeUrl, lang);
      setSubtitles(data);
    } catch (err: any) {
      setSubsError(err as YoutubeError);
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
      const data = await downloadYoutubeVideo(activeUrl, "720p");
      setDownloadResult(data);
    } catch (err: any) {
      setDownloadError(err as YoutubeError);
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
              {/* Embed Player */}
              <Card className={`${CARD} overflow-hidden p-0`}>
                <div className="aspect-video w-full bg-black">
                  <iframe
                    ref={iframeRef}
                    title={metadata.title}
                    src={`https://www.youtube-nocookie.com/embed/${metadata.id}`}
                    className="size-full border-0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
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
                  <Badge className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 text-[9px]">
                    Verified yt-dlp
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
                  Download original MP4 artifact (720p) into local storage for keyframe extraction, OCR, and Whisper audio analysis. Each download is audit logged.
                </p>

                {downloadError && (
                  <div className="rounded border border-[#EF4444]/30 bg-[#EF4444]/10 p-3 text-[#EF4444]">
                    <span className="font-bold">Download Failed: </span>
                    {downloadError.cause}
                  </div>
                )}

                {downloadResult ? (
                  <div className="space-y-3 rounded border border-[#10B981]/30 bg-[#10B981]/10 p-3">
                    <div className="flex items-center gap-2 text-[#10B981] font-bold">
                      <CheckCircle2 className="size-4" /> Artifact Downloaded Successfully
                    </div>
                    <div className="text-[10px] text-[#94A3B8] space-y-1 font-mono break-all">
                      <div><span className="text-[#64748B]">Path: </span>{downloadResult.path}</div>
                      <div><span className="text-[#64748B]">Format: </span>{downloadResult.format}</div>
                      <div><span className="text-[#64748B]">Size: </span>{(downloadResult.filesize ? (downloadResult.filesize / 1024 / 1024).toFixed(2) : "?")} MB</div>
                    </div>
                    <Button
                      onClick={() => navigate({ to: "/videos" })}
                      className="h-8 rounded bg-[#10B981] px-3 text-[10px] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#10B981]/90"
                    >
                      Run Video Analysis →
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={handleDownload}
                    disabled={downloading}
                    className="h-9 w-full rounded bg-[#F59E0B] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#F59E0B]/90"
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
