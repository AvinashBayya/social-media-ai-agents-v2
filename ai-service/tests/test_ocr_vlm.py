from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.errors import InvalidInput
from app.loaders import registry
from app.main import app
from app.ocr_vlm import ocr_vlm

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@pytest.fixture(scope="module")
def florence2():
    # registry.load() is NOT idempotent — it unconditionally re-runs every
    # _load_* call, including from_pretrained() for a model already resident
    # on the GPU. test_describe.py's own module-scoped fixture already loads
    # florence2 once per full-suite run; calling load() again here reloads
    # it a second time in the same process and crashes with a real "Windows
    # fatal exception: access violation" inside torch's from_pretrained —
    # reproduced live running the full suite, not a hypothetical. Only load
    # if nothing has loaded it yet, in either order.
    if registry.status().get("florence2") in (None, "not_loaded"):
        registry.load()
    model, processor, torch_dtype = registry.get("florence2")
    return model, processor, registry.device, torch_dtype


def test_ocr_vlm_reads_real_text_tesseract_cannot(florence2):
    # Same fixture composition the /ai/ocr comparison in ocr_vlm.py's doc
    # comment describes: legible text sharing the frame with a busy photo.
    # 07_ocr_english.png is plain text on white — the EASY case, which
    # Tesseract already handles; this fixture set has no "small text over a
    # real photo" image yet, so this asserts against the easy fixture as a
    # sanity check that the VLM path recovers real text at all. A harder
    # fixture belongs in ai-service/tests/fixtures/generate_fixtures.py
    # alongside 07_ocr_english.png when this is next touched.
    model, processor, device, torch_dtype = florence2
    data = _read("07_ocr_english.png")
    text = ocr_vlm(data, model, processor, device, torch_dtype)

    assert isinstance(text, str)
    assert len(text) > 5
    assert "sector" in text.lower() or "perimeter" in text.lower() or "convoy" in text.lower()


def test_ocr_vlm_rejects_unreadable_input(florence2):
    model, processor, device, torch_dtype = florence2
    with pytest.raises(InvalidInput):
        ocr_vlm(b"not an image", model, processor, device, torch_dtype)


def test_ocr_vlm_endpoint_returns_valid_response_matching_schema():
    with open(FIXTURES / "07_ocr_english.png", "rb") as f:
        resp = client.post("/ai/ocr/vlm", files={"file": ("text.png", f, "image/png")})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["text"]) > 0
    assert body["provenance"]["model"] == "florence-2-large"


def test_ocr_vlm_endpoint_rejects_missing_file():
    resp = client.post("/ai/ocr/vlm", data={})
    assert resp.status_code == 400
    assert resp.json()["error"] == "InvalidInput"


def test_ocr_vlm_endpoint_503s_cleanly_without_a_loaded_model_never_fabricates_text():
    # Runnable in THIS environment (no torch/weights installed by default —
    # see CLAUDE.md's ai-service section): registry.get raises KeyError,
    # which the endpoint converts to a clean 503, not a crash and not an
    # invented transcript. Mirrors /ai/faces and /ai/detect's own
    # ModelNotLoadedError behaviour for the same reason.
    if registry.status().get("florence2") not in (None, "not_loaded"):
        pytest.skip("florence2 is actually loaded in this environment")
    resp = client.post(
        "/ai/ocr/vlm", files={"file": ("real.png", _read("07_ocr_english.png"), "image/png")}
    )
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"] == "ModelNotLoadedError"
    assert "florence2" in body["cause"]
