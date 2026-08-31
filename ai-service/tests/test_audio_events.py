import io
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.audio_events import _closest_below_threshold, classify_audio, frames_to_intervals, read_wav_pcm16
from app.errors import InvalidInput
from app.loaders import registry
from app.main import app

client = TestClient(app)


def _make_wav(samples: np.ndarray, sample_rate: int = 16000, n_channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(n_channels)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        pcm16 = np.clip(samples * 32767, -32768, 32767).astype(np.int16)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


# ─── read_wav_pcm16 (pure, no model needed) ────────────────────────────────


def test_read_wav_pcm16_roundtrip():
    samples = np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32)
    data = _make_wav(samples)
    out_samples, sr = read_wav_pcm16(data)
    assert sr == 16000
    assert len(out_samples) == 5
    assert abs(out_samples[1] - 0.5) < 0.001
    assert abs(out_samples[2] - (-0.5)) < 0.001


def test_read_wav_pcm16_rejects_garbage_not_a_fabricated_result():
    with pytest.raises(InvalidInput):
        read_wav_pcm16(b"not a wav file at all")


def test_read_wav_pcm16_downmixes_stereo_honestly():
    # Left channel all +1.0, right channel all -1.0 — an honest average
    # downmix must land at exactly 0.0, not silently pick one channel.
    n = 4
    interleaved = np.empty(n * 2, dtype=np.float32)
    interleaved[0::2] = 1.0
    interleaved[1::2] = -1.0
    data = _make_wav(interleaved, n_channels=2)
    samples, sr = read_wav_pcm16(data)
    assert len(samples) == n
    assert np.allclose(samples, 0.0, atol=0.001)


# ─── frames_to_intervals (pure, synthetic score matrices, no model needed) ─


def test_frames_to_intervals_bridges_a_single_dip_frame():
    predictions = np.zeros((4, 2), dtype=np.float32)
    predictions[0, 0] = 0.6
    predictions[1, 0] = 0.6
    predictions[2, 0] = 0.1  # dips below review threshold for one frame
    predictions[3, 0] = 0.6
    intervals = frames_to_intervals(predictions, ["A", "B"], report_threshold=0.5, review_threshold=0.2)
    assert len(intervals) == 1
    assert intervals[0]["class_name"] == "A"
    assert intervals[0]["frames_total"] == 4


def test_frames_to_intervals_does_not_bridge_two_consecutive_gap_frames():
    predictions = np.zeros((5, 1), dtype=np.float32)
    predictions[0, 0] = 0.6
    predictions[1, 0] = 0.1
    predictions[2, 0] = 0.1
    predictions[3, 0] = 0.6
    intervals = frames_to_intervals(predictions, ["A"], report_threshold=0.5, review_threshold=0.2)
    assert len(intervals) == 2


def test_frames_to_intervals_requires_report_threshold_at_least_once():
    # Above REVIEW (0.2) throughout but never above REPORT (0.5) — a real
    # class this module still refuses to report, matching the stated policy.
    predictions = np.full((3, 1), 0.3, dtype=np.float32)
    intervals = frames_to_intervals(predictions, ["A"], report_threshold=0.5, review_threshold=0.2)
    assert intervals == []


def test_frames_to_intervals_below_review_threshold_never_reported():
    predictions = np.full((3, 1), 0.05, dtype=np.float32)
    intervals = frames_to_intervals(predictions, ["A"], report_threshold=0.5, review_threshold=0.2)
    assert intervals == []


def test_hazard_flag_set_from_the_real_hazard_class_set():
    predictions = np.full((2, 1), 0.9, dtype=np.float32)
    intervals = frames_to_intervals(predictions, ["Siren"], report_threshold=0.5, review_threshold=0.2)
    assert intervals[0]["hazard"] is True


def test_non_hazard_class_not_flagged():
    predictions = np.full((2, 1), 0.9, dtype=np.float32)
    intervals = frames_to_intervals(predictions, ["Speech"], report_threshold=0.5, review_threshold=0.2)
    assert intervals[0]["hazard"] is False


def test_closest_below_threshold_reports_real_top_scores_not_reported_classes():
    # class 0 clears the report threshold and is a real event; classes 1/2
    # are real but below-threshold candidates worth surfacing; class 3 has
    # zero score everywhere and must never appear (nothing to show).
    predictions = np.zeros((3, 4), dtype=np.float32)
    predictions[:, 0] = 0.9  # reported event
    predictions[:, 1] = 0.4
    predictions[:, 2] = 0.1
    class_names = ["Reported", "Wind", "Rustle", "Nothing"]
    events = frames_to_intervals(predictions, class_names, report_threshold=0.5, review_threshold=0.2)
    assert [e["class_name"] for e in events] == ["Reported"]

    closest = _closest_below_threshold(predictions, class_names, events)
    names = [c["class_name"] for c in closest]
    assert "Reported" not in names  # already a real event — not duplicated
    assert "Wind" in names
    assert "Nothing" not in names  # zero score everywhere — nothing real to show
    wind = next(c for c in closest if c["class_name"] == "Wind")
    assert wind["max_score"] == pytest.approx(0.4)


def test_closest_below_threshold_empty_when_all_scores_are_zero():
    predictions = np.zeros((3, 5), dtype=np.float32)
    closest = _closest_below_threshold(predictions, ["A", "B", "C", "D", "E"], [])
    assert closest == []


def test_interval_timing_uses_the_real_patch_hop_and_window():
    # A single frame at index 2: start = 2*0.48, end = 2*0.48 + 0.96.
    predictions = np.zeros((3, 1), dtype=np.float32)
    predictions[2, 0] = 0.9
    intervals = frames_to_intervals(predictions, ["A"], report_threshold=0.5, review_threshold=0.2)
    assert intervals[0]["start_time"] == pytest.approx(0.96)
    assert intervals[0]["end_time"] == pytest.approx(1.92)


# ─── Endpoint-level, against the real vendored model ───────────────────────


def test_audio_events_rejects_unreadable_audio_with_400_not_a_fabricated_result():
    resp = client.post("/ai/audio/events", files={"file": ("test.wav", b"not audio", "audio/wav")})
    assert resp.status_code in (400, 503)  # 400 if the model IS loaded, 503 if it's not vendored here
    body = resp.json()
    assert body["error"] in ("InvalidInput", "ModelNotLoadedError")
    assert "cause" in body


def test_audio_events_on_a_real_tone_returns_real_finite_scores():
    registry.load()
    status = registry.status()
    if "yamnet" not in status or not status["yamnet"].startswith("loaded"):
        pytest.skip(f"yamnet not vendored in this environment: {status.get('yamnet')}")

    sr = 16000
    t = np.arange(int(sr * 3.0), dtype=np.float32) / sr
    tone = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    data = _make_wav(tone, sample_rate=sr)

    resp = client.post("/ai/audio/events", files={"file": ("tone.wav", data, "audio/wav")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["coverage"]["windows_analysed"] > 0
    assert body["provenance"]["model"] == "yamnet"
    # No fabricated score — every event's score is a real finite number in
    # [0, 1], and hazard is a real boolean, never absent or invented.
    for event in body["events"]:
        assert 0.0 <= event["max_score"] <= 1.0
        assert 0.0 <= event["mean_score"] <= 1.0
        assert isinstance(event["hazard"], bool)


def test_audio_events_wrong_sample_rate_rejected_not_silently_resampled():
    registry.load()
    status = registry.status()
    if "yamnet" not in status or not status["yamnet"].startswith("loaded"):
        pytest.skip(f"yamnet not vendored in this environment: {status.get('yamnet')}")

    samples = np.zeros(44100, dtype=np.float32)
    data = _make_wav(samples, sample_rate=44100)
    resp = client.post("/ai/audio/events", files={"file": ("wrong-rate.wav", data, "audio/wav")})
    assert resp.status_code == 400
    assert "16000" in resp.json()["cause"] or "16kHz" in resp.json()["cause"]


def test_classify_audio_is_directly_callable_without_fastapi():
    # Pure/injectable convention, same as detect.py — testable without
    # booting FastAPI or the registry, given a session+class_names directly.
    registry.load()
    try:
        session, class_names = registry.get("yamnet")
    except KeyError:
        pytest.skip("yamnet not vendored in this environment")

    sr = 16000
    silence = np.zeros(int(sr * 2.0), dtype=np.float32)
    data = _make_wav(silence, sample_rate=sr)
    result = classify_audio(data, session, class_names, report_threshold=0.5, review_threshold=0.2)
    assert "events" in result and "coverage" in result
    assert result["coverage"]["windows_analysed"] > 0
