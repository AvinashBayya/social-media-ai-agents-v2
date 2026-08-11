import os
from pathlib import Path

# Directory configuration for YouTube downloads from environment variable
BASE_DIR = Path(__file__).resolve().parent.parent
YT_DOWNLOAD_DIR_STR = os.getenv("YT_DOWNLOAD_DIR", str(BASE_DIR / "data" / "youtube_downloads"))
YT_DOWNLOAD_DIR = Path(YT_DOWNLOAD_DIR_STR)

# Ensure directory exists on startup
YT_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
