import pytest
from app.collectors.youtube import (
    YouTubeClient,
    VideoUnavailable,
    SubsUnavailable,
    validate_youtube_url,
    parse_vtt_timestamps,
)

def test_validate_youtube_url_valid():
    assert validate_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert validate_youtube_url("https://youtu.be/dQw4w9WgXcQ") == "https://youtu.be/dQw4w9WgXcQ"

def test_validate_youtube_url_invalid_domain():
    with pytest.raises(VideoUnavailable) as exc_info:
        validate_youtube_url("https://vimeo.com/12345678")
    assert "Only youtube.com and youtu.be" in str(exc_info.value)

def test_validate_youtube_url_empty():
    with pytest.raises(VideoUnavailable):
        validate_youtube_url("")

def test_parse_vtt_timestamps():
    vtt_sample = """WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.500
Hello and welcome to the OSINT investigation.

00:00:05.100 --> 00:00:09.800
<c>In this video we analyze</c> open source intelligence signals.
"""
    segments = parse_vtt_timestamps(vtt_sample)
    assert len(segments) == 2
    assert segments[0]["start"] == 1.0
    assert segments[0]["end"] == 4.5
    assert segments[0]["text"] == "Hello and welcome to the OSINT investigation."
    assert segments[1]["start"] == 5.1
    assert segments[1]["end"] == 9.8
    assert "open source intelligence signals" in segments[1]["text"]

def test_invalid_video_id_raises_video_unavailable():
    client = YouTubeClient()
    with pytest.raises(VideoUnavailable):
        client.get_metadata("https://www.youtube.com/watch?v=invalid_id_999999999")
