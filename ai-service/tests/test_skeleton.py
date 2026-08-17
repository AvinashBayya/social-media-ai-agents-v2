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


def test_stats_reflects_real_calls_not_a_hardcoded_placeholder():
    # /ai/stats used to hardcode {"calls": 0, "cache_hits": 0} regardless of
    # actual usage. Asserts a delta, not an absolute value: TestClient shares
    # `app` (and its request-count singleton) across every test in this
    # module, so other tests already incremented it before this one runs.
    before = client.get("/ai/stats").json()["calls"]
    client.get("/health")  # not under /ai/ — must NOT count
    client.post("/ai/chat", json={"messages": [{"role": "user", "content": "hi"}]})  # 501 — must count
    after_one = client.get("/ai/stats").json()["calls"]  # checking stats itself must not count either
    assert after_one == before + 1


def test_stats_counts_a_call_even_when_it_fails_with_an_uncaught_exception():
    # The real bug this middleware needed a `finally` (not a bare
    # `await call_next(...)`) to fix: Starlette routes an `Exception`-class
    # handler (`unhandled_error_handler` in errors.py) into
    # `ServerErrorMiddleware`, which sits OUTSIDE custom `@app.middleware`
    # layers — so for a request that hits that specific path, `call_next()`
    # raises rather than returning, and counting code placed after a bare
    # `await` silently never ran. Confirmed live before this test existed:
    # a naive after-call_next version undercounted exactly this path.
    #
    # Real OCR against real image bytes reproduces it directly in an
    # environment with no system Tesseract (this one): TesseractNotFoundError
    # is not an AIServiceError subclass, so it is the uncaught-exception path,
    # not the ordinary 400/404 InvalidInput path the other OCR test covers.
    # Where Tesseract IS installed, this returns 200 instead — either way the
    # count must still go up by exactly one, which is what this asserts.
    #
    # A real running server (confirmed separately via a live curl request)
    # catches this and returns a clean 500 JSON envelope; TestClient's
    # default (raise_server_exceptions=True) instead re-raises it into the
    # test process, which is irrelevant to what's being checked here — a
    # local client opts out so the exception itself doesn't fail the test.
    local_client = TestClient(app, raise_server_exceptions=False)
    with open("tests/fixtures/07_ocr_english.png", "rb") as f:
        image_bytes = f.read()
    before = local_client.get("/ai/stats").json()["calls"]
    local_client.post("/ai/ocr", files={"file": ("real.png", image_bytes, "image/png")})
    after = local_client.get("/ai/stats").json()["calls"]
    assert after == before + 1
