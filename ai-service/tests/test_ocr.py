from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.errors import UpstreamError
from app.main import app
from app.ocr import ocr

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def test_ocr_english_extracts_expected_text_and_real_confidences():
    result = ocr(_read("07_ocr_english.png"), "eng")
    assert "SECTOR 7 PERIMETER LOG" in result["text"]
    assert "Convoy departed" in result["text"]
    assert result["langs"] == "eng"
    assert len(result["words"]) > 0
    for word in result["words"]:
        assert 0 <= word["conf"] <= 100
        assert len(word["box"]) == 4


def test_ocr_missing_language_pack_raises_instead_of_fabricating():
    # "kan" (Kannada) is not installed in this environment (eng/hin/tam only) —
    # the engine must fail loudly, never silently fall back to English text.
    with pytest.raises(UpstreamError):
        ocr(_read("07_ocr_english.png"), "kan")


def test_ocr_endpoint_returns_valid_response_matching_schema():
    # Exercises the real HTTP path (not just the pure function) so a schema
    # mismatch between run_ocr()'s dict and OcrResult is caught here, not in prod.
    with open(FIXTURES / "07_ocr_english.png", "rb") as f:
        resp = client.post("/ai/ocr", files={"file": ("07.png", f, "image/png")})
    assert resp.status_code == 200
    body = resp.json()
    assert "SECTOR 7 PERIMETER LOG" in body["text"]
    assert body["provenance"]["model"]
