import logging
from pathlib import Path

import pytesseract

from app.config import settings

logger = logging.getLogger("ai-service.loaders")

# "florence2"/"yamnet" are additions to the original stub plan — neither
# image captioning nor audio event classification were among the five
# originally-stubbed models, but /ai/describe and /ai/audio/events needed a
# real local engine same as the others.
STUB_MODEL_NAMES = ["grounding_dino", "insightface", "florence2", "yamnet", "tesseract", "whisper", "llm"]

GROUNDING_DINO_DIR = "grounding-dino-tiny"
FLORENCE2_DIR = "florence-2-large"
YAMNET_DIR = "yamnet"
# insightface's own FaceAnalysis(root=...) convention: the pack lives at
# root/models/<name>, e.g. models/insightface/models/buffalo_l. Vendored
# once via its own one-time download (see project notes); this loader
# checks the resulting directory exists before ever calling FaceAnalysis,
# same air-gap guarantee as grounding_dino — a missing pack is reported as
# unavailable, never triggers a live fetch.
INSIGHTFACE_ROOT = "insightface"
INSIGHTFACE_PACK = "buffalo_l"


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


def _load_florence2(models_dir: str, device: str):
    """Same vendored-directory-only rule as grounding_dino. Loaded in
    float16 on CUDA to fit the 4GB budget this project's target hardware
    (GTX 1650) sets; float32 on CPU, where float16 kernels are frequently
    unsupported or slower. `attn_implementation="sdpa"` avoids a hard
    dependency on flash-attn, which has no prebuilt Windows wheel.
    Florence-2 ships custom modeling code (not a built-in transformers
    architecture), hence `trust_remote_code=True` — accepted here because
    the code is vendored from Microsoft's own repo and not fetched at
    request time, matching this project's other trust-remote-code-free
    models in spirit if not in the letter.
    """
    path = Path(models_dir) / FLORENCE2_DIR
    if not path.is_dir():
        return None, f"unavailable: no vendored model at {path}"

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        torch_dtype = torch.float16 if device == "cuda" else torch.float32
        processor = AutoProcessor.from_pretrained(str(path), trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            str(path),
            trust_remote_code=True,
            torch_dtype=torch_dtype,
            attn_implementation="sdpa",
        ).to(device)
        model.eval()
        return (model, processor, torch_dtype), f"loaded ({device}, {torch_dtype})"
    except Exception as e:
        return None, f"unavailable: {e}"


def _load_insightface(models_dir: str, device: str):
    path = Path(models_dir) / INSIGHTFACE_ROOT / "models" / INSIGHTFACE_PACK
    if not path.is_dir():
        return None, f"unavailable: no vendored model at {path}"

    try:
        from insightface.app import FaceAnalysis

        # CUDAExecutionProvider is requested but onnxruntime falls back to
        # CPU on its own (with a warning, not an exception) if the CUDA
        # runtime it needs isn't resolvable — verified live on this
        # project's dev hardware, where onnxruntime-gpu's CUDA EP could not
        # load despite torch's own CUDA path working fine (a real, torch-
        # vs-onnxruntime DLL-search-path mismatch, not a code bug). Face
        # detection/matching still work correctly on CPU, just slower.
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
        root = str(Path(models_dir) / INSIGHTFACE_ROOT)
        face_app = FaceAnalysis(name=INSIGHTFACE_PACK, root=root, providers=providers)
        ctx_id = 0 if device == "cuda" else -1
        face_app.prepare(ctx_id=ctx_id, det_size=(640, 640))
        applied = face_app.det_model.session.get_providers()[0]
        return face_app, f"loaded ({applied})"
    except Exception as e:
        return None, f"unavailable: {e}"


def _load_yamnet(models_dir: str):
    """Loads from a local vendored directory only — same air-gap guarantee
    as grounding_dino/florence2 above. See scripts/vendor_yamnet.py for how
    models/yamnet/{yamnet.onnx,yamnet_class_map.csv} are produced: a
    first-party ONNX conversion of Google's own official YAMNet weights,
    not a third-party re-upload.

    CPU-only by design, unlike the torch-based loaders above: YAMNet's own
    mel-spectrogram front-end is baked into the ONNX graph (no separate
    feature-extraction dependency needed), inference is ~15-25ms per 0.96s
    window even on CPU, and staying off the GPU avoids competing for VRAM
    with the torch-based models this same process may also be serving.
    """
    path = Path(models_dir) / YAMNET_DIR
    onnx_path = path / "yamnet.onnx"
    class_map_path = path / "yamnet_class_map.csv"
    if not onnx_path.is_file() or not class_map_path.is_file():
        return None, f"unavailable: no vendored model at {path}"

    try:
        import csv

        import onnxruntime as ort

        session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        with open(class_map_path, newline="") as f:
            reader = csv.reader(f)
            next(reader)  # header: index,mid,display_name
            class_names = [row[2] for row in reader]
        if len(class_names) != 521:
            return None, f"unavailable: class map has {len(class_names)} entries, expected 521"
        return (session, class_names), "loaded (cpu, onnxruntime)"
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
        """Load every real engine, but only the first time — genuinely
        "load-once", not just documented as such. Every caller (FastAPI's
        lifespan on real startup, and a `registry.load()` in several test
        fixtures' own setup, since a fixture can't assume some OTHER test
        module's fixture already ran first) is written as if calling this
        twice is harmless. It was not: `from_pretrained()` on a model
        already resident on the GPU is a real, reproduced crash — "Windows
        fatal exception: access violation" inside torch, triggered by
        running the full pytest suite once enough fixtures had each called
        `load()` on top of each other. `tesseract`'s status is cheap
        (a version check, not a model load) and stays unconditional.
        """
        logger.info("Model registry init on device=%s (models dir=%s)", self.device, settings.MODELS_DIR)
        self._status["tesseract"] = _check_tesseract()

        if "grounding_dino" not in self._models:
            gdino, gdino_status = _load_grounding_dino(settings.MODELS_DIR, self.device)
            self._status["grounding_dino"] = gdino_status
            if gdino is not None:
                self._models["grounding_dino"] = gdino

        if "florence2" not in self._models:
            florence2, florence2_status = _load_florence2(settings.MODELS_DIR, self.device)
            self._status["florence2"] = florence2_status
            if florence2 is not None:
                self._models["florence2"] = florence2

        if "insightface" not in self._models:
            insightface_app, insightface_status = _load_insightface(settings.MODELS_DIR, self.device)
            self._status["insightface"] = insightface_status
            if insightface_app is not None:
                self._models["insightface"] = insightface_app

        if "yamnet" not in self._models:
            yamnet, yamnet_status = _load_yamnet(settings.MODELS_DIR)
            self._status["yamnet"] = yamnet_status
            if yamnet is not None:
                self._models["yamnet"] = yamnet

        for name in STUB_MODEL_NAMES:
            logger.info("Model '%s' status: %s", name, self._status[name])

    def get(self, name: str):
        if name not in self._models:
            raise KeyError(f"model '{name}' is not loaded")
        return self._models[name]

    def status(self) -> dict[str, str]:
        return dict(self._status)


registry = ModelRegistry()
