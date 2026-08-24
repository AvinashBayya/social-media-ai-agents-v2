from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.errors import InvalidInput
from app.faces import detect_and_match
from app.loaders import registry
from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@pytest.fixture(scope="module")
def face_app():
    registry.load()
    return registry.get("insightface")


def test_detect_finds_all_known_faces_with_no_references(face_app):
    data = _read("09_faces_group.jpg")
    results = detect_and_match(data, [], face_app, 0.5)

    # 09_faces_group.jpg is insightface's own bundled multi-face sample
    # (t1.jpg) — six faces, a stable ground truth for this library version.
    assert len(results) == 6
    for r in results:
        assert len(r["box"]) == 4
        assert r["matchId"] is None
        assert r["matchScore"] is None


def test_matches_the_one_face_a_reference_photo_was_cropped_from(face_app):
    """10_face_reference.jpg is a crop of exactly one face out of
    09_faces_group.jpg. Matching should find that one face at high
    similarity and correctly reject the other five — this is the real
    1:N verification path the operator-supplied-reference-set scope
    depends on, not just "does detection run"."""
    data = _read("09_faces_group.jpg")
    reference = _read("10_face_reference.jpg")
    results = detect_and_match(data, [("subject-x", reference)], face_app, 0.5)

    matched = [r for r in results if r["matchId"] is not None]
    assert len(matched) == 1
    assert matched[0]["matchId"] == "subject-x"
    assert matched[0]["matchScore"] > 0.9

    unmatched = [r for r in results if r["matchId"] is None]
    assert len(unmatched) == 5


def test_reference_with_no_detectable_face_is_skipped_not_faked(face_app):
    data = _read("09_faces_group.jpg")
    blank_reference = _read("07_ocr_english.png")  # text on white, no face
    results = detect_and_match(data, [("nobody", blank_reference)], face_app, 0.5)

    assert len(results) == 6
    for r in results:
        assert r["matchId"] is None
        assert r["matchScore"] is None


def test_detect_and_match_rejects_unreadable_input(face_app):
    with pytest.raises(InvalidInput):
        detect_and_match(b"not an image", [], face_app, 0.5)


def test_faces_endpoint_detect_only_matches_schema():
    with open(FIXTURES / "09_faces_group.jpg", "rb") as f:
        resp = client.post("/ai/faces", files={"file": ("group.jpg", f, "image/jpeg")})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["faces"]) == 6
    assert body["provenance"]["model"] == "insightface-buffalo_l"


def test_faces_endpoint_with_reference_returns_one_match():
    with open(FIXTURES / "09_faces_group.jpg", "rb") as f, open(FIXTURES / "10_face_reference.jpg", "rb") as rf:
        resp = client.post(
            "/ai/faces",
            files=[("file", ("group.jpg", f, "image/jpeg")), ("references", ("ref.jpg", rf, "image/jpeg"))],
            data={"reference_ids": "subject-x"},
        )
    assert resp.status_code == 200
    body = resp.json()
    matched = [f for f in body["faces"] if f["matchId"] is not None]
    assert len(matched) == 1
    assert matched[0]["matchId"] == "subject-x"


def test_faces_endpoint_rejects_missing_file():
    resp = client.post("/ai/faces", data={})
    assert resp.status_code == 400
    assert resp.json()["error"] == "InvalidInput"
