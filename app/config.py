import os
from pathlib import Path

# Directory configuration for YouTube downloads from environment variable
BASE_DIR = Path(__file__).resolve().parent.parent
YT_DOWNLOAD_DIR_STR = os.getenv("YT_DOWNLOAD_DIR", str(BASE_DIR / "data" / "youtube_downloads"))
YT_DOWNLOAD_DIR = Path(YT_DOWNLOAD_DIR_STR)

# Ensure directory exists on startup
YT_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Locate ffmpeg — prefer env override, then imageio-ffmpeg bundled binary, then PATH
_FFMPEG_PATH_ENV = os.getenv("FFMPEG_PATH", "")
if _FFMPEG_PATH_ENV and Path(_FFMPEG_PATH_ENV).exists():
    FFMPEG_PATH: str = _FFMPEG_PATH_ENV
else:
    try:
        import imageio_ffmpeg  # type: ignore
        FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        FFMPEG_PATH = "ffmpeg"   # fall back to system PATH
