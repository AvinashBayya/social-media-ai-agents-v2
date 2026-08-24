from io import BytesIO

from PIL import Image, UnidentifiedImageError

from app.errors import InvalidInput

# Florence-2's task-prompt convention: the "prompt" is a literal task token,
# not free text. <MORE_DETAILED_CAPTION> is the richest of its three caption
# granularities (<CAPTION> / <DETAILED_CAPTION> / <MORE_DETAILED_CAPTION>) —
# the right default for an analyst reading a generated description, not a
# short alt-text-style tag.
TASK_PROMPT = "<MORE_DETAILED_CAPTION>"


def describe(
    data: bytes,
    model,
    processor,
    device: str,
    torch_dtype,
) -> str:
    """Image captioning via Florence-2.

    `model`/`processor` are injected rather than loaded here, same reasoning
    as `detect.py`: expensive to construct, loaded once by the model
    registry, and this keeps the function testable without booting FastAPI.
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
