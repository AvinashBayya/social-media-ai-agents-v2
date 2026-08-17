from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.detect import detect
from app.errors import InvalidInput
from app.loaders import registry
from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@pytest.fixture(scope="module")
def gdino():
    registry.load()
    model, processor = registry.get("grounding_dino")
    return model, processor, registry.device


def test_detect_finds_known_objects_in_coco_image(gdino):
    model, processor, device = gdino
    data = _read("08_detect_cats_remote.jpg")
    results = detect(data, ["a cat", "a remote control"], model, processor, device, 0.35, 0.25)

    assert len(results) > 0
    labels = " ".join(r["label"] for r in results)
    assert "cat" in labels
    for r in results:
        assert 0.0 <= r["score"] <= 1.0
        assert len(r["box"]) == 4


def test_detect_requires_at_least_one_prompt(gdino):
    model, processor, device = gdino
    data = _read("08_detect_cats_remote.jpg")
    with pytest.raises(InvalidInput):
        detect(data, [], model, processor, device, 0.35, 0.25)


def test_detect_endpoint_returns_valid_response_matching_schema():
    with open(FIXTURES / "08_detect_cats_remote.jpg", "rb") as f:
        resp = client.post(
            "/ai/detect",
            files={"file": ("cats.jpg", f, "image/jpeg")},
            data={"prompts": "a cat, a remote control"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["detections"]) > 0
    assert body["provenance"]["model"] == "grounding-dino-tiny"


def test_detect_endpoint_rejects_missing_file():
    resp = client.post("/ai/detect", data={"prompts": "a cat"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "InvalidInput"


def test_detect_known_limitation_confident_false_positive_on_absent_object(gdino):
    """
    Characterization test, not a correctness assertion — this documents a real,
    verified model limitation rather than asserting desired behaviour.

    Grounding DINO (both `tiny` and `base`, A/B tested) does not reliably return
    "nothing found" for an object that isn't in the image: it reports the
    best-matching region and that match's confidence, which can clear the
    default threshold even when the described object is genuinely absent.
    Prompting this cat photo for "a dog"/"a car" returns a real detection.

    If a future model swap or threshold change makes this test start failing
    (i.e. the false positive disappears), that's good news — update this test
    to reflect it, and update the caveat in SKILLS.md/TASKS.md accordingly.
    Until then, any caller of /ai/detect must treat results as an unverified
    candidate match, never a confirmed finding.
    """
    model, processor, device = gdino
    data = _read("08_detect_cats_remote.jpg")
    results = detect(data, ["a dog", "a car"], model, processor, device, 0.35, 0.25)
    assert len(results) > 0, (
        "if this now returns zero detections, the known false-positive limitation "
        "may be resolved — verify and update the docs, don't just delete this test"
    )
