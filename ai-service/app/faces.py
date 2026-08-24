from io import BytesIO

import numpy as np
from PIL import Image, UnidentifiedImageError

from app.errors import InvalidInput


def _read_bgr(data: bytes) -> np.ndarray:
    try:
        image = Image.open(BytesIO(data)).convert("RGB")
    except UnidentifiedImageError as e:
        raise InvalidInput(f"could not read image: {e}")
    return np.array(image)[:, :, ::-1].copy()  # RGB -> BGR, insightface's convention


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0.0:
        return 0.0
    return float(np.dot(a, b) / denom)


def detect_and_match(
    data: bytes,
    references: list[tuple[str, bytes]],
    face_app,
    match_threshold: float,
) -> list[dict]:
    """Detects faces in `data` and, only when `references` is non-empty,
    matches each detected face against that operator-supplied set via
    cosine similarity of ArcFace embeddings.

    This is 1:N verification against a small set the analyst uploads for a
    specific request — never a persisted watchlist, never open/web
    identification. Callers control scope entirely through what they pass
    as `references`; this function holds nothing between calls.

    A reference photo with no detectable face is skipped, not treated as a
    zero-similarity match target — a face that couldn't be read out of the
    reference image is a missing input, not evidence of "not this person".
    """
    img = _read_bgr(data)
    detected = face_app.get(img)

    reference_embeddings: list[tuple[str, np.ndarray]] = []
    for label, ref_bytes in references:
        ref_img = _read_bgr(ref_bytes)
        ref_faces = face_app.get(ref_img)
        if not ref_faces:
            continue
        largest = max(ref_faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        reference_embeddings.append((label, largest.embedding))

    results = []
    for f in detected:
        box = tuple(float(v) for v in f.bbox.tolist())
        landmarks = [(float(x), float(y)) for x, y in f.kps.tolist()] if f.kps is not None else []

        match_id = None
        match_score = None
        if reference_embeddings:
            best_label, best_score = None, -1.0
            for label, ref_emb in reference_embeddings:
                score = _cosine_similarity(f.embedding, ref_emb)
                if score > best_score:
                    best_label, best_score = label, score
            if best_score >= match_threshold:
                match_id, match_score = best_label, best_score

        results.append(
            {
                "box": box,
                "landmarks": landmarks,
                "matchId": match_id,
                "matchScore": match_score,
            }
        )
    return results
