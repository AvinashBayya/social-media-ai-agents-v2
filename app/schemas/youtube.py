from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


class Provenance(BaseModel):
    source: str = "youtube"
    model: str = "yt-dlp"
    fetchedAt: str


class MetadataRequest(BaseModel):
    url: str = Field(..., description="YouTube video URL (youtube.com or youtu.be)")


class SubtitleLangInfo(BaseModel):
    code: str
    name: str
    isAuto: bool


class ThumbnailInfo(BaseModel):
    url: str
    width: Optional[int] = None
    height: Optional[int] = None


class MetadataResponse(BaseModel):
    id: str
    title: str
    description: str
    uploader: str
    channel_id: str
    upload_date: Optional[str] = None
    duration: Optional[int] = None
    view_count: Optional[int] = None
    thumbnails: List[ThumbnailInfo] = []
    webpage_url: str
    available_subtitles: List[SubtitleLangInfo] = []
    provenance: Provenance


class SubtitlesRequest(BaseModel):
    url: str = Field(..., description="YouTube video URL")
    lang: str = Field("en", description="Subtitle language code (e.g. en, es, hi)")


class SubtitleSegment(BaseModel):
    start: float = Field(..., description="Start timestamp in seconds")
    end: float = Field(..., description="End timestamp in seconds")
    text: str = Field(..., description="Segment transcript text")


class SubtitlesResponse(BaseModel):
    id: str
    lang: str
    isAuto: bool
    segments: List[SubtitleSegment]
    provenance: Provenance


class DownloadRequest(BaseModel):
    url: str = Field(..., description="YouTube video URL")
    quality: str = Field("720p", description="Requested maximum resolution (e.g. 720p, 1080p, 480p)")


class DownloadResponse(BaseModel):
    id: str
    path: str
    filesize: Optional[int] = None
    format: str
    provenance: Provenance


class ErrorResponse(BaseModel):
    error: str
    cause: str
