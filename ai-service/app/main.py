import logging
from contextlib import asynccontextmanager
from typing import Optional

import pytesseract
from fastapi import FastAPI, File, Form, UploadFile

from app.config import settings
from app.detect import detect as run_detect
from app.errors import InvalidInput, ModelNotLoadedError, NotImplementedYet, register_exception_handlers
from app.forensics import compute_phash, forensics as run_forensics, hamming
from app.loaders import registry
from app.ocr import ocr as run_ocr
from app.schemas import (
    ChatRequest,
    Detection,
    DetectResult,
    ForensicsResult,
    HealthResult,
    OcrResult,
    PhashCompareResult,
    StatsResult,
    TranslateRequest,
)

logging.basicConfig(level=settings.LOG_LEVEL)
logger = logging.getLogger("ai-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry.load()
    logger.info("ai-service started on device=%s", registry.device)
    yield


app = FastAPI(title="Sentinel AI Service", lifespan=lifespan)
register_exception_handlers(app)


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


@app.post("/ai/faces")
async def faces(file: Optional[UploadFile] = File(None)):
    raise NotImplementedYet("face detection is not implemented in this phase")


@app.post("/ai/ocr", response_model=OcrResult)
async def ocr_endpoint(file: Optional[UploadFile] = File(None), langs: str = "eng") -> OcrResult:
    if file is None:
        raise InvalidInput("an image file is required")
    data = await file.read()
    result = run_ocr(data, langs)
    result["provenance"] = {"model": "tesseract", "version": str(pytesseract.get_tesseract_version())}
    return OcrResult(**result)


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


@app.post("/ai/video")
async def video(file: Optional[UploadFile] = File(None)):
    raise NotImplementedYet("video analysis is not implemented in this phase")


@app.post("/ai/transcribe")
async def transcribe(file: Optional[UploadFile] = File(None)):
    raise NotImplementedYet("transcription is not implemented in this phase")


@app.post("/ai/translate")
async def translate(body: TranslateRequest):
    raise NotImplementedYet("translation is not implemented in this phase")


@app.post("/ai/describe")
async def describe(file: Optional[UploadFile] = File(None)):
    raise NotImplementedYet("image description is not implemented in this phase")


@app.post("/ai/chat")
async def chat(body: ChatRequest):
    raise NotImplementedYet("chat is not implemented in this phase")


@app.get("/ai/stats", response_model=StatsResult)
async def stats() -> StatsResult:
    return StatsResult(calls=0, cache_hits=0)
