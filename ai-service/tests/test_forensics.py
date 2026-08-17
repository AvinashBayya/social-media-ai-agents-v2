from pathlib import Path

from fastapi.testclient import TestClient

from app.forensics import compute_phash, forensics, hamming, read_c2pa, read_exif
from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)


def _read(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def test_exif_gps_and_editing_trace():
    exif = read_exif(_read("01_exif_gps.jpg"))
    assert exif["present"] is True
    assert exif["gps"] is not None
    lat, lon = exif["gps"]
    assert abs(lat - 28.6129) < 0.001
    assert abs(lon - 77.2295) < 0.001
    assert "Photoshop" in exif["software"]


def test_exif_stripped_is_absent_not_tampering():
    exif = read_exif(_read("02_exif_stripped.jpg"))
    assert exif["present"] is False

    result = forensics(_read("02_exif_stripped.jpg"))
    assert any("not evidence of manipulation" in note for note in result["notes"])


def test_exif_timestamp_mismatch():
    exif = read_exif(_read("03_timestamp_mismatch.jpg"))
    assert exif["timestamp_mismatch"] is True
    assert exif["datetime_original"].startswith("2019")
    assert exif["datetime_modified"].startswith("2026")


def test_phash_near_duplicate_vs_different():
    h_original = compute_phash(_read("04_phash_original.jpg"))
    h_resized = compute_phash(_read("05_phash_resized_recompressed.jpg"))
    h_different = compute_phash(_read("06_phash_different.jpg"))

    assert len(h_original) == 64
    assert hamming(h_original, h_resized) <= 10
    assert hamming(h_original, h_different) > 10


def test_c2pa_reports_honest_absence_never_fakes_a_result():
    result = read_c2pa(_read("01_exif_gps.jpg"))
    assert result["present"] is False
    assert result["status"] in ("no_manifest", "reader_unavailable")


def test_forensics_composes_all_fields_with_provenance():
    result = forensics(_read("01_exif_gps.jpg"))
    assert result["exif"]["present"] is True
    assert len(result["phash"]) == 64
    assert "present" in result["c2pa"]
    assert result["provenance"]["model"] == "forensics"


def test_forensics_endpoint_returns_valid_response_matching_schema():
    with open(FIXTURES / "01_exif_gps.jpg", "rb") as f:
        resp = client.post("/ai/forensics", files={"file": ("01.jpg", f, "image/jpeg")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["exif"]["gps"] == [28.6129, 77.2295]


def test_phash_compare_endpoint():
    with open(FIXTURES / "04_phash_original.jpg", "rb") as f1, open(
        FIXTURES / "06_phash_different.jpg", "rb"
    ) as f2:
        resp = client.post(
            "/ai/phash/compare",
            files={
                "image1": ("04.jpg", f1, "image/jpeg"),
                "image2": ("06.jpg", f2, "image/jpeg"),
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["near_duplicate"] is False
    assert body["hamming"] > 10
