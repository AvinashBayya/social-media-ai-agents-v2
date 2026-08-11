from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.collectors.youtube import VideoUnavailable, SubsUnavailable, DownloadFailed
from app.routers.youtube import router as youtube_router

app = FastAPI(
    title="Sentinel AI - OSINT & Video Collector API",
    description="Python FastAPI backend providing YouTube ingestion, metadata extraction, subtitles, and video artifact downloading.",
    version="1.0.0",
)

# Enable CORS for local development and containerized web frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global custom exception handlers ensuring typed error responses {error, cause}
@app.exception_handler(VideoUnavailable)
async def video_unavailable_handler(request: Request, exc: VideoUnavailable):
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"error": "VideoUnavailable", "cause": str(exc)},
    )

@app.exception_handler(SubsUnavailable)
async def subs_unavailable_handler(request: Request, exc: SubsUnavailable):
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content={"error": "SubsUnavailable", "cause": str(exc)},
    )

@app.exception_handler(DownloadFailed)
async def download_failed_handler(request: Request, exc: DownloadFailed):
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"error": "DownloadFailed", "cause": str(exc)},
    )

# Include routers
app.include_router(youtube_router)

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "sentinel-fastapi-backend"}
