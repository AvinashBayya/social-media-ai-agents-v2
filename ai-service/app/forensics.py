import json
from io import BytesIO

import numpy as np
import piexif
from PIL import Image, UnidentifiedImageError
from scipy.fftpack import dct

from app.errors import InvalidInput

try:
    import c2pa
except ImportError:
    c2pa = None


def _rational_to_float(rational: tuple[int, int]) -> float:
    numerator, denominator = rational
    return numerator / denominator if denominator else 0.0


def _dms_to_decimal(dms: tuple, ref) -> float:
    degrees, minutes, seconds = (_rational_to_float(v) for v in dms)
    value = degrees + minutes / 60.0 + seconds / 3600.0
    if ref in (b"S", b"W", "S", "W"):
        value = -value
    return value


def _decode(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode(errors="replace").rstrip("\x00").strip() or None
    return str(value).strip() or None


def read_exif(data: bytes) -> dict:
    try:
        exif_dict = piexif.load(data)
    except Exception:
        return {"present": False}

    zeroth = exif_dict.get("0th", {})
    exif = exif_dict.get("Exif", {})
    gps = exif_dict.get("GPS", {})

    if not zeroth and not exif and not gps:
        return {"present": False}

    make = _decode(zeroth.get(piexif.ImageIFD.Make))
    model = _decode(zeroth.get(piexif.ImageIFD.Model))
    software = _decode(zeroth.get(piexif.ImageIFD.Software))
    datetime_original = _decode(exif.get(piexif.ExifIFD.DateTimeOriginal))
    datetime_modified = _decode(zeroth.get(piexif.ImageIFD.DateTime))

    timestamp_mismatch = bool(
        datetime_original and datetime_modified and datetime_original != datetime_modified
    )

    gps_coords = None
    lat, lat_ref = gps.get(piexif.GPSIFD.GPSLatitude), gps.get(piexif.GPSIFD.GPSLatitudeRef)
    lon, lon_ref = gps.get(piexif.GPSIFD.GPSLongitude), gps.get(piexif.GPSIFD.GPSLongitudeRef)
    if lat and lon and lat_ref and lon_ref:
        gps_coords = [_dms_to_decimal(lat, lat_ref), _dms_to_decimal(lon, lon_ref)]

    return {
        "present": True,
        "make": make,
        "model": model,
        "software": software,
        "datetime_original": datetime_original,
        "datetime_modified": datetime_modified,
        "timestamp_mismatch": timestamp_mismatch,
        "gps": gps_coords,
    }


def compute_phash(data: bytes, hash_size: int = 8, img_size: int = 32) -> str:
    try:
        img = Image.open(BytesIO(data)).convert("L")
    except UnidentifiedImageError as e:
        raise InvalidInput(f"could not read image: {e}")
    img = img.resize((img_size, img_size), Image.LANCZOS)
    pixels = np.asarray(img, dtype=np.float64)
    coeffs = dct(dct(pixels, axis=0, norm="ortho"), axis=1, norm="ortho")
    block = coeffs[:hash_size, :hash_size].flatten()
    median = np.median(np.delete(block, 0))
    return "".join("1" if v > median else "0" for v in block)


def hamming(a: str, b: str) -> int:
    if len(a) != len(b):
        raise ValueError(f"hash length mismatch: {len(a)} vs {len(b)}")
    return sum(x != y for x, y in zip(a, b))


_AI_GENERATED_SOURCE_TYPES = {
    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
    "https://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    "https://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
}


def _detect_ai_generated(active_manifest: dict) -> bool | None:
    assertions = active_manifest.get("assertions", [])
    found_actions = False
    for assertion in assertions:
        if assertion.get("label") != "c2pa.actions":
            continue
        for action in assertion.get("data", {}).get("actions", []):
            found_actions = True
            if action.get("digitalSourceType") in _AI_GENERATED_SOURCE_TYPES:
                return True
    return False if found_actions else None


def read_c2pa(data: bytes) -> dict:
    if c2pa is None:
        return {"present": False, "status": "reader_unavailable"}

    try:
        with c2pa.Reader(stream=BytesIO(data)) as reader:
            manifest_json = json.loads(reader.json())
    except c2pa.C2paError.ManifestNotFound:
        return {"present": False, "status": "no_manifest"}
    except c2pa.C2paError as e:
        return {"present": False, "status": f"reader_error: {e}"}

    active_label = manifest_json.get("active_manifest")
    manifests = manifest_json.get("manifests", {})
    active_manifest = manifests.get(active_label, {}) if active_label else {}

    validation_state = manifest_json.get("validation_state")
    if validation_state is not None:
        valid = validation_state == "Valid"
    else:
        statuses = manifest_json.get("validation_status", [])
        valid = not any(s.get("code", "").lower().startswith("error") for s in statuses)

    chain = [
        {"title": ing.get("title"), "relationship": ing.get("relationship")}
        for ing in active_manifest.get("ingredients", [])
    ]

    return {
        "present": True,
        "status": "manifest_found",
        "valid": valid,
        "ai_generated": _detect_ai_generated(active_manifest),
        "chain": chain,
    }


def forensics(data: bytes) -> dict:
    exif = read_exif(data)
    phash = compute_phash(data)
    c2pa_result = read_c2pa(data)

    notes = []
    if not exif.get("present"):
        notes.append(
            "EXIF absent — not evidence of manipulation; most platforms strip EXIF on upload."
        )
    if exif.get("timestamp_mismatch"):
        notes.append(
            "EXIF DateTimeOriginal and DateTime (modified) differ — possible post-capture edit."
        )
    if exif.get("software"):
        notes.append(f"EXIF Software tag present ({exif['software']}) — editing trace.")

    return {
        "exif": exif,
        "phash": phash,
        "c2pa": c2pa_result,
        "notes": notes,
        "provenance": {"model": "forensics", "version": "0.1.0"},
    }
