from typing import Optional

from pydantic import BaseModel


class Provenance(BaseModel):
    model: str
    version: str


class Detection(BaseModel):
    label: str
    score: float
    box: tuple[float, float, float, float]


class DetectResult(BaseModel):
    detections: list[Detection]
    provenance: Provenance


class Face(BaseModel):
    box: tuple[float, float, float, float]
    landmarks: list[tuple[float, float]]
    matchId: Optional[str] = None
    matchScore: Optional[float] = None


class FacesResult(BaseModel):
    faces: list[Face]
    provenance: Provenance


class OcrWord(BaseModel):
    text: str
    conf: float
    box: tuple[int, int, int, int]


class OcrResult(BaseModel):
    text: str
    words: list[OcrWord]
    langs: str
    provenance: Provenance


class ExifData(BaseModel):
    present: bool
    make: Optional[str] = None
    model: Optional[str] = None
    software: Optional[str] = None
    datetime_original: Optional[str] = None
    datetime_modified: Optional[str] = None
    timestamp_mismatch: Optional[bool] = None
    gps: Optional[list[float]] = None


class C2paData(BaseModel):
    present: bool
    status: Optional[str] = None
    valid: Optional[bool] = None
    ai_generated: Optional[bool] = None
    chain: Optional[list] = None


class ForensicsResult(BaseModel):
    exif: ExifData
    phash: str
    c2pa: C2paData
    notes: list[str]
    provenance: Provenance


class PhashCompareResult(BaseModel):
    hamming: int
    near_duplicate: bool


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str


class TranscribeResult(BaseModel):
    segments: list[TranscriptSegment]
    provenance: Provenance


class VideoResult(BaseModel):
    detections: list[Detection]
    provenance: Provenance


class TranslateRequest(BaseModel):
    text: str
    targetLanguage: str
    sourceLanguage: Optional[str] = None


class TranslateResult(BaseModel):
    text: str
    sourceLanguage: str
    targetLanguage: str
    provenance: Provenance


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


class DescribeResult(BaseModel):
    description: str
    provenance: Provenance


class OcrVlmResult(BaseModel):
    text: str
    provenance: Provenance


class ChatResult(BaseModel):
    reply: str
    provenance: Provenance


class AudioEvent(BaseModel):
    class_name: str
    start_time: float
    end_time: float
    # "model score", never "confidence" — YAMNet's outputs are independent,
    # uncalibrated per-class sigmoids, not a probability. See config.py.
    max_score: float
    mean_score: float
    frames_above_threshold: int
    frames_total: int
    hazard: bool


class AudioEventsCoverage(BaseModel):
    windows_analysed: int
    windows_with_any_class_above_threshold: int


class ClosestMatch(BaseModel):
    class_name: str
    max_score: float


class AudioEventsResult(BaseModel):
    events: list[AudioEvent]
    coverage: AudioEventsCoverage
    # The model's own real top candidates that never cleared REPORT_THRESHOLD
    # — real transparency for the common "nothing confident" case, not a
    # second, looser findings list. See audio_events.py's
    # _closest_below_threshold for what this is and isn't.
    closest_below_threshold: list[ClosestMatch]
    provenance: Provenance


class StatsResult(BaseModel):
    calls: int
    cache_hits: int


class HealthResult(BaseModel):
    status: str
    device: str
    models: dict[str, str]
