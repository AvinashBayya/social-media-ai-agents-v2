from io import BytesIO

from PIL import Image, UnidentifiedImageError

from app.errors import InvalidInput

# Grounding DINO's own convention: lowercase, each phrase ending in a period.
# Enforced here so callers don't have to remember it and a forgotten period
# doesn't silently return zero detections.
def _normalize_prompt(prompts: list[str]) -> str:
    parts = [p.strip().lower().rstrip(".") + "." for p in prompts if p.strip()]
    return " ".join(parts)


def detect(
    data: bytes,
    prompts: list[str],
    model,
    processor,
    device: str,
    box_threshold: float,
    text_threshold: float,
) -> list[dict]:
    """Zero-shot, open-vocabulary object detection.

    `model`/`processor` are injected rather than loaded here — they're expensive
    to construct and must be loaded once at startup by the model registry, never
    per request. Passing them in also keeps this function testable without
    booting FastAPI or the registry.
    """
    if not prompts:
        raise InvalidInput("at least one text prompt is required, e.g. ['rifle', 'vehicle']")

    try:
        image = Image.open(BytesIO(data)).convert("RGB")
    except UnidentifiedImageError as e:
        raise InvalidInput(f"could not read image: {e}")

    text = _normalize_prompt(prompts)

    import torch

    inputs = processor(images=image, text=text, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = model(**inputs)

    results = processor.post_process_grounded_object_detection(
        outputs,
        inputs.input_ids,
        threshold=box_threshold,
        text_threshold=text_threshold,
        target_sizes=[image.size[::-1]],
    )[0]

    detections = []
    for label, score, box in zip(results["text_labels"], results["scores"], results["boxes"]):
        x0, y0, x1, y1 = (float(v) for v in box.tolist())
        detections.append(
            {
                "label": label,
                "score": float(score),
                "box": (x0, y0, x1, y1),
            }
        )
    return detections
