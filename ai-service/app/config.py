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

    def resolved_device(self) -> str:
        if self.DEVICE == "cpu":
            return "cpu"
        if torch is not None and torch.cuda.is_available():
            return "cuda"
        return "cpu"


settings = Settings()
