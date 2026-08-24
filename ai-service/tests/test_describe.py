from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.describe import describe
from app.errors import InvalidInput
from app.loaders import registry
from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@pytest.fixture(scope="module")
def florence2():
    registry.load()
    model, processor, torch_dtype = registry.get("florence2")
    return model, processor, registry.device, torch_dtype


def test_describe_produces_a_real_caption_of_known_content(florence2):
    model, processor, device, torch_dtype = florence2
    data = _read("08_detect_cats_remote.jpg")
    text = describe(data, model, processor, device, torch_dtype)

    assert isinstance(text, str)
    assert len(text) > 20
    # The fixture is a real photo of cats and a remote control (same image
    # test_detect.py's known-objects test uses) — a genuine caption should
    # name at least one of them, not just produce arbitrary non-empty text.
    assert "cat" in text.lower() or "remote" in text.lower()


def test_describe_rejects_unreadable_input(florence2):
    model, processor, device, torch_dtype = florence2
    with pytest.raises(InvalidInput):
        describe(b"not an image", model, processor, device, torch_dtype)


def test_describe_endpoint_returns_valid_response_matching_schema():
    with open(FIXTURES / "08_detect_cats_remote.jpg", "rb") as f:
        resp = client.post("/ai/describe", files={"file": ("cats.jpg", f, "image/jpeg")})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["description"]) > 20
    assert body["provenance"]["model"] == "florence-2-large"


def test_describe_endpoint_rejects_missing_file():
    resp = client.post("/ai/describe", data={})
    assert resp.status_code == 400
    assert resp.json()["error"] == "InvalidInput"
