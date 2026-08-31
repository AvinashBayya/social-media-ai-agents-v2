"""
Semantic sound-event classification via YAMNet (Google, Apache 2.0). See
scripts/vendor_yamnet.py for how the vendored ONNX model was produced.

Ships as a listening index, not a findings list — YAMNet's own published
balanced mAP on the AudioSet eval set is 0.306, genuinely modest, and the
honesty controls in this file exist because of that number, not despite it.
`session`/`class_names` are injected (never loaded here) so this module
stays importable and testable without booting FastAPI or the model
registry — the same convention as detect.py/ocr_vlm.py.

No confidence values, ever: YAMNet's outputs are independent, uncalibrated
per-class sigmoids, not a probability distribution, so every score here is
labelled "model score" and the two thresholds in config.py are a stated
reporting POLICY, not a measured cutoff.
"""

import io
import wave

import numpy as np

from app.errors import InvalidInput

PATCH_WINDOW_SECONDS = 0.96
PATCH_HOP_SECONDS = 0.48
EXPECTED_SAMPLE_RATE = 16000

# Real, verified AudioSet class strings (matched against yamnet_class_map.csv)
# with real bearing on hazard/distress detection. A hit against one of these
# gets an inline "confirm by listening" marker rather than being filtered
# out or in — impulsive real-world sounds (door slams, fireworks, clipping)
# are a documented confuser for exactly these classes, so a bare label here
# is never rendered as a confirmed finding.
HAZARD_CLASSES = frozenset(
    {
        "Gunshot, gunfire",
        "Machine gun",
        "Artillery fire",
        "Explosion",
        "Fireworks",
        "Crying, sobbing",
        "Screaming",
        "Siren",
        "Civil defense siren",
        "Fire alarm",
        "Smoke detector, smoke alarm",
        "Alarm",
        "Emergency vehicle",
        "Police car (siren)",
        "Ambulance (siren)",
        "Air horn, truck horn",
    }
)


def load_class_map(path: str) -> list[str]:
    """Reads the official AudioSet class map (CC BY-SA 4.0 — a separate,
    non-code-infecting licence from the Apache 2.0 model weights; the file
    ships unmodified and attributed, never regenerated or renamed)."""
    import csv

    with open(path, newline="") as f:
        reader = csv.reader(f)
        next(reader)  # header: index,mid,display_name
        return [row[2] for row in reader]


def read_wav_pcm16(data: bytes) -> tuple[np.ndarray, int]:
    """Parses a real WAV file — the browser always sends 16-bit PCM via
    encodeWavPcm16 (audio-extract-client.ts), the same encoder /videos'
    Sarvam transcription path already relies on. Multi-channel input is
    downmixed by averaging, an honest mono reduction, not a guess at which
    channel matters. Raises InvalidInput for anything unreadable rather
    than guessing a format."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            n_channels = w.getnchannels()
            sample_width = w.getsampwidth()
            sample_rate = w.getframerate()
            n_frames = w.getnframes()
            raw = w.readframes(n_frames)
    except (wave.Error, EOFError) as e:
        raise InvalidInput(f"could not read WAV audio: {e}")

    if sample_width != 2:
        raise InvalidInput(f"expected 16-bit PCM WAV audio, got {sample_width * 8}-bit")

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return samples, sample_rate


def frames_to_intervals(
    predictions: np.ndarray,
    class_names: list[str],
    report_threshold: float,
    review_threshold: float,
) -> list[dict]:
    """Pure: (num_patches, 521) sigmoid scores -> merged per-class intervals.

    Per class, groups consecutive REVIEW_THRESHOLD-crossing frames into one
    interval, bridging at most one gap frame — a real detection's score can
    dip below threshold for a single 0.48s window without the sound having
    actually stopped, and treating that as two separate events would
    over-count a single real occurrence the same way this project's audio
    onset detector was found to (see audio-frequency.ts's own history) — a
    genuinely separate re-occurrence more than one frame later still starts
    a new interval, never silently merged into a far-earlier one.

    An interval is only reported if it clears REPORT_THRESHOLD at least
    once; its recorded extent still runs the full REVIEW-gated span so a
    real fade-in/out isn't clipped at the stricter threshold.
    """
    num_patches, num_classes = predictions.shape
    intervals: list[dict] = []

    for c in range(num_classes):
        scores = predictions[:, c]
        above = scores >= review_threshold
        i = 0
        while i < num_patches:
            if not above[i]:
                i += 1
                continue
            start = i
            j = i
            gap_used = False
            while j + 1 < num_patches:
                if above[j + 1]:
                    j += 1
                    gap_used = False
                elif not gap_used:
                    gap_used = True
                    j += 1
                else:
                    break
            end = j
            frame_scores = scores[start : end + 1]
            frames_above_report = int((frame_scores >= report_threshold).sum())
            if frames_above_report > 0:
                class_name = class_names[c]
                intervals.append(
                    {
                        "class_name": class_name,
                        "start_time": start * PATCH_HOP_SECONDS,
                        "end_time": end * PATCH_HOP_SECONDS + PATCH_WINDOW_SECONDS,
                        "max_score": float(frame_scores.max()),
                        "mean_score": float(frame_scores.mean()),
                        "frames_above_threshold": frames_above_report,
                        "frames_total": end - start + 1,
                        "hazard": class_name in HAZARD_CLASSES,
                    }
                )
            i = end + 1

    intervals.sort(key=lambda iv: iv["start_time"])
    return intervals


def classify_audio(
    data: bytes,
    session,
    class_names: list[str],
    report_threshold: float,
    review_threshold: float,
) -> dict:
    """Runs real YAMNet inference over the whole clip in one pass (the
    model's own sliding-window framing is baked into the ONNX graph — see
    vendor_yamnet.py) and returns merged intervals plus real coverage
    numbers. Never returns "0 events" indistinguishable from "nothing was
    analysed" — coverage always reports how many windows were actually
    scored."""
    samples, sample_rate = read_wav_pcm16(data)
    if sample_rate != EXPECTED_SAMPLE_RATE:
        raise InvalidInput(
            f"expected {EXPECTED_SAMPLE_RATE}Hz audio, got {sample_rate}Hz — "
            "re-encode via encodeWavPcm16 (audio-extract-client.ts) first"
        )
    if samples.size == 0:
        raise InvalidInput("empty audio")

    input_name = session.get_inputs()[0].name
    predictions = session.run(None, {input_name: samples})[0]

    events = frames_to_intervals(predictions, class_names, report_threshold, review_threshold)
    windows_analysed = int(predictions.shape[0])
    windows_with_any_class = (
        int((predictions.max(axis=1) >= report_threshold).sum()) if windows_analysed else 0
    )

    return {
        "events": events,
        "coverage": {
            "windows_analysed": windows_analysed,
            "windows_with_any_class_above_threshold": windows_with_any_class,
        },
        "closest_below_threshold": _closest_below_threshold(predictions, class_names, events),
    }


CLOSEST_MATCH_COUNT = 5


def _closest_below_threshold(predictions: np.ndarray, class_names: list[str], events: list[dict]) -> list[dict]:
    """Real transparency for the common case where nothing clears
    REPORT_THRESHOLD: rather than a bare "0 events" a viewer can't tell
    apart from "nothing was even tried", surfaces the model's own actual
    top candidates — the same real scores computed above, just below the
    reporting bar. Never invents a class or a score; a class already
    reported as a real event is excluded so the two lists never overlap."""
    if predictions.shape[0] == 0:
        return []
    reported = {e["class_name"] for e in events}
    max_scores = predictions.max(axis=0)
    order = np.argsort(-max_scores)
    closest: list[dict] = []
    for idx in order:
        name = class_names[idx]
        if name in reported:
            continue
        score = float(max_scores[idx])
        if score <= 0:
            break
        closest.append({"class_name": name, "max_score": score})
        if len(closest) >= CLOSEST_MATCH_COUNT:
            break
    return closest
