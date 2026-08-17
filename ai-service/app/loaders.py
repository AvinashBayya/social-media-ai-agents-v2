import logging
from pathlib import Path

import pytesseract

from app.config import settings

logger = logging.getLogger("ai-service.loaders")

STUB_MODEL_NAMES = ["grounding_dino", "insightface", "tesseract", "whisper", "llm"]

GROUNDING_DINO_DIR = "grounding-dino-tiny"


def _check_tesseract() -> str:
    try:
        version = pytesseract.get_tesseract_version()
        return f"loaded ({version})"
    except Exception as e:
        return f"unavailable: {e}"


def _load_grounding_dino(models_dir: str, device: str):
    """Loads from a local vendored directory only — never fetches from the
    network at runtime. Air-gap requirement: a model missing from models/ is
    reported as unavailable, not silently downloaded."""
    path = Path(models_dir) / GROUNDING_DINO_DIR
    if not path.is_dir():
        return None, f"unavailable: no vendored model at {path}"

    try:
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        processor = AutoProcessor.from_pretrained(str(path))
        model = AutoModelForZeroShotObjectDetection.from_pretrained(str(path)).to(device)
        model.eval()
        return (model, processor), f"loaded ({device})"
    except Exception as e:
        return None, f"unavailable: {e}"


class ModelRegistry:
    """Load-once model registry. Real engines register a status here as later
    phases wire them in; entries with no engine yet stay "not_loaded" stubs."""

    def __init__(self) -> None:
        self._status: dict[str, str] = {name: "not_loaded" for name in STUB_MODEL_NAMES}
        self._models: dict[str, object] = {}
        self.device = settings.resolved_device()

    def load(self) -> None:
        logger.info("Model registry init on device=%s (models dir=%s)", self.device, settings.MODELS_DIR)
        self._status["tesseract"] = _check_tesseract()

        gdino, gdino_status = _load_grounding_dino(settings.MODELS_DIR, self.device)
        self._status["grounding_dino"] = gdino_status
        if gdino is not None:
            self._models["grounding_dino"] = gdino

        for name in STUB_MODEL_NAMES:
            logger.info("Model '%s' status: %s", name, self._status[name])

    def get(self, name: str):
        if name not in self._models:
            raise KeyError(f"model '{name}' is not loaded")
        return self._models[name]

    def status(self) -> dict[str, str]:
        return dict(self._status)


registry = ModelRegistry()
