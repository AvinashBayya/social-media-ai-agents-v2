from io import BytesIO

from PIL import Image, UnidentifiedImageError

from app.errors import InvalidInput

# Grounding DINO's own convention: lowercase, each phrase ending in a period.
# Enforced here so callers don't have to remember it and a forgotten period
# doesn't silently return zero detections.
def _normalize_prompt(prompts: list[str]) -> str:
    parts = [p.strip().lower().rstrip(".") + "." for p in prompts if p.strip()]
    return " ".join(parts)


def _detect_one(image, prompt: str, model, processor, device: str, box_threshold: float, text_threshold: float):
    import torch

    text = _normalize_prompt([prompt])
    inputs = processor(images=image, text=text, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = model(**inputs)

    results = processor.post_process_grounded_object_detection(
        outputs,
        inputs.input_ids,
        box_threshold=box_threshold,
        text_threshold=text_threshold,
        target_sizes=[image.size[::-1]],
    )[0]

    detections = []
    for label, score, box in zip(results["labels"], results["scores"], results["boxes"]):
        x0, y0, x1, y1 = (float(v) for v in box.tolist())
        detections.append(
            {
                "label": label,
                "score": float(score),
                "box": (x0, y0, x1, y1),
            }
        )
    return detections


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

    Runs one forward pass PER PROMPT rather than joining every prompt into a
    single "a. b. c." string for one pass — the latter was the original
    implementation and is Grounding DINO's own documented multi-class
    convention, but verified live (2026-08-20) to corrupt results as prompt
    count grows: phrase-grounding confuses adjacent prompt boundaries, which
    both merges labels from different prompts into one garbled string (e.g.
    "a remote control a rifle") and silently drops individual detections
    that clear the threshold when run alone. Measured on a real fixture: "a
    flag" alone scored 0.46 (comfortably above a 0.25 text threshold) but
    was completely absent from a 4-prompt combined call's results. Splitting
    per-prompt costs roughly prompts-count extra forward passes (~3s each on
    this project's GPU) in exchange for not silently losing real detections
    — worth it since this endpoint is a deliberate, occasional analyst
    action, not a real-time path.
    """
    if not prompts:
        raise InvalidInput("at least one text prompt is required, e.g. ['rifle', 'vehicle']")

    try:
        image = Image.open(BytesIO(data)).convert("RGB")
    except UnidentifiedImageError as e:
        raise InvalidInput(f"could not read image: {e}")

    detections = []
    for prompt in prompts:
        detections.extend(_detect_one(image, prompt, model, processor, device, box_threshold, text_threshold))
    return detections
