from io import BytesIO

from PIL import Image, UnidentifiedImageError

from app.errors import InvalidInput

# Florence-2's dedicated OCR task — a different task token from describe.py's
# <MORE_DETAILED_CAPTION>, not a repurposing of it. <MORE_DETAILED_CAPTION>
# happens to mention prominent text while captioning a scene; <OCR> is what
# the model was actually trained to do for "read every word in this image",
# and is the right tool when that is literally the ask, the same way this
# project already picked Grounding DINO over a captioning model for object
# detection. <OCR_WITH_REGION> (adds per-word bounding quads) is a documented
# possible extension, not implemented here — this endpoint answers "what
# does the text say", not "where is each word".
TASK_PROMPT = "<OCR>"


def ocr_vlm(
    data: bytes,
    model,
    processor,
    device: str,
    torch_dtype,
) -> str:
    """Scene-text OCR via Florence-2 — complements, not replaces, the
    Tesseract-based `/ai/ocr`. Tesseract's connected-component/layout
    analysis is the right tool for a clean, mostly-text image (a scanned
    document, a screenshot of plain text) and needs no GPU; it structurally
    struggles when legible text shares the frame with a busy photographic
    background — verified live 2026-08-20, a real composition of that kind
    returned near-total garbage (confidence ~33, no real words recovered)
    from Tesseract even with page-segmentation tuned for scattered text.
    Florence-2, trained on large-scale real-world image-text data rather
    than document layout heuristics, is the tool for that harder case.

    `model`/`processor` are injected rather than loaded here, same reasoning
    as describe.py/detect.py: expensive to construct, loaded once by the
    model registry, and this keeps the function testable without booting
    FastAPI.
    """
    try:
        image = Image.open(BytesIO(data)).convert("RGB")
    except UnidentifiedImageError as e:
        raise InvalidInput(f"could not read image: {e}")

    import torch

    inputs = processor(text=TASK_PROMPT, images=image, return_tensors="pt")
    inputs = {k: v.to(device=device, dtype=torch_dtype) if v.dtype.is_floating_point else v.to(device)
              for k, v in inputs.items()}

    with torch.no_grad():
        generated_ids = model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=1024,
            num_beams=3,
            do_sample=False,
        )

    generated_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    parsed = processor.post_process_generation(
        generated_text, task=TASK_PROMPT, image_size=(image.width, image.height)
    )
    return parsed[TASK_PROMPT]
