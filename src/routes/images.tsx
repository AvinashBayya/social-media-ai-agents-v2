import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Upload,
  Loader2,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Camera,
  MapPin,
  Type,
  Copy,
  Fingerprint,
  ChevronDown,
  ChevronRight,
  Info,
  Tags,
  Newspaper,
  Youtube,
  Images,
  BookOpen,
  MessageCircle,
  Globe2,
  ImageOff,
} from "lucide-react";
import {
  assessProvenance,
  findNearDuplicates,
  OCR_LANGUAGES,
  OCR_LOW_CONFIDENCE,
  type C2paReport,
  type DuplicateReport,
  type ExifReport,
  type HashedImage,
  type OcrReport,
} from "@/utils/imaging";
import {
  decodeImage,
  loadImageCorpus,
  readC2pa,
  readExif,
  rememberImage,
  runOcr,
  MediaError,
  OCR_ASSET_PROVENANCE,
} from "@/utils/imaging-client";
import { hashRgba } from "@/utils/imaging";
import { ExifMap } from "@/components/exif-map";
import { NotImplementedPanel } from "@/components/not-implemented";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import {
  aiServiceOcrVlm,
  AiServiceUnavailableError,
  type AiOcrVlmResult,
} from "@/utils/ai-service-client";
import { PinButton } from "@/components/pin-button";
import { takeFileHandoff } from "@/utils/file-handoff";
import { aiExtractEntities, type AnalysisEntity } from "@/utils/analysis-llm";
import { getActiveTarget } from "@/utils/active-target";
import {
  fetchNewsImages,
  fetchWikipediaImages,
  fetchOpenverseImages,
  type NewsImageResult,
  type WikipediaImageResult,
  type OpenverseImageResult,
} from "@/utils/image-sources";
import { serverSearchYoutubeVideos, type YoutubeSearchResult } from "@/utils/youtube-collector";
import { socialReddit } from "@/utils/social";
import type { SocialMedia } from "@/utils/social";
import { buildPlainQuery, parseQuery } from "@/utils/search";
import { GeoIntPanel } from "@/components/geoint-panel";
import type { ImageMatch } from "@/utils/geoint/image-match";
import type { LocationHypothesis } from "@/utils/geoint/geolocation-hypothesis";
import { attachGeointToCase, type AttachOutcome } from "@/utils/cases/case-geoint";
import { listCases } from "@/utils/cases/case-runs";

/**
 * Image Intelligence — Module 4 analysis workbench (PS-18 §6.4).
 *
 * The previous version of this page was invented end to end: twelve gradient
 * rectangles with captions like "Convoy near restricted checkpoint", a fixed
 * EXIF line reading "Canon EOS · f/2.8 · ISO 400", a GPS fix at Damascus with a
 * "±180m" precision, an Arabic OCR string, a watchlist face match at 71%, and a
 * "Deepfake probability 8%" bar. No image was ever read.
 *
 * This is the replacement: real bytes, real parsers, and an explicit statement
 * of what cannot be determined. All processing is in-browser — the uploaded file
 * never leaves the machine, which for a defence tool is worth stating plainly.
 */

export const Route = createFileRoute("/images")({
  head: () => ({ meta: [{ title: "Image Intelligence — Sentinel AI" }] }),
  /**
   * `?url=` hands one asset over from another module — the Analyse control on a
   * social post's media is the first caller.
   *
   * Validated rather than trusted: only absolute http(s) URLs are accepted, so a
   * crafted `javascript:` or `data:` search param cannot reach the fetch below.
   * Anything else is dropped to undefined and the page opens empty.
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
  component: Page,
});

const CARD = "bg-console-surface border-console-border";

/** Default OCR selection: English plus Hindi covers most Indian-language signage. */
const DEFAULT_LANGS = ["eng", "hin"];

/** A single real image, flattened out of a Reddit post's SocialMedia[]. */
interface RedditImageResult {
  url: string;
  thumbnailUrl: string | null;
  title: string;
  postUrl: string;
  author: string;
}

interface Analysis {
  name: string;
  previewUrl: string;
  hash: string;
  width: number;
  height: number;
  sizeBytes: number | null;
  exif: ExifReport | null;
  exifError: string | null;
  c2pa: C2paReport | null;
  duplicates: DuplicateReport | null;
  /**
   * Real image bytes, kept only for the ai-service panel below (detection,
   * description, faces all need to POST the file). null when analysing a
   * URL whose bytes could not be fetched (the same CORS case that already
   * leaves exifError set) — the panel reports that as a real absence of
   * bytes to send, not as "zero objects found".
   */
  blob: Blob | null;
}

function Section({
  icon,
  title,
  subtitle,
  children,
  defaultOpen = true,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className={CARD}>
      <CardContent className="p-4">
        <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-console-label" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-console-label" />
          )}
          {icon}
          <span className="text-xs font-bold uppercase text-console-text">{title}</span>
          {subtitle && <span className="ml-auto text-[10px] text-console-label">{subtitle}</span>}
        </button>
        {open && <div className="mt-3">{children}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * Related-image thumbnails come from external hosts (GDELT's crawled
 * og:image, YouTube's CDN, Wikipedia/Openverse's originals) with no
 * guarantee the URL still resolves — hotlink protection, a deleted upload,
 * a CORS-blocked host. A plain `<img>` with no error handling just leaves a
 * blank/broken box, observed live on Openverse results. Falls back from
 * `src` to `fallbackSrc` (a thumbnail failing over to the full-size image,
 * where one exists) once, then shows an explicit "preview unavailable"
 * placeholder — never a substitute image, matching this panel's own "no
 * invented previews" rule.
 */
function ThumbnailImage({
  src,
  fallbackSrc,
  alt,
  className,
}: {
  src: string;
  fallbackSrc?: string | null;
  alt: string;
  className: string;
}) {
  const [stage, setStage] = useState<"primary" | "fallback" | "broken">("primary");

  if (stage === "broken") {
    return (
      <div
        className={`${className} flex items-center justify-center bg-console-deep text-console-label`}
        title="Preview unavailable"
      >
        <ImageOff className="size-4" />
      </div>
    );
  }

  const current = stage === "fallback" && fallbackSrc ? fallbackSrc : src;
  return (
    <img
      src={current}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => {
        if (stage === "primary" && fallbackSrc && fallbackSrc !== src) setStage("fallback");
        else setStage("broken");
      }}
    />
  );
}

function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [corpus, setCorpus] = useState<HashedImage[]>([]);

  const [langs, setLangs] = useState<string[]>(DEFAULT_LANGS);
  const [ocr, setOcr] = useState<OcrReport | null>(null);
  const [ocrError, setOcrError] = useState("");
  const [ocrProgress, setOcrProgress] = useState<{ status: string; progress: number } | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [entities, setEntities] = useState<AnalysisEntity[] | null>(null);
  const [entityError, setEntityError] = useState("");

  // ── Florence-2 OCR (ai-service) — a sibling of Tesseract OCR above, for
  // the case Tesseract structurally struggles with: legible text sharing
  // the frame with a busy photo. See ai-service-client.ts's
  // aiServiceOcrVlm doc comment.
  const [ocrVlm, setOcrVlm] = useState<AiOcrVlmResult | null>(null);
  const [ocrVlmError, setOcrVlmError] = useState("");
  const [ocrVlmLoading, setOcrVlmLoading] = useState(false);

  // ── GEOINT — LIFTED out of GeoIntPanel. `Section` (below) renders
  // `{open && children}`, so state held inside a `defaultOpen={false}` card's
  // own component was destroyed on every collapse. Held here in `Page`, it
  // survives.
  const [geoMatches, setGeoMatches] = useState<ImageMatch[]>([]);
  const [geoHypotheses, setGeoHypotheses] = useState<LocationHypothesis[]>([]);
  const [geoCaseId, setGeoCaseId] = useState("");
  const [geoAttachment, setGeoAttachment] = useState<AttachOutcome | null>(null);
  // Frozen per analysed image, not read per render — see the comment in
  // geoint-panel.tsx. Re-reading `new Date().toISOString()` in a render body
  // would make `retrievedAt`, and therefore `collectedAt` on every evidence
  // record, change on every keystroke in the case-select or match/hypothesis
  // forms.
  const [geoRetrievedAt, setGeoRetrievedAt] = useState("");
  const [geoCases, setGeoCases] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    setGeoCases(
      listCases().map((c) => ({
        id: c.id,
        label: `${c.caseNumber !== null ? `${c.caseNumber} · ` : ""}${c.title}`,
      })),
    );
  }, []);

  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. The mount+listener effect below
  // sets the real value client-side and keeps it in sync with the top-nav
  // search bar, matching the pattern used on every other route that shares
  // this global target.
  const [target, setTarget] = useState("");
  // Wikipedia's plain search and Openverse understand neither quotes nor
  // boolean operators — a query like `"sourav das" + "cjp"` searches for
  // those literal characters on both and returns nothing, verified live.
  // GDELT and Reddit both parse quoted phrases natively, so they keep using
  // `target` as-is; only these two get the flattened, operator-free form.
  const plainQuery = useMemo(() => {
    const parsed = parseQuery(target);
    return buildPlainQuery(parsed) || target.trim();
  }, [target]);
  const [newsImages, setNewsImages] = useState<NewsImageResult[]>([]);
  const [newsImagesLoading, setNewsImagesLoading] = useState(false);
  const [newsImagesError, setNewsImagesError] = useState<string | null>(null);
  const [relatedVideos, setRelatedVideos] = useState<YoutubeSearchResult[]>([]);
  const [relatedVideosLoading, setRelatedVideosLoading] = useState(false);
  const [relatedVideosError, setRelatedVideosError] = useState<string | null>(null);
  const [wikiImages, setWikiImages] = useState<WikipediaImageResult[]>([]);
  const [wikiImagesLoading, setWikiImagesLoading] = useState(false);
  const [wikiImagesError, setWikiImagesError] = useState<string | null>(null);
  const [openverseImages, setOpenverseImages] = useState<OpenverseImageResult[]>([]);
  const [openverseImagesLoading, setOpenverseImagesLoading] = useState(false);
  const [openverseImagesError, setOpenverseImagesError] = useState<string | null>(null);
  const [redditImages, setRedditImages] = useState<RedditImageResult[]>([]);
  const [redditImagesLoading, setRedditImagesLoading] = useState(false);
  const [redditImagesError, setRedditImagesError] = useState<string | null>(null);

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) setTarget(e.detail);
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  useEffect(() => {
    // Skip the empty placeholder — the mount-sync effect above fills in the
    // real target a moment later, which re-triggers this effect via [target].
    if (!target) return;
    let cancelled = false;
    (async () => {
      setNewsImagesLoading(true);
      setNewsImagesError(null);
      try {
        const res = await fetchNewsImages({ data: { query: target } });
        if (cancelled) return;
        setNewsImages(res.results);
        setNewsImagesError(res.error);
      } catch (err: any) {
        if (!cancelled) {
          setNewsImages([]);
          setNewsImagesError(err?.message ?? String(err));
        }
      } finally {
        if (!cancelled) setNewsImagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    (async () => {
      setRelatedVideosLoading(true);
      setRelatedVideosError(null);
      try {
        const res = await serverSearchYoutubeVideos({ data: { query: target } });
        if (cancelled) return;
        setRelatedVideos(res.results);
        setRelatedVideosError(res.error);
      } catch (err: any) {
        if (!cancelled) {
          setRelatedVideos([]);
          setRelatedVideosError(err?.message ?? String(err));
        }
      } finally {
        if (!cancelled) setRelatedVideosLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    (async () => {
      setWikiImagesLoading(true);
      setWikiImagesError(null);
      try {
        const res = await fetchWikipediaImages({ data: { query: plainQuery } });
        if (cancelled) return;
        setWikiImages(res.results);
        setWikiImagesError(res.error);
      } catch (err: any) {
        if (!cancelled) {
          setWikiImages([]);
          setWikiImagesError(err?.message ?? String(err));
        }
      } finally {
        if (!cancelled) setWikiImagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, plainQuery]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    (async () => {
      setOpenverseImagesLoading(true);
      setOpenverseImagesError(null);
      try {
        const res = await fetchOpenverseImages({ data: { query: plainQuery } });
        if (cancelled) return;
        setOpenverseImages(res.results);
        setOpenverseImagesError(res.error);
      } catch (err: any) {
        if (!cancelled) {
          setOpenverseImages([]);
          setOpenverseImagesError(err?.message ?? String(err));
        }
      } finally {
        if (!cancelled) setOpenverseImagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, plainQuery]);

  // Reddit posts carry SocialPost[], not a flat image list — flattened here
  // rather than in social.ts, since that shape is specific to this panel.
  // A missing credential (the common case until the Reddit OAuth script app
  // is configured — see credential-vault.ts) throws a real, honest
  // SocialUnavailableError from fetchRedditSearch, surfaced as-is below
  // rather than swallowed into an empty "no results" state.
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    (async () => {
      setRedditImagesLoading(true);
      setRedditImagesError(null);
      try {
        const posts = await socialReddit({ data: { query: target, limit: 50 } });
        if (cancelled) return;
        const flattened: RedditImageResult[] = [];
        for (const post of posts as any[]) {
          for (const m of (post.media ?? []) as SocialMedia[]) {
            if (m.type !== "image") continue;
            flattened.push({
              url: m.url,
              thumbnailUrl: m.thumbnailUrl,
              title: post.text?.trim() ? post.text.trim().slice(0, 120) : "(no title text)",
              postUrl: post.url,
              author: post.author,
            });
          }
        }
        setRedditImages(flattened);
      } catch (err: any) {
        if (!cancelled) {
          setRedditImages([]);
          setRedditImagesError(err?.message ?? String(err));
        }
      } finally {
        if (!cancelled) setRedditImagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => setCorpus(loadImageCorpus()), []);

  // Hand-off from another module via ?url=. Runs once per distinct URL so a
  // re-render cannot re-trigger a fetch of the same remote asset. Cross-origin
  // media will usually refuse the EXIF read — analyse() already reports that as
  // a failed read rather than as an absence of metadata.
  const handoffUrl = Route.useSearch().url;
  const handledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoffUrl || handledRef.current === handoffUrl) return;
    handledRef.current = handoffUrl;
    setUrlDraft(handoffUrl);
    void analyse(handoffUrl, handoffUrl);
    // analyse is a stable useCallback; depending on it would re-run this on
    // every one of its identity changes rather than on a new URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffUrl]);

  useEffect(() => {
    return () => {
      if (analysis?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(analysis.previewUrl);
    };
  }, [analysis?.previewUrl]);

  // A file dropped on the global search bar's "Continue in Image
  // Intelligence" action hands off here — see file-handoff.ts. In-memory
  // only (a File can't be persisted to localStorage), so this only fires
  // once, right after that navigation.
  useEffect(() => {
    const handoff = takeFileHandoff();
    if (handoff) analyse(handoff.file, handoff.file.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const analyse = useCallback(async (source: File | Blob | string, name: string) => {
    setError("");
    setOcr(null);
    setOcrError("");
    setEntities(null);
    setEntityError("");
    setOcrVlm(null);
    setOcrVlmError("");
    setAnalysis(null);
    // GEOINT records describe ONE image. Carrying them across an analyse()
    // would attribute photo A's findings to photo B.
    setGeoMatches([]);
    setGeoHypotheses([]);
    setGeoAttachment(null);
    // The CASE SELECTION resets too, and that is the load-bearing half — the
    // same reason applies: a case chosen for photo A must not silently carry
    // over and receive photo B's evidence.
    setGeoCaseId("");
    setGeoRetrievedAt(new Date().toISOString());
    setBusy("Decoding image");

    try {
      const { data, width, height } = await decodeImage(source);
      const hash = hashRgba(data, width, height);

      setBusy("Reading EXIF");
      let exif: ExifReport | null = null;
      let exifError: string | null = null;
      let fetchedBlob: Blob | null = null;
      try {
        if (typeof source !== "string") {
          exif = await readExif(source);
        } else {
          // Fetch the original bytes so EXIF can be read from a URL too. This
          // used to skip the attempt entirely and hand the assessment
          // interpretExif(null), which renders as "No EXIF metadata" — reporting
          // "we never looked" as "there is nothing there", the exact confusion
          // the rest of this module is built to avoid. A CORS refusal is now
          // surfaced as a failed read, and exif stays null so no absence is
          // claimed.
          const res = await fetch(source, { mode: "cors" });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching the image bytes.`);
          fetchedBlob = await res.blob();
          exif = await readExif(fetchedBlob);
        }
      } catch (err: any) {
        // A parse or fetch failure is reported as a failure, never converted
        // into "no metadata" — those are different findings.
        exif = null;
        exifError =
          typeof source === "string"
            ? `EXIF could not be read from this URL: ${err?.message ?? String(err)}. ` +
              `Cross-origin images are usually blocked by CORS. Download the file and upload ` +
              `it directly. NOTE: this is a failed read, not an absence of metadata — nothing ` +
              `is being claimed about this image either way.`
            : (err?.message ?? String(err));
      }

      setBusy("Verifying Content Credentials");
      const c2pa = await readC2pa(source);
      const blob: Blob | null = typeof source === "string" ? fetchedBlob : source;

      setBusy("Matching against corpus");
      const stored = loadImageCorpus();
      /*
       * When THIS analyst first saw the image, which is a real fact about our
       * own corpus - distinct from when the camera says it was taken.
       *
       * This was `exif?.captureTime ?? new Date().toISOString()`, which silently
       * substituted the analysis time for a capture time whenever EXIF carried
       * none. EXIF absence is the NORMAL case for redistributed media (every
       * major platform strips it), so that fallback fired constantly and made
       * every stripped image look like it had been captured the moment it was
       * uploaded. The two are now separate fields with separate meanings.
       */
      const observedAt = new Date().toISOString();
      const seenAt = observedAt;
      const duplicates = findNearDuplicates({ hash, seenAt, id: name }, stored);

      const next = rememberImage({
        id: name,
        hash,
        source: typeof source === "string" ? new URL(source).hostname : "uploaded",
        url: typeof source === "string" ? source : "",
        seenAt,
        context: name,
        // Carried into the Module 5 map. Omitted entirely when there is no fix —
        // spreading `gps: undefined` would still create the key.
        ...(exif?.gps ? { gps: exif.gps } : {}),
        ...(exif?.camera.model
          ? { camera: [exif.camera.make, exif.camera.model].filter(Boolean).join(" ") }
          : {}),
      });
      setCorpus(next);

      setAnalysis({
        name,
        previewUrl: typeof source === "string" ? source : URL.createObjectURL(source),
        hash,
        width,
        height,
        sizeBytes: source instanceof Blob ? source.size : null,
        exif,
        exifError,
        c2pa,
        duplicates,
        blob,
      });
    } catch (err: any) {
      setError(
        err instanceof MediaError ? `[${err.stage}] ${err.message}` : (err?.message ?? String(err)),
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) analyse(file, file.name);
  };

  const doOcr = async () => {
    if (!analysis) return;
    setBusy("Running OCR");
    setOcrError("");
    setOcr(null);
    setEntities(null);
    setEntityError("");
    try {
      const report = await runOcr(analysis.previewUrl, langs, setOcrProgress);
      setOcr(report);
    } catch (err: any) {
      setOcrError(err?.message ?? String(err));
    } finally {
      setBusy(null);
      setOcrProgress(null);
    }
  };

  const doOcrVlm = async () => {
    if (!analysis?.blob) return;
    setOcrVlmLoading(true);
    setOcrVlmError("");
    setOcrVlm(null);
    try {
      const result = await aiServiceOcrVlm(analysis.blob);
      setOcrVlm(result);
    } catch (err: any) {
      setOcrVlmError(
        err instanceof AiServiceUnavailableError ? err.message : (err?.message ?? String(err)),
      );
    } finally {
      setOcrVlmLoading(false);
    }
  };

  /**
   * OCR text into Module 2's entity extractor. The recognised text becomes an
   * Article, so exactly the same extractor runs over it as over a news feed —
   * no separate image-specific path to drift out of sync.
   */
  const runEntities = async () => {
    if (!ocr?.text.trim() || !analysis) return;
    setBusy("Extracting entities");
    setEntityError("");
    try {
      const res: any = await aiExtractEntities({
        data: {
          article: {
            id: `ocr:${analysis.hash}`,
            title: ocr.text.slice(0, 160),
            source: `OCR (${ocr.languages.join("+")}) of ${analysis.name}`,
            url: "",
            pubDate: analysis.exif?.captureTime ?? "",
            body: ocr.text,
          },
        },
      });
      setEntities(res.entities ?? []);
    } catch (err: any) {
      setEntityError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  // Passed to AiAnalysisPanel, which appends its own detect/describe/faces
  // findings and calls llmReport — this is everything the forensic panel
  // above already knows, so the report doesn't have to re-derive it.
  const reportContextLines: string[] = analysis
    ? [
        `Perceptual hash: ${analysis.hash} (${analysis.width}x${analysis.height})`,
        analysis.exif
          ? `EXIF: ${analysis.exif.findings.map((f) => `${f.label}: ${f.value}`).join("; ") || "present, no notable fields"}`
          : `EXIF: ${analysis.exifError ? `read failed — ${analysis.exifError}` : "absent"}`,
        ...(analysis.c2pa ? [`C2PA Content Credentials: ${analysis.c2pa.summary}`] : []),
        ...(analysis.duplicates?.matches.length
          ? [`Near-duplicate matches: ${analysis.duplicates.summary}`]
          : []),
        ...(ocr?.text.trim()
          ? [`OCR text (${ocr.languages.join("+")}): ${ocr.text.trim().slice(0, 1500)}`]
          : []),
        ...(ocrVlm?.text.trim()
          ? [`Florence-2 OCR text: ${ocrVlm.text.trim().slice(0, 1500)}`]
          : []),
      ]
    : [];

  const provenance = analysis
    ? assessProvenance({
        exif: analysis.exif,
        c2pa: analysis.c2pa,
        duplicates: analysis.duplicates,
      })
    : null;

  const statusIcon = (s: C2paReport["status"] | undefined) =>
    s === "valid" ? (
      <ShieldCheck className="size-3.5 text-console-green" />
    ) : s === "invalid" ? (
      <ShieldAlert className="size-3.5 text-console-red" />
    ) : (
      <ShieldQuestion className="size-3.5 text-console-label" />
    );

  return (
    <AppShell>
      <PageHeader
        title="Image Intelligence"
        description="Provenance-first image forensics. C2PA verification, EXIF, OCR and perceptual matching — all in this browser; the file is never uploaded."
      />

      {/* ── Related images from news & open source ──────────────────────── */}
      <Card className={`${CARD} mb-4`}>
        <CardContent className="p-4">
          <div className="flex items-center gap-1.5">
            <Images className="size-3.5 text-console-blue" />
            <span className="text-xs font-bold uppercase text-console-text">
              Related Images — News &amp; Open Source
            </span>
            {target && <span className="font-mono text-[10px] text-console-label">for "{target}"</span>}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-console-label">
            Real thumbnails only — no invented previews. "Analyse" loads the actual image into the
            pipeline below exactly as if it had been pasted into the URL field; cross-origin EXIF
            reads may still be CORS-blocked, reported as a failed read below, same as any pasted URL.
          </p>

          {!target ? (
            <p className="mt-3 text-[11px] text-console-label">
              Set a target with the search bar above to find related images.
            </p>
          ) : (
            <div className="mt-3 grid gap-4 lg:grid-cols-3 2xl:grid-cols-5">
              {/* News */}
              <div>
                <div className="flex items-center gap-1.5">
                  <Newspaper className="size-3 text-console-muted" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                    From collected news (GDELT)
                  </span>
                  {newsImagesLoading && (
                    <Loader2 className="size-3 animate-spin text-console-label" />
                  )}
                </div>
                {newsImagesError ? (
                  <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="font-mono text-[10px] leading-relaxed text-console-red">
                      {newsImagesError}
                    </span>
                  </div>
                ) : !newsImagesLoading && newsImages.length === 0 ? (
                  <p className="mt-2 text-[11px] text-console-label">
                    No article thumbnails found for "{target}". GDELT does not detect a social
                    image for every article, so this can be empty even with real coverage.
                  </p>
                ) : (
                  <div className="mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {newsImages.map((n, i) => (
                      <div
                        key={`${n.url}-${i}`}
                        className="flex items-center gap-2 rounded border border-console-border bg-console-deep/60 p-2"
                      >
                        <ThumbnailImage
                          src={n.url}
                          alt=""
                          className="size-14 shrink-0 rounded border border-console-border object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          {n.articleUrl ? (
                            <a
                              href={n.articleUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate text-[11px] text-console-text hover:underline"
                            >
                              {n.title}
                            </a>
                          ) : (
                            <span className="block truncate text-[11px] text-console-text">
                              {n.title}
                            </span>
                          )}
                          <span className="font-mono text-[9px] text-console-label">
                            {n.domain}
                            {n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleDateString()}` : ""}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setUrlDraft(n.url);
                            void analyse(n.url, n.title);
                          }}
                          className="h-6 shrink-0 gap-1 px-2 text-[9px]"
                          title="Analyse this article thumbnail — EXIF, C2PA, OCR, perceptual hash"
                        >
                          Analyse
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* YouTube thumbnails */}
              <div>
                <div className="flex items-center gap-1.5">
                  <Youtube className="size-3 text-console-muted" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                    From YouTube (open source video)
                  </span>
                  {relatedVideosLoading && (
                    <Loader2 className="size-3 animate-spin text-console-label" />
                  )}
                </div>
                {relatedVideosError ? (
                  <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="font-mono text-[10px] leading-relaxed text-console-red">
                      {relatedVideosError}
                    </span>
                  </div>
                ) : !relatedVideosLoading && relatedVideos.length === 0 ? (
                  <p className="mt-2 text-[11px] text-console-label">
                    No YouTube videos found for "{target}".
                  </p>
                ) : (
                  <div className="mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {relatedVideos.map((v, i) => {
                      const thumbUrl = `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
                      return (
                        <div
                          key={`${v.videoId}-${i}`}
                          className="flex items-center gap-2 rounded border border-console-border bg-console-deep/60 p-2"
                        >
                          <ThumbnailImage
                            src={thumbUrl}
                            alt=""
                            className="size-14 shrink-0 rounded border border-console-border object-cover"
                          />
                          <div className="min-w-0 flex-1">
                            <a
                              href={v.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate text-[11px] text-console-text hover:underline"
                            >
                              {v.title}
                            </a>
                            <span className="font-mono text-[9px] text-console-label">
                              {v.channel ?? "unknown channel"}
                              {v.publishedTimeText ? ` · ${v.publishedTimeText}` : ""}
                            </span>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setUrlDraft(thumbUrl);
                              void analyse(thumbUrl, v.title);
                            }}
                            className="h-6 shrink-0 gap-1 px-2 text-[9px]"
                            title="Analyse this video's thumbnail — EXIF, C2PA, OCR, perceptual hash"
                          >
                            Analyse
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Wikipedia */}
              <div>
                <div className="flex items-center gap-1.5">
                  <BookOpen className="size-3 text-console-muted" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                    From Wikipedia (open source)
                  </span>
                  {wikiImagesLoading && (
                    <Loader2 className="size-3 animate-spin text-console-label" />
                  )}
                </div>
                {wikiImagesError ? (
                  <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="font-mono text-[10px] leading-relaxed text-console-red">
                      {wikiImagesError}
                    </span>
                  </div>
                ) : !wikiImagesLoading && wikiImages.length === 0 ? (
                  <p className="mt-2 text-[11px] text-console-label">
                    No Wikipedia page images found for "{plainQuery}".
                  </p>
                ) : (
                  <div className="mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {wikiImages.map((w, i) => (
                      <div
                        key={`${w.url}-${i}`}
                        className="flex items-center gap-2 rounded border border-console-border bg-console-deep/60 p-2"
                      >
                        <ThumbnailImage
                          src={w.url}
                          alt=""
                          className="size-14 shrink-0 rounded border border-console-border object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          <a
                            href={w.pageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-[11px] text-console-text hover:underline"
                          >
                            {w.title}
                          </a>
                          <span className="font-mono text-[9px] text-console-label">en.wikipedia.org</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setUrlDraft(w.url);
                            void analyse(w.url, w.title);
                          }}
                          className="h-6 shrink-0 gap-1 px-2 text-[9px]"
                          title="Analyse this Wikipedia page image — EXIF, C2PA, OCR, perceptual hash"
                        >
                          Analyse
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Openverse */}
              <div>
                <div className="flex items-center gap-1.5">
                  <Globe2 className="size-3 text-console-muted" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                    From Openverse (open licence)
                  </span>
                  {openverseImagesLoading && (
                    <Loader2 className="size-3 animate-spin text-console-label" />
                  )}
                </div>
                {openverseImagesError ? (
                  <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="font-mono text-[10px] leading-relaxed text-console-red">
                      {openverseImagesError}
                    </span>
                  </div>
                ) : !openverseImagesLoading && openverseImages.length === 0 ? (
                  <p className="mt-2 text-[11px] text-console-label">
                    No openly-licensed images found on Openverse for "{plainQuery}".
                  </p>
                ) : (
                  <div className="mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {openverseImages.map((o, i) => (
                      <div
                        key={`${o.url}-${i}`}
                        className="flex items-center gap-2 rounded border border-console-border bg-console-deep/60 p-2"
                      >
                        <ThumbnailImage
                          src={o.thumbnailUrl ?? o.url}
                          fallbackSrc={o.thumbnailUrl ? o.url : null}
                          alt=""
                          className="size-14 shrink-0 rounded border border-console-border object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          <a
                            href={o.sourcePageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-[11px] text-console-text hover:underline"
                          >
                            {o.title}
                          </a>
                          <span className="font-mono text-[9px] text-console-label">
                            {o.creator ?? "creator not reported"}
                            {o.license ? ` · ${o.license}` : ""}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setUrlDraft(o.url);
                            void analyse(o.url, o.title);
                          }}
                          className="h-6 shrink-0 gap-1 px-2 text-[9px]"
                          title="Analyse this Openverse image — EXIF, C2PA, OCR, perceptual hash"
                        >
                          Analyse
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Reddit */}
              <div>
                <div className="flex items-center gap-1.5">
                  <MessageCircle className="size-3 text-console-muted" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                    From Reddit (open source)
                  </span>
                  {redditImagesLoading && (
                    <Loader2 className="size-3 animate-spin text-console-label" />
                  )}
                </div>
                {redditImagesError ? (
                  <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="font-mono text-[10px] leading-relaxed text-console-red">
                      {redditImagesError}
                    </span>
                  </div>
                ) : !redditImagesLoading && redditImages.length === 0 ? (
                  <p className="mt-2 text-[11px] text-console-label">
                    No Reddit image posts found for "{target}".
                  </p>
                ) : (
                  <div className="mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {redditImages.map((r, i) => (
                      <div
                        key={`${r.url}-${i}`}
                        className="flex items-center gap-2 rounded border border-console-border bg-console-deep/60 p-2"
                      >
                        <ThumbnailImage
                          src={r.thumbnailUrl ?? r.url}
                          fallbackSrc={r.thumbnailUrl ? r.url : null}
                          alt=""
                          className="size-14 shrink-0 rounded border border-console-border object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          <a
                            href={r.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-[11px] text-console-text hover:underline"
                          >
                            {r.title}
                          </a>
                          <span className="font-mono text-[9px] text-console-label">u/{r.author}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setUrlDraft(r.url);
                            void analyse(r.url, r.title);
                          }}
                          className="h-6 shrink-0 gap-1 px-2 text-[9px]"
                          title="Analyse this Reddit image — EXIF, C2PA, OCR, perceptual hash"
                        >
                          Analyse
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={`${CARD} mb-4`}>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Button
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
              className="h-8 gap-1.5"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {busy ?? "Upload image"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onFile}
              className="hidden"
            />

            <div className="min-w-[220px] flex-1">
              <Input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && urlDraft.trim() && analyse(urlDraft.trim(), urlDraft.trim())
                }
                placeholder="…or paste an image URL"
                className="h-8 border-console-border bg-console-deep text-[11px] text-console-text"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !urlDraft.trim()}
              onClick={() => analyse(urlDraft.trim(), urlDraft.trim())}
              className="h-8"
            >
              Analyse URL
            </Button>
            <span className="text-[10px] text-console-label">
              {corpus.length} image(s) hashed in this browser
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-console-label">
            <Info className="mt-px size-3 shrink-0" />
            Provenance beats classification. A C2PA signature either verifies or it does not — no
            threshold, no false positives. A deepfake score is a guess, so this system does not
            produce one; see "Not implemented" below for exactly what that means.
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
              <span className="font-mono text-[10px] leading-relaxed text-console-red">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {!analysis ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Card className={CARD}>
            <CardContent className="p-10 text-center">
              <Camera className="mx-auto size-8 text-console-border" />
              <p className="mt-3 text-sm text-console-muted">No image loaded.</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-console-label">
                Upload a file or paste a URL. Nothing is analysed until you do, and nothing is sent
                anywhere — EXIF parsing, C2PA verification, OCR and hashing all run as WebAssembly
                in this tab.
              </p>
            </CardContent>
          </Card>
          <NotImplementedPanel />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            {/* ── Preview ─────────────────────────────────────────────────── */}
            <Card className={CARD}>
              <CardContent className="p-0">
                <img
                  src={analysis.previewUrl}
                  alt={analysis.name}
                  className="max-h-[420px] w-full rounded-t-lg bg-console-deep object-contain"
                />
                <div className="flex flex-wrap items-center gap-2 border-t border-console-border p-3 font-mono text-[10px] text-console-muted">
                  <span className="truncate font-semibold text-console-text">{analysis.name}</span>
                  <span>
                    {analysis.width}×{analysis.height}
                  </span>
                  {analysis.sizeBytes !== null && (
                    <span>{(analysis.sizeBytes / 1024).toFixed(0)} KB</span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    <Fingerprint className="size-3" />
                    pHash {analysis.hash}
                    <button
                      onClick={() => navigator.clipboard?.writeText(analysis.hash)}
                      className="text-console-blue hover:underline"
                      title="Copy hash"
                    >
                      <Copy className="size-3" />
                    </button>
                    <PinButton
                      payload={{
                        kind: "image",
                        title: analysis.name,
                        source: analysis.exif?.camera.model
                          ? [analysis.exif.camera.make, analysis.exif.camera.model]
                              .filter(Boolean)
                              .join(" ")
                          : "uploaded image",
                        url:
                          typeof analysis.previewUrl === "string" &&
                          analysis.previewUrl.startsWith("http")
                            ? analysis.previewUrl
                            : "",
                        publishedAt: analysis.exif?.captureTime ?? "",
                        // The forensic findings ARE the evidence — a filename on
                        // its own tells a case nothing.
                        excerpt: [
                          `pHash ${analysis.hash} (${analysis.width}x${analysis.height})`,
                          analysis.c2pa ? `C2PA: ${analysis.c2pa.summary}` : "",
                          analysis.exif
                            ? analysis.exif.findings.map((f) => `${f.label}: ${f.value}`).join("; ")
                            : "EXIF was not read for this item.",
                          analysis.duplicates?.matches.length ? analysis.duplicates.summary : "",
                        ]
                          .filter(Boolean)
                          .join("\n"),
                        credibility: null,
                        credibilityRationale:
                          "Forensic findings from the image itself. C2PA results are " +
                          "cryptographically verified; EXIF is self-reported by the writing " +
                          "device and editable. No deepfake assessment is made.",
                        data: {
                          hash: analysis.hash,
                          gps: analysis.exif?.gps ?? null,
                          c2paStatus: analysis.c2pa?.status ?? null,
                        },
                      }}
                    />
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* ── C2PA ────────────────────────────────────────────────────── */}
            <Section
              icon={statusIcon(analysis.c2pa?.status)}
              title="Content Credentials (C2PA)"
              subtitle={analysis.c2pa?.status ?? "—"}
            >
              {analysis.c2pa && (
                <>
                  <p className="text-[11px] leading-relaxed text-console-text">
                    {analysis.c2pa.summary}
                  </p>

                  {analysis.c2pa.aiGenerated && (
                    <div className="mt-2 rounded border border-console-purple/40 bg-console-purple/10 p-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-console-purple">
                        Declared AI-generated — high confidence
                      </div>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-console-muted">
                        {analysis.c2pa.aiEvidence} This is the only high-confidence AI finding this
                        system produces, because it is declared by the producing tool and
                        cryptographically signed rather than inferred from the pixels.
                      </p>
                    </div>
                  )}

                  {analysis.c2pa.validationIssues.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[10px] text-console-red">
                      {analysis.c2pa.validationIssues.map((v, i) => (
                        <li key={i}>{v}</li>
                      ))}
                    </ul>
                  )}

                  {analysis.c2pa.actions.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                        Signed provenance chain
                      </div>
                      <ol className="mt-1 space-y-1">
                        {analysis.c2pa.actions.map((a, i) => (
                          <li
                            key={i}
                            className="rounded border border-console-border bg-console-deep/60 p-1.5 text-[10px]"
                          >
                            <span className="font-mono text-console-text">{a.action}</span>
                            {a.agent && <span className="text-console-muted"> · {a.agent}</span>}
                            {a.when && <span className="text-console-label"> · {a.when}</span>}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {(analysis.c2pa.signedBy || analysis.c2pa.generator) && (
                    <dl className="mt-2 space-y-0.5 font-mono text-[10px]">
                      {analysis.c2pa.signedBy && (
                        <div className="flex justify-between">
                          <dt className="text-console-label">Signing authority</dt>
                          <dd className="text-console-text">{analysis.c2pa.signedBy}</dd>
                        </div>
                      )}
                      {analysis.c2pa.generator && (
                        <div className="flex justify-between">
                          <dt className="text-console-label">Claim generator</dt>
                          <dd className="text-console-text">{analysis.c2pa.generator}</dd>
                        </div>
                      )}
                      {analysis.c2pa.signedAt && (
                        <div className="flex justify-between">
                          <dt className="text-console-label">Signed at</dt>
                          <dd className="text-console-text">{analysis.c2pa.signedAt}</dd>
                        </div>
                      )}
                    </dl>
                  )}

                  {/* `method` describes HOW the check ran, independent of the
                      outcome — always shown here. The absence explanation
                      itself already lives in `summary` above; showing
                      C2PA_ABSENCE_NOTE a second time here duplicated it. */}
                  <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                    {analysis.c2pa.method}
                  </p>
                </>
              )}
            </Section>

            {/* ── EXIF ────────────────────────────────────────────────────── */}
            <Section
              icon={<Camera className="size-3.5 text-console-blue" />}
              title="EXIF metadata"
              subtitle={analysis.exif?.present ? "present" : "absent"}
            >
              {analysis.exifError && (
                <div className="mb-2 flex items-start gap-2 rounded border border-console-amber/30 bg-console-amber/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-amber" />
                  <span className="text-[10px] leading-relaxed text-console-amber">
                    {analysis.exifError}
                  </span>
                </div>
              )}

              {analysis.exif && (
                <>
                  <div className="space-y-1.5">
                    {analysis.exif.findings.map((f) => (
                      <div
                        key={f.id}
                        className={`rounded border p-2 ${
                          f.severity === "notable"
                            ? "border-console-amber/30 bg-console-amber/5"
                            : "border-console-border bg-console-deep/60"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-semibold text-console-text">{f.label}</span>
                          <span className="font-mono text-[10px] text-console-muted">{f.value}</span>
                        </div>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-console-muted">
                          {f.note}
                        </p>
                      </div>
                    ))}
                  </div>

                  {analysis.exif.present && (
                    <>
                      <button
                        onClick={() => setShowRaw(!showRaw)}
                        className="mt-2 text-[10px] text-console-blue hover:underline"
                      >
                        {showRaw ? "Hide" : "Show"} full metadata dump (
                        {Object.keys(analysis.exif.raw).length} tags)
                      </button>
                      {showRaw && (
                        <pre className="mt-1.5 max-h-64 overflow-auto rounded border border-console-border bg-console-deep p-2 font-mono text-[9px] leading-relaxed text-console-muted">
                          {JSON.stringify(analysis.exif.raw, null, 2)}
                        </pre>
                      )}
                    </>
                  )}

                  <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                    {analysis.exif.method}
                  </p>
                </>
              )}
            </Section>

            {/* ── GPS ─────────────────────────────────────────────────────── */}
            {analysis.exif?.gps && (
              <Section
                icon={<MapPin className="size-3.5 text-console-green" />}
                title="GPS fix from EXIF"
                subtitle="geotagged"
              >
                <ExifMap gps={analysis.exif.gps} label={analysis.name} />
                <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                  Written by the capturing device. Among the highest-value signals in image OSINT
                  because it places the camera — and forgeable with ordinary tools, so treat it as a
                  strong lead rather than a fact.
                </p>
              </Section>
            )}

            {/* ── GEOINT ──────────────────────────────────────────────────────
                Open by default and named in the subtitle so the case
                attachment (the "Case association" block, first inside the
                panel) is discoverable rather than hidden behind a collapsed
                section. No GEOINT logic here — the OBSERVED-metadata vs
                HYPOTHESIS-location distinction lives entirely inside the
                panel. */}
            <Section
              icon={<Globe2 className="size-3.5 text-console-amber" />}
              title="GEOINT"
              subtitle="attach to case · metadata (OBSERVED) · image match · location hypotheses (HYPOTHESIS)"
              defaultOpen
            >
              <GeoIntPanel
                imageRef={analysis.name}
                exif={analysis.exif}
                duplicates={analysis.duplicates}
                manualMatches={geoMatches}
                onAddMatch={(m) => setGeoMatches((prev) => [...prev, m])}
                hypotheses={geoHypotheses}
                onAddHypothesis={(h) => setGeoHypotheses((prev) => [...prev, h])}
                // Always set: `analyse()` stamps it before `setAnalysis`, and
                // `setAnalysis` is reachable from nowhere else.
                retrievedAt={geoRetrievedAt}
                cases={geoCases}
                caseId={geoCaseId}
                onSelectCase={(id) => {
                  setGeoCaseId(id);
                  // The previous outcome described a different case. Keeping
                  // it on screen would read as this case's state.
                  setGeoAttachment(null);
                }}
                onAttach={(graph) =>
                  setGeoAttachment(
                    attachGeointToCase(geoCaseId, analysis.name, graph, new Date().toISOString()),
                  )
                }
                attachment={geoAttachment}
              />
            </Section>

            {/* ── OCR ─────────────────────────────────────────────────────── */}
            <Section
              icon={<Type className="size-3.5 text-console-cyan" />}
              title="Text recognition (OCR)"
              subtitle={ocr ? `${ocr.words.length} words` : "not run"}
            >
              <div className="flex flex-wrap gap-1">
                {OCR_LANGUAGES.map((l) => {
                  const on = langs.includes(l.code);
                  return (
                    <button
                      key={l.code}
                      onClick={() =>
                        setLangs((prev) =>
                          prev.includes(l.code)
                            ? prev.filter((c) => c !== l.code)
                            : [...prev, l.code],
                        )
                      }
                      title={l.accuracyNote}
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${
                        on
                          ? "border-console-cyan/50 bg-console-cyan/10 text-console-cyan"
                          : "border-console-border bg-console-deep text-console-label"
                      }`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || langs.length === 0}
                  onClick={doOcr}
                  className="h-7 gap-1 text-[10px]"
                >
                  {busy === "Running OCR" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Type className="size-3" />
                  )}
                  Run OCR
                </Button>
                {ocrProgress && (
                  <span className="font-mono text-[10px] text-console-muted">
                    {ocrProgress.status} {Math.round(ocrProgress.progress * 100)}%
                  </span>
                )}
              </div>

              {/* Exactly what pressing Run OCR touches on the network. The worker script
                  and WASM engine used to be fetched from a CDN at this point without
                  saying so; they are now our own assets, and whatever is still remote is
                  named here rather than left for the analyst to discover in devtools. */}
              <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                {OCR_ASSET_PROVENANCE.disclosure}
              </p>

              {ocrError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <span className="text-[10px] leading-relaxed text-console-red">{ocrError}</span>
                </div>
              )}

              {ocr && (
                <div className="mt-2 space-y-2">
                  {/* Gated on text, not words.length: text is the primary
                      recognition signal and can succeed even in an edge
                      case where word-level parsing comes back short. */}
                  {!ocr.text.trim() ? (
                    <p className="text-[11px] text-console-label">
                      Tesseract found no text in this image with the selected languages. That is an
                      absence of recognised text, not a finding that the image contains none.
                    </p>
                  ) : (
                    <>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-console-border bg-console-deep p-2 text-[11px] leading-relaxed text-console-text">
                        {ocr.text}
                      </pre>
                      <div className="flex flex-wrap gap-1">
                        {ocr.words.map((w, i) => (
                          <span
                            key={i}
                            className={`rounded border px-1 py-0.5 font-mono text-[10px] ${
                              w.confidence < OCR_LOW_CONFIDENCE
                                ? "border-console-red/40 bg-console-red/5 text-console-red"
                                : "border-console-border bg-console-deep text-console-muted"
                            }`}
                            title={`Tesseract confidence ${w.confidence.toFixed(1)}`}
                          >
                            {w.text}
                            <span className="ml-1 opacity-60">{w.confidence.toFixed(0)}</span>
                          </span>
                        ))}
                      </div>
                      <div className="font-mono text-[10px] text-console-muted">
                        mean confidence{" "}
                        {ocr.meanConfidence === null ? "—" : ocr.meanConfidence.toFixed(1)} ·{" "}
                        {ocr.lowConfidenceCount} word(s) below {OCR_LOW_CONFIDENCE}
                      </div>
                    </>
                  )}

                  <p className="text-[10px] leading-relaxed text-console-label">{ocr.method}</p>
                  {ocr.accuracyNotes.map((n, i) => (
                    <p key={i} className="text-[10px] leading-relaxed text-console-amber">
                      {n}
                    </p>
                  ))}

                  {/* ── OCR text into Module 2's entity extraction ────────── */}
                  {ocr.text.trim() && (
                    <div className="border-t border-console-border pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || entities !== null}
                        onClick={runEntities}
                        className="h-7 gap-1 text-[10px]"
                      >
                        {busy === "Extracting entities" ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Tags className="size-3" />
                        )}
                        Extract entities from this text
                      </Button>
                      <p className="mt-1 text-[10px] leading-relaxed text-console-label">
                        Runs Module 2's extractor over the recognised text. Note it inherits OCR's
                        errors: a mis-recognised name is extracted as a mis-spelled entity, and the
                        model has no way to know the text came from an image.
                      </p>

                      {entityError && (
                        <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                          <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                          <span className="text-[10px] leading-relaxed text-console-red">
                            <span className="font-bold">AI unavailable.</span> {entityError}
                          </span>
                        </div>
                      )}

                      {entities && entities.length === 0 && (
                        <p className="mt-1.5 text-[10px] text-console-label">
                          The model found no named entities in the recognised text.
                        </p>
                      )}

                      {entities && entities.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {entities.map((e, i) => (
                            <Badge
                              key={`${e.entity}-${i}`}
                              className="border-console-purple/30 bg-console-purple/10 text-[10px] font-normal text-console-purple"
                              title={`${e.type} · model-reported confidence ${e.confidence}`}
                            >
                              {e.entity}
                              <span className="ml-1 opacity-60">{e.confidence.toFixed(2)}</span>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Florence-2 OCR (ai-service) — for the case Tesseract
                  structurally struggles with: legible text sharing the frame
                  with a busy photo. Independent of whether Tesseract ran or
                  found anything above. ────────────────────────────────── */}
              <div className="mt-3 border-t border-console-border pt-3">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ocrVlmLoading || !analysis?.blob}
                    onClick={doOcrVlm}
                    className="h-7 gap-1 text-[10px]"
                  >
                    {ocrVlmLoading ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Type className="size-3" />
                    )}
                    Try Florence-2 OCR instead
                  </Button>
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-console-label">
                  Tesseract above works from layout/connected-component analysis and struggles when
                  text shares the frame with a busy photo — verified live: a real composition of
                  that kind returned confidence ~33 and no real words from Tesseract. Florence-2,
                  trained on real-world image-text data, is a different tool for exactly that case.
                  Unlike Tesseract above, this sends the image to ai-service (the same local
                  backend the Local AI Analysis panel's detection/description already use) over
                  the network — nothing leaves this machine in normal local development, but it is
                  a real network call, not an in-browser computation.
                </p>

                {ocrVlmError && (
                  <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="text-[10px] leading-relaxed text-console-red">{ocrVlmError}</span>
                  </div>
                )}

                {ocrVlm && (
                  <div className="mt-2 space-y-1.5">
                    {!ocrVlm.text.trim() ? (
                      <p className="text-[11px] text-console-label">
                        Florence-2 found no text in this image either. That is an absence of
                        recognised text, not a finding that the image contains none.
                      </p>
                    ) : (
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-console-border bg-console-deep p-2 text-[11px] leading-relaxed text-console-text">
                        {ocrVlm.text}
                      </pre>
                    )}
                    <div className="font-mono text-[10px] text-console-muted">
                      {ocrVlm.provenance.model} · no per-word confidence — a language model's own
                      certainty is not comparable to Tesseract's per-glyph score
                    </div>
                  </div>
                )}
              </div>
            </Section>

            {/* ── Near-duplicates ─────────────────────────────────────────── */}
            <Section
              icon={<Fingerprint className="size-3.5 text-console-purple" />}
              title="Near-duplicate matches"
              subtitle={`${analysis.duplicates?.matches.length ?? 0} match(es)`}
            >
              {analysis.duplicates && (
                <>
                  <p className="text-[11px] leading-relaxed text-console-text">
                    {analysis.duplicates.summary}
                  </p>
                  {analysis.duplicates.matches.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {analysis.duplicates.matches.map((m) => (
                        <div
                          key={m.image.id}
                          className="rounded border border-console-border bg-console-deep/60 p-2"
                        >
                          <div className="flex flex-wrap items-center gap-2 text-[10px]">
                            <span className="font-mono text-console-text">{m.image.source}</span>
                            {m.identical && (
                              <Badge className="border-console-red/40 bg-console-red/10 text-[9px] font-normal text-console-red">
                                same image
                              </Badge>
                            )}
                            <span className="ml-auto font-mono text-console-muted">
                              distance {m.distance}/64
                              {m.daysEarlier !== null &&
                                m.daysEarlier > 0 &&
                                ` · ${m.daysEarlier.toFixed(0)}d earlier`}
                            </span>
                          </div>
                          {m.image.context && (
                            <p className="mt-0.5 text-[10px] text-console-muted">{m.image.context}</p>
                          )}
                          {m.image.url && (
                            <a
                              href={m.image.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-console-blue hover:underline"
                            >
                              {m.image.url.slice(0, 80)}
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                    {analysis.duplicates.method} Corpus is {corpus.length} image(s) hashed in this
                    browser; matching is against what has been analysed here, not the open web.
                  </p>
                </>
              )}
            </Section>
          </div>

          <div className="space-y-4">
            {/* ── Provenance assessment ─────────────────────────────────────
                Moved here from the top of the main column: this is a SUMMARY
                across C2PA/EXIF/duplicates, not another detail section, so it
                reads better as an at-a-glance sidebar card next to the AI
                tools than stacked ahead of the full detail sections it
                summarises (which used to make its own text feel repeated the
                moment the reader reached the Content Credentials section
                right below it). ─────────────────────────────────────────── */}
            {provenance && (
              <Card className="border-console-blue/30 bg-console-surface">
                <CardContent className="p-4">
                  <h3 className="text-xs font-bold uppercase text-console-text">Provenance assessment</h3>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-console-text">
                    {provenance.summary}
                  </p>

                  <div className="mt-3 space-y-1.5">
                    {provenance.findings.map((f, i) => (
                      <div
                        key={i}
                        className={`rounded border p-2 ${
                          f.strength === "verified"
                            ? "border-console-green/40 bg-console-green/5"
                            : f.strength === "observed"
                              ? "border-console-amber/30 bg-console-amber/5"
                              : "border-console-border bg-console-deep/60"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold text-console-text">{f.label}</span>
                          <Badge
                            variant="outline"
                            className="ml-auto shrink-0 border-console-border text-[9px] font-normal text-console-muted"
                          >
                            {f.strength}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-console-muted">
                          {f.detail}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 rounded border border-console-label/30 bg-console-deep/60 p-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                      What this system could NOT determine about this file
                    </div>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-console-muted">
                      {provenance.cannotDetermine.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>

                  <p className="mt-2 text-[10px] italic text-console-label">
                    This is a summary of findings, not a verdict. There is deliberately no
                    authenticity score — any single number here would be read as one, and we have no
                    basis for it.
                  </p>
                </CardContent>
              </Card>
            )}

            <AiAnalysisPanel
              image={analysis.blob}
              imageName={analysis.name}
              resetKey={analysis.hash}
              reportType="Image Intelligence"
              reportContextLines={reportContextLines}
              bytesUnavailableNote="Image bytes are unavailable for this item — same CORS restriction as the EXIF read above. Upload the file directly to use detection, description or faces."
            />

            <NotImplementedPanel />
          </div>
        </div>
      )}
    </AppShell>
  );
}
