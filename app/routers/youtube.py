import datetime
from fastapi import APIRouter, HTTPException, status
from app.collectors.youtube import (
    YouTubeClient,
    VideoUnavailable,
    SubsUnavailable,
    DownloadFailed,
)
from app.schemas.youtube import (
    MetadataRequest,
    MetadataResponse,
    SubtitlesRequest,
    SubtitlesResponse,
    DownloadRequest,
    DownloadResponse,
    Provenance,
)

router = APIRouter(prefix="/osint/youtube", tags=["YouTube OSINT"])
client = YouTubeClient()


def get_provenance() -> Provenance:
    return Provenance(
        source="youtube",
        model="yt-dlp",
        fetchedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    )


@router.post("/metadata", response_model=MetadataResponse)
async def get_metadata_endpoint(req: MetadataRequest):
    """Fetch video metadata without downloading video stream."""
    try:
        data = client.get_metadata(req.url)
        return MetadataResponse(**data, provenance=get_provenance())
    except VideoUnavailable as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "VideoUnavailable", "cause": str(e)},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "MetadataExtractionFailed", "cause": str(e)},
        )


@router.post("/subtitles", response_model=SubtitlesResponse)
async def get_subtitles_endpoint(req: SubtitlesRequest):
    """Fetch and parse timestamped subtitle segments for a language."""
    try:
        data = client.get_subtitles(req.url, req.lang)
        return SubtitlesResponse(**data, provenance=get_provenance())
    except VideoUnavailable as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "VideoUnavailable", "cause": str(e)},
        )
    except SubsUnavailable as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "SubsUnavailable", "cause": str(e)},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "SubtitleExtractionFailed", "cause": str(e)},
        )


@router.post("/download", response_model=DownloadResponse)
async def download_endpoint(req: DownloadRequest):
    """Analyst-initiated download of video artifact for media analysis pipeline."""
    try:
        data = client.download(req.url, req.quality)
        return DownloadResponse(**data, provenance=get_provenance())
    except VideoUnavailable as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "VideoUnavailable", "cause": str(e)},
        )
    except DownloadFailed as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "DownloadFailed", "cause": str(e)},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "DownloadFailed", "cause": str(e)},
        )
