"""
Generates synthetic stand-in fixtures for tests/test_forensics.py and tests/test_ocr.py.

These are NOT the real m4-testkit assets (those don't exist in this repo yet) — they are
generated images engineered to match the ground-truth values the tests assert against
(same GPS coordinates, same "Photoshop" software trace, same timestamp mismatch, a real
near-duplicate/different pHash pair, and the same OCR text). Replace this directory's
outputs with the real m4-testkit files when available; this script documents exactly what
each fixture needs to satisfy so a real-file swap doesn't silently break the tests.

Run: python generate_fixtures.py  (from tests/fixtures/)
"""

import random
from pathlib import Path

import piexif
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent


def decimal_to_dms_rational(value: float) -> tuple:
    value = abs(value)
    degrees = int(value)
    minutes_full = (value - degrees) * 60
    minutes = int(minutes_full)
    seconds = round((minutes_full - minutes) * 60 * 100)
    return ((degrees, 1), (minutes, 1), (seconds, 100))


def make_01_exif_gps():
    img = Image.new("RGB", (400, 300), (120, 140, 160))
    d = ImageDraw.Draw(img)
    d.ellipse([50, 50, 350, 250], fill=(200, 80, 80))
    path = OUT / "01_exif_gps.jpg"
    img.save(path, "jpeg", quality=90)

    lat, lon = 28.6129, 77.2295
    gps_ifd = {
        piexif.GPSIFD.GPSLatitudeRef: "N",
        piexif.GPSIFD.GPSLatitude: decimal_to_dms_rational(lat),
        piexif.GPSIFD.GPSLongitudeRef: "E",
        piexif.GPSIFD.GPSLongitude: decimal_to_dms_rational(lon),
    }
    zeroth_ifd = {
        piexif.ImageIFD.Make: b"Canon",
        piexif.ImageIFD.Model: b"Canon EOS 5D",
        piexif.ImageIFD.Software: b"Adobe Photoshop 25.0",
        piexif.ImageIFD.DateTime: b"2024:03:15 10:30:00",
    }
    exif_ifd = {
        piexif.ExifIFD.DateTimeOriginal: b"2024:03:15 10:30:00",
    }
    exif_bytes = piexif.dump({"0th": zeroth_ifd, "Exif": exif_ifd, "GPS": gps_ifd, "1st": {}, "thumbnail": None})
    piexif.insert(exif_bytes, str(path))
    print(f"wrote {path}")


def make_02_exif_stripped():
    img = Image.new("RGB", (400, 300), (90, 160, 90))
    d = ImageDraw.Draw(img)
    d.rectangle([80, 80, 320, 220], fill=(60, 100, 200))
    path = OUT / "02_exif_stripped.jpg"
    img.save(path, "jpeg", quality=90)
    print(f"wrote {path} (no EXIF)")


def make_03_timestamp_mismatch():
    img = Image.new("RGB", (400, 300), (160, 120, 60))
    d = ImageDraw.Draw(img)
    d.polygon([(200, 40), (360, 260), (40, 260)], fill=(30, 30, 30))
    path = OUT / "03_timestamp_mismatch.jpg"
    img.save(path, "jpeg", quality=90)

    zeroth_ifd = {
        piexif.ImageIFD.Make: b"Nikon",
        piexif.ImageIFD.Model: b"Nikon D850",
        piexif.ImageIFD.DateTime: b"2026:01:10 09:15:00",
    }
    exif_ifd = {
        piexif.ExifIFD.DateTimeOriginal: b"2019:07:22 14:05:00",
    }
    exif_bytes = piexif.dump({"0th": zeroth_ifd, "Exif": exif_ifd, "GPS": {}, "1st": {}, "thumbnail": None})
    piexif.insert(exif_bytes, str(path))
    print(f"wrote {path}")


def make_phash_set():
    random.seed(42)
    base = Image.new("RGB", (512, 512))
    px = base.load()
    for y in range(512):
        for x in range(512):
            px[x, y] = (int(255 * x / 512), int(255 * y / 512), 128)
    d = ImageDraw.Draw(base)
    d.ellipse([120, 120, 392, 392], fill=(220, 30, 30))
    d.rectangle([200, 60, 312, 160], fill=(30, 200, 30))
    original_path = OUT / "04_phash_original.jpg"
    base.save(original_path, "jpeg", quality=92)
    print(f"wrote {original_path}")

    near_dup = base.resize((96, 96), Image.LANCZOS).resize((512, 512), Image.LANCZOS)
    near_dup_path = OUT / "05_phash_resized_recompressed.jpg"
    near_dup.save(near_dup_path, "jpeg", quality=45)
    print(f"wrote {near_dup_path}")

    diff = Image.new("RGB", (512, 512))
    px = diff.load()
    for y in range(512):
        for x in range(512):
            px[x, y] = (int(255 * (1 - x / 512)), int(255 * (1 - y / 512)), 40)
    d = ImageDraw.Draw(diff)
    d.rectangle([40, 40, 220, 470], fill=(10, 10, 220))
    d.polygon([(300, 480), (500, 480), (400, 60)], fill=(240, 240, 20))
    diff_path = OUT / "06_phash_different.jpg"
    diff.save(diff_path, "jpeg", quality=92)
    print(f"wrote {diff_path}")


def make_07_ocr_english():
    img = Image.new("RGB", (900, 300), (255, 255, 255))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 32)
    except OSError:
        font = ImageFont.load_default()
    d.text((30, 40), "SECTOR 7 PERIMETER LOG", fill=(0, 0, 0), font=font)
    d.text((30, 100), "Convoy departed at 04:15 local time.", fill=(0, 0, 0), font=font)
    d.text((30, 160), "All checkpoints reported clear.", fill=(0, 0, 0), font=font)
    path = OUT / "07_ocr_english.png"
    img.save(path, "png")
    print(f"wrote {path}")


if __name__ == "__main__":
    make_01_exif_gps()
    make_02_exif_stripped()
    make_03_timestamp_mismatch()
    make_phash_set()
    make_07_ocr_english()
