from io import BytesIO

import pytesseract
from PIL import Image, UnidentifiedImageError
from pytesseract import Output

from app.errors import InvalidInput, UpstreamError


def ocr(data: bytes, langs: str = "eng") -> dict:
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except UnidentifiedImageError as e:
        raise InvalidInput(f"could not read image: {e}")

    try:
        result = pytesseract.image_to_data(img, lang=langs, output_type=Output.DICT)
    except pytesseract.TesseractError as e:
        raise UpstreamError(f"tesseract OCR failed for langs={langs!r}: {e}")

    words = []
    texts = []
    for i in range(len(result["text"])):
        text = result["text"][i].strip()
        try:
            conf = float(result["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if not text or conf < 0:
            continue
        words.append(
            {
                "text": text,
                "conf": conf,
                "box": [result["left"][i], result["top"][i], result["width"][i], result["height"][i]],
            }
        )
        texts.append(text)

    return {"text": " ".join(texts), "words": words, "langs": langs}
