import datetime
import json
import logging
import os
import re
from pathlib import Path
from urllib.parse import urlparse
from typing import Dict, Any, List, Optional, Tuple

import yt_dlp
from app.config import YT_DOWNLOAD_DIR, FFMPEG_PATH

# Set up logging for audit trails
logger = logging.getLogger("osint.youtube")
logger.setLevel(logging.INFO)
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))
    logger.addHandler(ch)


class VideoUnavailable(Exception):
    """Raised when a video is private, deleted, or URL is invalid."""
    pass


class SubsUnavailable(Exception):
    """Raised when subtitles/captions are missing for the requested video/language."""
    pass


class DownloadFailed(Exception):
    """Raised when downloading a video artifact fails."""
    pass


def validate_youtube_url(url: str) -> str:
    """Validate that the URL belongs to a valid YouTube host."""
    if not url or not isinstance(url, str):
        raise VideoUnavailable("Invalid URL: URL parameter is required.")
    
    parsed = urlparse(url.strip())
    domain = parsed.netloc.lower()
    
    # Strip port if present
    if ":" in domain:
        domain = domain.split(":")[0]
        
    valid_hosts = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"}
    if domain not in valid_hosts and not domain.endswith(".youtube.com"):
        raise VideoUnavailable(f"Invalid URL host '{parsed.netloc}'. Only youtube.com and youtu.be URLs are accepted.")
        
    return url.strip()


def parse_vtt_timestamps(vtt_content: str) -> List[Dict[str, Any]]:
    """Parse WebVTT subtitle text into timestamped [{start, end, text}] segments."""
    segments: List[Dict[str, Any]] = []
    if not vtt_content:
        return segments

    # Regex matching WebVTT timestamp lines: 00:00:01.000 --> 00:00:04.500
    timestamp_pattern = re.compile(
        r'(?:(\d{2}):)?(\d{2}):(\d{2})[\.,](\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})[\.,](\d{3})'
    )
    
    lines = vtt_content.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        match = timestamp_pattern.search(line)
        if match:
            # Parse start time
            sh, sm, ss, sms = match.group(1), match.group(2), match.group(3), match.group(4)
            start_sec = (int(sh) if sh else 0) * 3600 + int(sm) * 60 + int(ss) + int(sms) / 1000.0

            # Parse end time
            eh, em, es, ems = match.group(5), match.group(6), match.group(7), match.group(8)
            end_sec = (int(eh) if eh else 0) * 3600 + int(em) * 60 + int(es) + int(ems) / 1000.0

            # Collect text lines until empty line or next timestamp
            text_lines = []
            i += 1
            while i < len(lines):
                next_line = lines[i].strip()
                if not next_line:
                    break
                if timestamp_pattern.search(next_line):
                    i -= 1
                    break
                # Strip HTML/VTT tags like <c>...</c> or <00:00:01.500>
                clean_text = re.sub(r'<[^>]+>', '', next_line)
                if clean_text:
                    text_lines.append(clean_text)
                i += 1

            full_text = " ".join(text_lines).strip()
            if full_text:
                segments.append({
                    "start": round(start_sec, 2),
                    "end": round(end_sec, 2),
                    "text": full_text
                })
        i += 1

    return segments


class YouTubeClient:
    """Client for extracting YouTube metadata, subtitles, and downloads using yt-dlp Python API."""

    def __init__(self, download_dir: Optional[Path] = None):
        self.download_dir = download_dir or YT_DOWNLOAD_DIR

    def get_metadata(self, url: str) -> Dict[str, Any]:
        """Extract YouTube metadata without downloading video."""
        clean_url = validate_youtube_url(url)
        ydl_opts = {
            'skip_download': True,
            'quiet': True,
            'no_warnings': True,
            'extract_flat': False,
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios', 'mweb', 'web']
                }
            }
        }

        info = None
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(clean_url, download=False)
        except Exception:
            info = None

        # Fallback to official YouTube oEmbed API if yt-dlp extraction encounters bot protection
        if not info:
            try:
                import urllib.request
                import urllib.parse
                oembed_url = f"https://www.youtube.com/oembed?url={urllib.parse.quote(clean_url)}&format=json"
                req = urllib.request.Request(oembed_url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    if resp.status == 200:
                        oembed_data = json.loads(resp.read().decode('utf-8'))
                        video_id = ""
                        m = re.search(r'(?:v=|/vi/|/embed/|youtu\.be/)([\w-]{11})', clean_url + " " + oembed_data.get("thumbnail_url", ""))
                        if m:
                            video_id = m.group(1)
                        return {
                            'id': video_id,
                            'title': oembed_data.get('title', 'Untitled Video'),
                            'description': f"Channel: {oembed_data.get('author_name', 'YouTube Uploader')}",
                            'uploader': oembed_data.get('author_name', 'YouTube Uploader'),
                            'channel_id': oembed_data.get('author_url', ''),
                            'upload_date': None,
                            'duration': None,
                            'view_count': None,
                            'thumbnails': [{'url': oembed_data.get('thumbnail_url', ''), 'width': 480, 'height': 360}],
                            'webpage_url': clean_url,
                            'available_subtitles': [{'code': 'en', 'name': 'English', 'isAuto': True}],
                        }
            except Exception:
                pass
            raise VideoUnavailable("Video is unavailable or invalid.")

        # Extract available subtitle languages (manual vs automatic)
        sub_languages: List[Dict[str, Any]] = []
        seen_langs = set()

        manual_subs = info.get('subtitles') or {}
        for code, sub_list in manual_subs.items():
            name = sub_list[0].get('name', code) if sub_list else code
            sub_languages.append({'code': code, 'name': name, 'isAuto': False})
            seen_langs.add(code)

        auto_subs = info.get('automatic_captions') or {}
        for code, sub_list in auto_subs.items():
            if code not in seen_langs:
                name = sub_list[0].get('name', code) if sub_list else code
                sub_languages.append({'code': code, 'name': name, 'isAuto': True})

        thumbnails = [
            {
                'url': t.get('url', ''),
                'width': t.get('width'),
                'height': t.get('height')
            }
            for t in (info.get('thumbnails') or [])
            if t.get('url')
        ]

        return {
            'id': info.get('id', ''),
            'title': info.get('title', 'Untitled'),
            'description': info.get('description', ''),
            'uploader': info.get('uploader') or info.get('channel') or 'Unknown Uploader',
            'channel_id': info.get('channel_id') or info.get('uploader_id') or '',
            'upload_date': info.get('upload_date'),
            'duration': info.get('duration'),
            'view_count': info.get('view_count'),
            'thumbnails': thumbnails,
            'webpage_url': info.get('webpage_url') or clean_url,
            'available_subtitles': sub_languages,
        }

    def get_subtitles(self, url: str, lang: str = 'en') -> Dict[str, Any]:
        """Fetch and parse timestamped subtitle segments for a language."""
        clean_url = validate_youtube_url(url)
        
        # Temporary options to extract subtitles without video download
        ydl_opts = {
            'skip_download': True,
            'writesubtitles': True,
            'writeautomaticsub': True,
            'subtitleslangs': [lang],
            'subtitlesformat': 'vtt',
            'quiet': True,
            'no_warnings': True,
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios', 'mweb', 'web']
                }
            }
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(clean_url, download=False)
        except Exception as e:
            raise VideoUnavailable(f"Could not load video for subtitles: {str(e)}")

        video_id = info.get('id', 'video')
        manual_subs = info.get('subtitles') or {}
        auto_subs = info.get('automatic_captions') or {}

        target_sub = None
        is_auto = False

        if lang in manual_subs:
            target_sub = manual_subs[lang]
            is_auto = False
        elif lang in auto_subs:
            target_sub = auto_subs[lang]
            is_auto = True
        elif manual_subs:
            # Fallback to first available manual sub if requested lang missing
            first_lang = next(iter(manual_subs))
            target_sub = manual_subs[first_lang]
            lang = first_lang
            is_auto = False
        elif auto_subs:
            # Fallback to first available auto sub
            first_lang = next(iter(auto_subs))
            target_sub = auto_subs[first_lang]
            lang = first_lang
            is_auto = True

        if not target_sub:
            raise SubsUnavailable(f"No subtitles or automatic captions available for video '{video_id}' in language '{lang}'.")

        # Find VTT format url or content
        vtt_url = None
        for fmt in target_sub:
            if fmt.get('ext') == 'vtt':
                vtt_url = fmt.get('url')
                break
        if not vtt_url and target_sub:
            vtt_url = target_sub[0].get('url')

        if not vtt_url:
            raise SubsUnavailable(f"Could not locate VTT format for subtitles in '{lang}'.")

        # Fetch subtitle content via yt-dlp request handler
        try:
            with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
                vtt_text = ydl.urlopen(vtt_url).read().decode('utf-8', errors='ignore')
        except Exception as e:
            raise SubsUnavailable(f"Failed downloading VTT subtitle track: {str(e)}")

        segments = parse_vtt_timestamps(vtt_text)
        if not segments:
            raise SubsUnavailable(f"Subtitle track for '{lang}' contained no readable timestamped segments.")

        return {
            'id': video_id,
            'lang': lang,
            'isAuto': is_auto,
            'segments': segments,
        }

    def download(self, url: str, quality: str = '720p') -> Dict[str, Any]:
        """Download video into YT_DOWNLOAD_DIR/{video_id}.mp4 and record audit log."""
        clean_url = validate_youtube_url(url)
        
        # Parse target height from quality string (e.g. 720p -> 720)
        height_match = re.search(r'\d+', quality)
        max_height = int(height_match.group(0)) if height_match else 720

        # First extract metadata to obtain video_id
        meta = self.get_metadata(clean_url)
        video_id = meta['id']
        out_path = self.download_dir / f"{video_id}.mp4"

        # Format selector: best mp4 video under max_height + best m4a audio
        format_spec = f"bestvideo[height<={max_height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={max_height}][ext=mp4]/best"

        ydl_opts = {
            'format': format_spec,
            'outtmpl': str(out_path),
            'quiet': True,
            'no_warnings': True,
            'overwrites': True,
            'ffmpeg_location': FFMPEG_PATH,
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios', 'mweb', 'web']
                }
            }
        }

        # Write audit log line before starting download
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
        logger.info(f"[AUDIT] Youtube download initiated | User: analyst | Time: {now_iso} | URL: {clean_url} | Video ID: {video_id} | Quality: {quality}")

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([clean_url])
        except Exception as e:
            raise DownloadFailed(f"Video download failed for '{video_id}': {str(e)}")

        if not out_path.exists():
            raise DownloadFailed(f"Download reported success but output file '{out_path}' was not created.")

        filesize = out_path.stat().st_size

        return {
            'id': video_id,
            'path': str(out_path.resolve()),
            'filesize': filesize,
            'format': f"mp4 ({quality})",
        }
