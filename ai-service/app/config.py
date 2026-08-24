import os

from pydantic_settings import BaseSettings, SettingsConfigDict

try:
    import torch
except ImportError:  # torch not installed yet in some tooling contexts
    torch = None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DEVICE: str = "auto"
    MODELS_DIR: str = "./models"
    LOG_LEVEL: str = "INFO"
    DETECT_BOX_THRESHOLD: float = 0.35
    DETECT_TEXT_THRESHOLD: float = 0.25
    FACE_MATCH_THRESHOLD: float = 0.5
    # Only needed when the system Tesseract install doesn't already carry the
    # languages OCR needs — see .env.example. pydantic-settings parses this
    # into the Settings object, not the real OS environment, so it does
    # nothing on its own: tesseract.exe (a subprocess pytesseract shells out
    # to) only sees real OS env vars. The os.environ assignment below is
    # what actually makes it reach the subprocess.
    TESSDATA_PREFIX: str = ""
    # Comma-separated origins allowed to call this service from a browser.
    # Defaults cover TanStack Start/Vite's own dev ports so the frontend
    # (VITE_AI_SERVICE_URL) works locally with no config; a real deployment
    # should set this to the actual frontend origin rather than widen it.
    CORS_ALLOW_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"

    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ALLOW_ORIGINS.split(",") if o.strip()]

    def resolved_device(self) -> str:
        if self.DEVICE == "cpu":
            return "cpu"
        if torch is not None and torch.cuda.is_available():
            return "cuda"
        return "cpu"


settings = Settings()

if settings.TESSDATA_PREFIX:
    os.environ["TESSDATA_PREFIX"] = settings.TESSDATA_PREFIX
