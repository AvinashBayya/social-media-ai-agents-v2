import logging
from contextlib import asynccontextmanager
from typing import Optional

import pytesseract
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.audio_events import classify_audio as run_classify_audio
from app.describe import describe as run_describe
from app.detect import detect as run_detect
from app.errors import InvalidInput, ModelNotLoadedError, NotImplementedYet, register_exception_handlers
from app.faces import detect_and_match as run_faces
from app.forensics import compute_phash, forensics as run_forensics, hamming
from app.loaders import registry
from app.ocr import ocr as run_ocr
from app.ocr_vlm import ocr_vlm as run_ocr_vlm
from app.schemas import (
    AudioEvent,
    AudioEventsCoverage,
    AudioEventsResult,
    ChatRequest,
    ClosestMatch,
    DescribeResult,
    Detection,
    DetectResult,
    Face,
    FacesResult,
    ForensicsResult,
    HealthResult,
    OcrResult,
    OcrVlmResult,
    PhashCompareResult,
    StatsResult,
    TranslateRequest,
)
from app.stats import stats as request_stats

logging.basicConfig(level=settings.LOG_LEVEL)
logger = logging.getLogger("ai-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry.load()
    logger.info("ai-service started on device=%s", registry.device)
    yield


app = FastAPI(title="Sentinel AI Service", lifespan=lifespan)
register_exception_handlers(app)

# The frontend calls this service directly from the browser (uploaded media
# never transits the TanStack server) — see .env.example's VITE_AI_SERVICE_URL.
# Origins come from settings, not a wildcard, so a real deployment sets this
# to its actual frontend origin rather than inheriting a permissive default.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def count_ai_calls(request: Request, call_next):
    """Counts every request reaching an `/ai/*` endpoint, success or failure
    — a call that 501s or 503s is still real demand on the endpoint, and
    excluding failures would undercount exactly the paths most worth
    knowing about. `/ai/stats` itself is excluded so checking the counter
    does not change the thing it reports.

    Recorded in `finally`, not after a plain `await call_next(...)`: Starlette
    routes an `Exception`-registered handler (`unhandled_error_handler` in
    `errors.py`, which is what actually catches e.g. a missing-Tesseract
    failure) into `ServerErrorMiddleware`, which sits OUTSIDE this custom
    middleware — so for that specific path `call_next()` raises rather than
    returning, and code placed after a bare `await call_next(...)` never
    runs. Confirmed live: a 500 from `/ai/ocr` silently failed to increment
    the counter under the naive version of this middleware; a `NotImplementedYet`
    501 from `/ai/faces` did not, because `AIServiceError` subclasses are
    registered as ordinary handlers and stay inside `ExceptionMiddleware`,
    which IS inside this layer. `finally` counts both cases the same way."""
    counted = request.url.path.startswith("/ai/") and request.url.path != "/ai/stats"
    try:
        return await call_next(request)
    finally:
        if counted:
            request_stats.record_call()


@app.get("/health", response_model=HealthResult)
async def health() -> HealthResult:
    return HealthResult(status="ok", device=registry.device, models=registry.status())


@app.post("/ai/detect", response_model=DetectResult)
async def detect_endpoint(
    file: Optional[UploadFile] = File(None),
    prompts: str = Form(...),
) -> DetectResult:
    if file is None:
        raise InvalidInput("an image file is required")
    try:
        model, processor = registry.get("grounding_dino")
    except KeyError:
        raise ModelNotLoadedError(
            f"grounding_dino: {registry.status()['grounding_dino']}"
        )

    prompt_list = [p.strip() for p in prompts.split(",") if p.strip()]
    data = await file.read()
    results = run_detect(
        data,
        prompt_list,
        model,
        processor,
        registry.device,
        settings.DETECT_BOX_THRESHOLD,
        settings.DETECT_TEXT_THRESHOLD,
    )
    return DetectResult(
        detections=[Detection(**d) for d in results],
        provenance={"model": "grounding-dino-tiny", "version": registry.status()["grounding_dino"]},
    )


@app.post("/ai/faces", response_model=FacesResult)
async def faces(
    file: Optional[UploadFile] = File(None),
    references: list[UploadFile] = File(default=[]),
    reference_ids: str = Form(default=""),
) -> FacesResult:
    """Face detection, plus 1:N matching only against `references` — photos
    the caller supplies on THIS request. There is no persisted watchlist and
    no open/web identification anywhere in this endpoint; scope is entirely
    whatever the caller passes in, every call. `reference_ids` labels each
    reference photo (comma-separated, same order as `references`); a
    reference with no id falls back to `reference-<index>`. Detected faces
    with no reference set, or no match above the threshold, get a null
    matchId/matchScore — detection-only is a first-class result, not an
    error.
    """
    if file is None:
        raise InvalidInput("an image file is required")
    try:
        face_app = registry.get("insightface")
    except KeyError:
        raise ModelNotLoadedError(f"insightface: {registry.status()['insightface']}")

    data = await file.read()

    ids = [i.strip() for i in reference_ids.split(",") if i.strip()]
    ref_pairs = []
    for idx, ref_file in enumerate(references):
        label = ids[idx] if idx < len(ids) else f"reference-{idx}"
        ref_pairs.append((label, await ref_file.read()))

    results = run_faces(data, ref_pairs, face_app, settings.FACE_MATCH_THRESHOLD)
    return FacesResult(
        faces=[Face(**r) for r in results],
        provenance={"model": "insightface-buffalo_l", "version": registry.status()["insightface"]},
    )


@app.post("/ai/ocr", response_model=OcrResult)
async def ocr_endpoint(file: Optional[UploadFile] = File(None), langs: str = "eng") -> OcrResult:
    if file is None:
        raise InvalidInput("an image file is required")
    data = await file.read()
    result = run_ocr(data, langs)
    result["provenance"] = {"model": "tesseract", "version": str(pytesseract.get_tesseract_version())}
    return OcrResult(**result)


@app.post("/ai/ocr/vlm", response_model=OcrVlmResult)
async def ocr_vlm_endpoint(file: Optional[UploadFile] = File(None)) -> OcrVlmResult:
    """Scene-text OCR via Florence-2 — a sibling of /ai/ocr (Tesseract), not
    a replacement. See ocr_vlm.py's doc comment for when each is the right
    tool: Tesseract for a clean document/screenshot, this for text sharing
    the frame with a busy photo, which Tesseract structurally struggles
    with. Reuses the same florence2 model instance /ai/describe already
    loads — no extra GPU memory, no extra load time.
    """
    if file is None:
        raise InvalidInput("an image file is required")
    try:
        model, processor, torch_dtype = registry.get("florence2")
    except KeyError:
        raise ModelNotLoadedError(f"florence2: {registry.status()['florence2']}")

    data = await file.read()
    text = run_ocr_vlm(data, model, processor, registry.device, torch_dtype)
    return OcrVlmResult(
        text=text,
        provenance={"model": "florence-2-large", "version": registry.status()["florence2"]},
    )


@app.post("/ai/forensics", response_model=ForensicsResult)
async def forensics_endpoint(file: Optional[UploadFile] = File(None)) -> ForensicsResult:
    if file is None:
        raise InvalidInput("an image file is required")
    data = await file.read()
    return ForensicsResult(**run_forensics(data))


@app.post("/ai/phash/compare", response_model=PhashCompareResult)
async def phash_compare(
    image1: UploadFile = File(...), image2: UploadFile = File(...)
) -> PhashCompareResult:
    data1 = await image1.read()
    data2 = await image2.read()
    hash1 = compute_phash(data1)
    hash2 = compute_phash(data2)
    distance = hamming(hash1, hash2)
    return PhashCompareResult(hamming=distance, near_duplicate=distance <= 10)


@app.post("/ai/audio/events", response_model=AudioEventsResult)
async def audio_events_endpoint(file: Optional[UploadFile] = File(None)) -> AudioEventsResult:
    """Semantic sound-event classification (YAMNet) — see audio_events.py's
    doc comment for the honesty framing. This is the one action on /videos
    that sends audio off the browser to this service; the frontend gates it
    behind its own explicit consent control, same pattern as Sarvam
    transcription."""
    if file is None:
        raise InvalidInput("a WAV audio file is required")
    try:
        session, class_names = registry.get("yamnet")
    except KeyError:
        raise ModelNotLoadedError(f"yamnet: {registry.status()['yamnet']}")

    data = await file.read()
    result = run_classify_audio(
        data, session, class_names, settings.AUDIO_EVENT_REPORT_THRESHOLD, settings.AUDIO_EVENT_REVIEW_THRESHOLD
    )
    return AudioEventsResult(
        events=[AudioEvent(**e) for e in result["events"]],
        coverage=AudioEventsCoverage(**result["coverage"]),
        closest_below_threshold=[ClosestMatch(**c) for c in result["closest_below_threshold"]],
        provenance={"model": "yamnet", "version": registry.status()["yamnet"]},
    )


@app.post("/ai/video")
async def video(file: Optional[UploadFile] = File(None)):
    raise NotImplementedYet("video analysis is not implemented in this phase")


@app.post("/ai/transcribe")
async def transcribe(file: Optional[UploadFile] = File(None)):
    raise NotImplementedYet("transcription is not implemented in this phase")


@app.post("/ai/translate")
async def translate(body: TranslateRequest):
    raise NotImplementedYet("translation is not implemented in this phase")


@app.post("/ai/describe", response_model=DescribeResult)
async def describe(file: Optional[UploadFile] = File(None)) -> DescribeResult:
    if file is None:
        raise InvalidInput("an image file is required")
    try:
        model, processor, torch_dtype = registry.get("florence2")
    except KeyError:
        raise ModelNotLoadedError(f"florence2: {registry.status()['florence2']}")

    data = await file.read()
    text = run_describe(data, model, processor, registry.device, torch_dtype)
    return DescribeResult(
        description=text,
        provenance={"model": "florence-2-large", "version": registry.status()["florence2"]},
    )


@app.post("/ai/chat")
async def chat(body: ChatRequest):
    raise NotImplementedYet("chat is not implemented in this phase")


@app.get("/ai/stats", response_model=StatsResult)
async def stats() -> StatsResult:
    return StatsResult(**request_stats.snapshot())
