from fastapi.testclient import TestClient

from app.loaders import registry
from app.main import app

client = TestClient(app)


def test_health_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert "device" in body
    assert body["device"] in ("cpu", "cuda")
    assert isinstance(body["models"], dict)
    # whisper has no engine wired in yet (Phase 4) — grounding_dino is real as of
    # Phase 2, so it's no longer a valid "still a stub" example.
    assert body["models"]["whisper"] == "not_loaded"


def test_detect_rejects_unreadable_image_with_400_not_a_fabricated_result():
    # /ai/detect is real as of Phase 2 — garbage bytes must fail loudly, not
    # return 501 (stale stub response) or a fabricated detection.
    registry.load()
    resp = client.post(
        "/ai/detect",
        files={"file": ("test.jpg", b"fake-bytes", "image/jpeg")},
        data={"prompts": "a cat"},
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"] == "InvalidInput"
    assert "cause" in body


def test_ocr_rejects_unreadable_image_with_400_not_a_fabricated_result():
    # /ai/ocr is real as of Phase 1 — garbage bytes must fail loudly, not return 501
    # (that would be a stale stub response) or fake OCR output.
    resp = client.post("/ai/ocr", files={"file": ("test.jpg", b"fake-bytes", "image/jpeg")})
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"] == "InvalidInput"
    assert "cause" in body


def test_chat_returns_501_with_error_envelope():
    resp = client.post("/ai/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 501
    body = resp.json()
    assert body["error"] == "NotImplementedYet"
    assert "cause" in body


def test_stats_placeholder():
    resp = client.get("/ai/stats")
    assert resp.status_code == 200
    assert resp.json() == {"calls": 0, "cache_hits": 0}
