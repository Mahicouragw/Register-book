#!/usr/bin/env python3
"""Bulk-download voice notes and audio attachments out of Gmail — 100% free.

Why this exists
---------------
WhatsApp "voice notes" that arrive by email are really small audio attachments
(usually ``audio/ogg`` files called ``AUD-20260913-WA0001.opus``). Gmail's web UI
makes you open them one at a time, so a conversation of a few hundred clips is
painful to keep. This tool grabs every audio attachment that matches a Gmail
search, converts the ones the browser cannot play (Opus) into MP3, and writes a
manifest you can sort or re-run safely.

Nothing here costs money and nothing needs a paid service:

* Gmail API          — free for personal use, read-only scope.
* ffmpeg             — free/open source; a pip package ships a static build.
* Windows/Mac/Linux  — pure Python, no compiled extension needed.

Typical use for this repo
-------------------------
    # 1. once: get a free Google OAuth client (Desktop app) -> credentials.json
    # 2. dry run, see what would be fetched
    python3 tools/gmail_audio_export.py \
        --query 'from:luckysankhala76@gmail.com subject:"Audio from" has:attachment' \
        --out ./audio/lucky --dry-run

    # 3. download + convert to MP3 + build a playlist page
    python3 tools/gmail_audio_export.py \
        --query 'from:luckysankhala76@gmail.com subject:"Audio from" has:attachment' \
        --out ./audio/lucky --html-index

    # 4. one MP3 per day instead of one per clip
    python3 tools/gmail_audio_export.py --preset whatsapp-voice \
        --out ./audio/lucky --merge day

Run ``--help`` for every option.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
API_SERVICE = "gmail"
API_VERSION = "v1"

# Extensions Gmail uses for audio attachments (WhatsApp, iOS Voice Memos, etc.)
AUDIO_EXTENSIONS = {
    ".opus", ".ogg", ".oga", ".mp3", ".m4a", ".aac", ".wav", ".amr",
    ".3gp", ".flac", ".wma", ".caf", ".aiff", ".aif", ".webm", ".mp4a",
}

# Search presets so nobody has to memorise Gmail operators.
PRESETS: Dict[str, str] = {
    # WhatsApp email notifications: "Audio from <name>" with an .opus file.
    "whatsapp-voice": '(subject:"Audio from" OR subject:"voice message") has:attachment',
    # Anything that looks like an audio attachment.
    "any-audio": (
        "has:attachment "
        "filename:(opus OR ogg OR oga OR mp3 OR m4a OR aac OR wav OR amr OR "
        "3gp OR flac OR wma OR caf OR aiff)"
    ),
}

# ffmpeg encoder settings per output format.
FFMPEG_ENCODERS: Dict[str, List[str]] = {
    "mp3": ["-c:a", "libmp3lame", "-b:a", "{bitrate}"],
    "m4a": ["-c:a", "aac", "-b:a", "{bitrate}", "-movflags", "+faststart"],
    "ogg": ["-c:a", "libopus", "-b:a", "{bitrate}"],
    "wav": ["-c:a", "pcm_s16le"],
}
OUTPUT_EXT = {"mp3": ".mp3", "m4a": ".m4a", "ogg": ".ogg", "wav": ".wav", "keep": ""}

# Everything is decoded to this before concatenating merged albums.
MERGE_RATE = "48000"
MERGE_CHANNELS = "1"

RETRY_STATUS = {429, 500, 502, 503, 504}


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def log(msg: str) -> None:
    print(msg, flush=True)


def human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.1f} {unit}"
        num /= 1024.0
    return f"{num:.1f} GB"


def human_duration(seconds: float) -> str:
    seconds = int(round(seconds))
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def slugify(text: str, fallback: str = "audio") -> str:
    """Filesystem-safe slug that keeps unicode letters (Hindi names survive)."""
    text = (text or "").strip().lower()
    # keep letters/digits from any script (Devanagari names keep their matras)
    text = re.sub(r"[^\w\u0900-\u097F\s.-]", "", text, flags=re.UNICODE)
    text = re.sub(r"[\s_.-]+", "-", text).strip("-")
    return text[:60] or fallback


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 256), b""):
            digest.update(chunk)
    return digest.hexdigest()


def base64url_decode(data: str) -> bytes:
    """Gmail returns base64url without padding; add it back."""
    data = data.replace("-", "+").replace("_", "/")
    pad = (-len(data)) % 4
    return base64.b64decode(data + "=" * pad)


def get_timezone(name: str):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # tzdata missing on some Windows installs
        return timezone.utc


def parse_when(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    if value.isdigit():
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    cleaned = value.replace(" (", " (").strip()
    m = re.match(r"^(?:[A-Za-z]{3}, )?(\d{1,2} [A-Za-z]{3} \d{2,4} \d{2}:\d{2}(?::\d{2})?)", cleaned)
    if m:
        cleaned = m.group(1)
    for fmt in ("%d %b %Y %H:%M:%S", "%d %b %Y %H:%M", "%d %b %y %H:%M:%S", "%d %b %y %H:%M"):
        try:
            return datetime.strptime(cleaned, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# ffmpeg discovery (free builds only)
# --------------------------------------------------------------------------- #

class FFmpegMissing(RuntimeError):
    pass


def find_ffmpeg(explicit: Optional[str] = None) -> str:
    """Locate a usable ffmpeg: flag -> env -> PATH -> free pip wheel."""
    candidates: List[str] = []
    if explicit:
        candidates.append(explicit)
    if os.environ.get("FFMPEG_BINARY"):
        candidates.append(os.environ["FFMPEG_BINARY"])
    found = shutil.which("ffmpeg")
    if found:
        candidates.append(found)
    try:  # imageio-ffmpeg is a free, self-contained static build for every OS
        import imageio_ffmpeg  # type: ignore

        candidates.append(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        pass

    for candidate in candidates:
        path = Path(candidate)
        if path.exists() and os.access(path, os.X_OK):
            try:
                out = subprocess.run([str(path), "-version"], capture_output=True, text=True, timeout=20)
                if out.returncode == 0:
                    return str(path)
            except Exception:
                continue
    raise FFmpegMissing(
        "ffmpeg was not found. It is free — install it one of these ways:\n"
        "  • easiest, no admin rights:  pip install imageio-ffmpeg\n"
        "  • Debian/Ubuntu:             sudo apt install ffmpeg\n"
        "  • macOS:                     brew install ffmpeg\n"
        "  • Windows:                   winget install Gyan.FFmpeg\n"
        "Then re-run, or point at it with --ffmpeg /path/to/ffmpeg"
    )


def probe_duration(ffmpeg: str, path: Path) -> float:
    """Read the duration out of ffmpeg's banner (no separate ffprobe needed)."""
    proc = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)],
                          capture_output=True, text=True)
    match = re.search(r"Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)", proc.stderr or "")
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def run_ffmpeg(ffmpeg: str, args: Sequence[str]) -> None:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(args)}\n{proc.stderr.strip()}")


# --------------------------------------------------------------------------- #
# Gmail access
# --------------------------------------------------------------------------- #

@dataclass
class AudioPart:
    message_id: str
    thread_id: str
    attachment_id: str
    filename: str
    mime_type: str
    size: int
    sender: str
    subject: str
    when: datetime


class GmailClient:
    """Thin, retrying wrapper around the free Gmail REST API."""

    def __init__(self, credentials_file: Optional[Path], token_file: Path,
                 user: str = "me", verbose: bool = True):
        self.user = user
        self.token_file = token_file
        self.verbose = verbose
        self._local = threading.local()
        self._credentials_file = credentials_file
        self._creds = self._authorize()

    # -- auth -------------------------------------------------------------
    def _authorize(self):
        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials
            from google_auth_oauthlib.flow import InstalledAppFlow
        except ImportError as exc:  # pragma: no cover - environment issue
            raise SystemExit(
                "Missing Google client libraries. Install them once with:\n"
                "  pip install google-api-python-client google-auth-oauthlib\n"
                f"(details: {exc})"
            )

        creds = None
        if self.token_file.exists():
            creds = Credentials.from_authorized_user_file(str(self.token_file), SCOPES)
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception:
                creds = None
        if not creds or not creds.valid:
            if not self._credentials_file or not Path(self._credentials_file).exists():
                raise SystemExit(
                    "Need a free OAuth client first (one-time, 2 minutes):\n"
                    "  1. https://console.cloud.google.com/  → new project (free)\n"
                    "  2. Enable the Gmail API\n"
                    "  3. Credentials → Create credentials → OAuth client ID → Desktop app\n"
                    "  4. Download the JSON and save it as credentials.json here\n"
                    "Then re-run with --credentials credentials.json\n"
                    "(A browser window opens once; the token is cached in --token.)"
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(self._credentials_file), SCOPES)
            creds = flow.run_local_server(port=0, prompt="consent")
            self.token_file.parent.mkdir(parents=True, exist_ok=True)
            self.token_file.write_text(creds.to_json(), encoding="utf-8")
            try:
                os.chmod(self.token_file, 0o600)
            except OSError:
                pass
            if self.verbose:
                log(f"  saved login token → {self.token_file}")
        return creds

    @property
    def service(self):
        """One API client per thread — the underlying http object is not shared."""
        svc = getattr(self._local, "service", None)
        if svc is None:
            from googleapiclient.discovery import build

            svc = build(API_SERVICE, API_VERSION, credentials=self._creds,
                        cache_discovery=False)
            self._local.service = svc
        return svc

    # -- retry helper ------------------------------------------------------
    def _call(self, factory, attempts: int = 6):
        last: Optional[Exception] = None
        for attempt in range(attempts):
            try:
                return factory()
            except Exception as exc:  # googleapiclient.errors.HttpError etc.
                last = exc
                status = getattr(getattr(exc, "resp", None), "status", None)
                if status not in RETRY_STATUS and not isinstance(exc, (TimeoutError, ConnectionError)):
                    raise
                wait = min(2 ** attempt, 30)
                if self.verbose:
                    log(f"    … transient error ({status or type(exc).__name__}), retry in {wait}s")
                time.sleep(wait)
        raise RuntimeError(f"Gmail kept failing after {attempts} attempts: {last}")

    # -- listing -----------------------------------------------------------
    def iter_message_ids(self, query: str, limit: Optional[int] = None,
                         include_spam_trash: bool = False) -> Iterator[Dict[str, str]]:
        page_token: Optional[str] = None
        seen = 0
        while True:
            params: Dict[str, Any] = {
                "userId": self.user,
                "q": query,
                "maxResults": 500,
                "includeSpamTrash": include_spam_trash,
            }
            if page_token:
                params["pageToken"] = page_token
            page = self._call(lambda: self.service.users().messages().list(**params).execute())
            for msg in page.get("messages", []) or []:
                yield msg
                seen += 1
                if limit and seen >= limit:
                    return
            page_token = page.get("nextPageToken")
            if not page_token:
                return

    def audio_parts(self, message_id: str) -> List[AudioPart]:
        msg = self._call(lambda: self.service.users().messages()
                         .get(userId=self.user, id=message_id, format="full").execute())
        payload = msg.get("payload", {}) or {}
        headers = {h.get("name", "").lower(): h.get("value", "")
                   for h in payload.get("headers", []) or []}
        when = parse_when(msg.get("internalDate")) or parse_when(headers.get("date")) \
            or datetime.now(tz=timezone.utc)
        sender = headers.get("from", "")
        subject = headers.get("subject", "")

        parts: List[AudioPart] = []
        for part in _walk_parts(payload):
            body = part.get("body", {}) or {}
            attachment_id = body.get("attachmentId")
            filename = (part.get("filename") or "").strip()
            mime = (part.get("mimeType") or "").lower()
            if not attachment_id:
                continue
            suffix = Path(filename).suffix.lower()
            is_audio = mime.startswith("audio/") or suffix in AUDIO_EXTENSIONS
            if not is_audio:
                continue
            parts.append(AudioPart(
                message_id=message_id,
                thread_id=msg.get("threadId", ""),
                attachment_id=attachment_id,
                filename=filename or f"{message_id}{suffix or '.audio'}",
                mime_type=mime or "audio/*",
                size=int(body.get("size") or 0),
                sender=sender,
                subject=subject,
                when=when,
            ))
        return parts

    def download(self, part: AudioPart) -> bytes:
        blob = self._call(lambda: self.service.users().attachments()
                          .get(userId=self.user, messageId=part.message_id,
                               id=part.attachment_id).execute())
        return base64url_decode(blob["data"])


def _walk_parts(payload: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    """Depth-first walk of the MIME tree."""
    stack = [payload]
    while stack:
        part = stack.pop()
        yield part
        for child in part.get("parts", []) or []:
            stack.append(child)


# --------------------------------------------------------------------------- #
# Journal / manifest
# --------------------------------------------------------------------------- #

MANIFEST_FIELDS = [
    "status", "when_utc", "when_local", "sender", "subject", "original_filename",
    "mime_type", "source_bytes", "message_id", "attachment_id",
    "output_file", "output_bytes", "duration_seconds", "sha256",
]


class Manifest:
    """Append-only CSV journal so a re-run skips work that is already done."""

    def __init__(self, path: Path):
        self.path = path
        self.done: Dict[str, Dict[str, str]] = {}
        self.rows: List[Dict[str, str]] = []
        if path.exists():
            try:
                with open(path, newline="", encoding="utf-8") as fh:
                    for row in csv.DictReader(fh):
                        self.rows.append(row)
                        key = self._key(row.get("message_id", ""), row.get("attachment_id", ""))
                        if row.get("status") == "ok" and row.get("output_file"):
                            self.done[key] = row
            except Exception:
                pass

    @staticmethod
    def _key(message_id: str, attachment_id: str) -> str:
        return f"{message_id}:{attachment_id}"

    def lookup(self, part: AudioPart) -> Optional[Dict[str, str]]:
        return self.done.get(self._key(part.message_id, part.attachment_id))

    def add(self, row: Dict[str, str]) -> None:
        self.rows.append(row)
        if row.get("status") == "ok":
            self.done[self._key(row["message_id"], row["attachment_id"])] = row

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=MANIFEST_FIELDS, extrasaction="ignore")
            writer.writeheader()
            for row in self.rows:
                writer.writerow({k: row.get(k, "") for k in MANIFEST_FIELDS})


# --------------------------------------------------------------------------- #
# Main work
# --------------------------------------------------------------------------- #

@dataclass
class Clip:
    part: AudioPart
    out_path: Path
    duration: float = 0.0
    sha256: str = ""
    out_bytes: int = 0

    @property
    def local_when(self) -> datetime:
        return self.part.when


def build_output_name(part: AudioPart, tz, index: int, taken: set) -> str:
    local = part.when.astimezone(tz)
    stamp = local.strftime("%Y-%m-%d_%H%M%S")
    sender_slug = slugify(part.sender.split("<")[0], fallback="unknown")
    stem = Path(part.filename).stem or f"clip-{index:03d}"
    stem = slugify(stem, fallback=f"clip-{index:03d}")
    base = f"{stamp}_{sender_slug}_{stem}"
    candidate = base
    n = 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1
    taken.add(candidate)
    return candidate


def download_one(client: GmailClient, part: AudioPart, out_dir: Path, ffmpeg: Optional[str],
                 fmt: str, bitrate: str, keep_original: bool, tz, taken: set,
                 index: int) -> Clip:
    """Fetch one attachment, convert it, keep the good bits."""
    stem = build_output_name(part, tz, index, taken)
    raw_dir = out_dir / "original"
    if fmt == "keep":  # no conversion: preserve the original extension
        out_path = out_dir / f"{stem}{Path(part.filename).suffix or '.bin'}"
    else:
        out_path = out_dir / f"{stem}{OUTPUT_EXT[fmt]}"

    data = client.download(part)
    if not data:
        raise RuntimeError("Gmail returned an empty attachment body")

    if fmt == "keep":
        out_path.write_bytes(data)
        return Clip(part=part, out_path=out_path, out_bytes=len(data))

    with tempfile.TemporaryDirectory(prefix="gm-audio-") as tmp:
        suffix = Path(part.filename).suffix or ".bin"
        src = Path(tmp) / f"src{suffix}"
        src.write_bytes(data)

        if keep_original:
            raw_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, raw_dir / part.filename)

        if not ffmpeg:
            raise FFmpegMissing("ffmpeg not available for conversion (use --format keep)")
        args = ["-i", str(src), "-vn", "-ac", MERGE_CHANNELS]
        args += [a.format(bitrate=bitrate) for a in FFMPEG_ENCODERS[fmt]]
        args.append(str(out_path))
        run_ffmpeg(ffmpeg, args)

    duration = probe_duration(ffmpeg, out_path) if ffmpeg else 0.0
    clip = Clip(part=part, out_path=out_path, duration=duration,
                out_bytes=out_path.stat().st_size)
    clip.sha256 = sha256_of(out_path)
    return clip


def merge_clips(ffmpeg: str, clips: Sequence[Clip], target: Path,
                fmt: str, bitrate: str, gap: float) -> float:
    """Join clips in order, with a short silence between them."""
    with tempfile.TemporaryDirectory(prefix="gm-merge-") as tmp:
        tmpdir = Path(tmp)
        if gap > 0:
            silence = tmpdir / "silence.wav"
            run_ffmpeg(ffmpeg, ["-f", "lavfi",
                                "-i", f"anullsrc=r={MERGE_RATE}:cl=mono",
                                "-t", f"{gap:.2f}", "-c:a", "pcm_s16le", str(silence)])
        list_lines: List[str] = []
        for i, clip in enumerate(clips):
            norm = tmpdir / f"part-{i:04d}.wav"
            run_ffmpeg(ffmpeg, ["-i", str(clip.out_path), "-ar", MERGE_RATE,
                                "-ac", MERGE_CHANNELS, "-c:a", "pcm_s16le", str(norm)])
            list_lines.append(f"file '{norm.as_posix()}'")
            if gap > 0 and i != len(clips) - 1:
                list_lines.append(f"file '{(tmpdir / 'silence.wav').as_posix()}'")
        list_file = tmpdir / "list.txt"
        list_file.write_text("\n".join(list_lines) + "\n", encoding="utf-8")

        target.parent.mkdir(parents=True, exist_ok=True)
        args = ["-f", "concat", "-safe", "0", "-i", str(list_file), "-vn"]
        args += [a.format(bitrate=bitrate) for a in FFMPEG_ENCODERS[fmt]]
        args.append(str(target))
        run_ffmpeg(ffmpeg, args)
    return probe_duration(ffmpeg, target)


def write_html_index(out_dir: Path, clips: Sequence[Clip], merged: Sequence[tuple], tz) -> Path:
    """A tiny offline player page — open it on the phone and press play."""
    rows = []
    for clip in sorted(clips, key=lambda c: c.part.when):
        local = clip.part.when.astimezone(tz)
        rel = clip.out_path.relative_to(out_dir).as_posix()
        rows.append(
            "      <tr>"
            f"<td class='when'>{html.escape(local.strftime('%d %b %Y, %H:%M'))}</td>"
            f"<td class='len'>{html.escape(human_duration(clip.duration))}</td>"
            f"<td class='name'>{html.escape(clip.part.filename)}</td>"
            f"<td><audio controls preload='none' src='{html.escape(rel)}'></audio></td>"
            "</tr>"
        )
    merged_html = ""
    if merged:
        items = "".join(
            f"<li><a href='{html.escape(Path(p).relative_to(out_dir).as_posix())}'>"
            f"{html.escape(Path(p).name)}</a> — {html.escape(human_duration(d))}</li>"
            for p, d in merged
        )
        merged_html = f"  <h2>Full albums</h2>\n  <ul class='albums'>{items}</ul>\n"

    total_seconds = sum(c.duration for c in clips)
    total_bytes = sum(c.out_bytes for c in clips)
    doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice notes — {len(clips)} clips</title>
<style>
 :root {{ color-scheme: light dark; }}
 body {{ font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 20px;
        max-width: 900px; margin-inline: auto; line-height: 1.45; }}
 h1 {{ font-size: 1.35rem; margin: 0 0 4px; }}
 .sum {{ color: #6b7280; font-size: .85rem; margin-bottom: 18px; }}
 table {{ border-collapse: collapse; width: 100%; font-size: .86rem; }}
 th, td {{ text-align: left; padding: 8px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }}
 th {{ font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }}
 td.when {{ white-space: nowrap; }}
 td.len {{ white-space: nowrap; color: #6b7280; }}
 td.name {{ word-break: break-all; }}
 audio {{ width: 210px; height: 32px; }}
 .albums {{ font-size: .9rem; }}
 footer {{ margin-top: 24px; color: #9ca3af; font-size: .75rem; }}
</style></head>
<body>
  <h1>Voice notes, oldest first</h1>
  <p class="sum">{len(clips)} clips · {html.escape(human_duration(total_seconds))} total ·
     {html.escape(human_size(total_bytes))} on disk</p>
{merged_html}  <table>
    <thead><tr><th>When</th><th>Length</th><th>Original file</th><th>Play</th></tr></thead>
    <tbody>
{chr(10).join(rows)}
    </tbody>
  </table>
  <footer>Made with tools/gmail_audio_export.py — works offline, no uploads.</footer>
</body></html>
"""
    path = out_dir / "index.html"
    path.write_text(doc, encoding="utf-8")
    return path


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Download audio attachments from Gmail, convert to MP3, and/or merge them.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python3 tools/gmail_audio_export.py --preset whatsapp-voice --out ./audio/lucky --dry-run\n"
               "  python3 tools/gmail_audio_export.py --query 'from:someone@gmail.com subject:\"Audio from\"' --out ./audio\n"
               "  python3 tools/gmail_audio_export.py --preset whatsapp-voice --out ./audio --merge day\n",
    )
    parser.add_argument("--query", "-q", default=None,
                        help='Gmail search, e.g. \'from:lucky@gmail.com subject:"Audio from"\'. '
                             'Defaults to --preset (whatsapp-voice).')
    parser.add_argument("--preset", choices=sorted(PRESETS), default="whatsapp-voice",
                        help="Canned search to use when --query is not given.")
    parser.add_argument("--out", "-o", default="./gmail-audio",
                        help="Folder to write into (default ./gmail-audio)")
    parser.add_argument("--format", "-f", default="mp3", choices=["mp3", "m4a", "ogg", "wav", "keep"],
                        help="Output format (default mp3 — plays everywhere, including iPhone)")
    parser.add_argument("--bitrate", "-b", default="64k",
                        help="Audio bitrate for lossy formats (default 64k; voice is fine at 48k-64k)")
    parser.add_argument("--merge", action="store_true",
                        help="Also produce one long file per day")
    parser.add_argument("--gap", type=float, default=0.6,
                        help="Seconds of silence between clips when merging (default 0.6)")
    parser.add_argument("--keep-original", action="store_true",
                        help="Also keep the untouched original (.opus etc.) in <out>/original/")
    parser.add_argument("--limit", type=int, default=None, help="Stop after N messages")
    parser.add_argument("--after", default=None, help="Only messages after YYYY-MM-DD")
    parser.add_argument("--before", default=None, help="Only messages before YYYY-MM-DD")
    parser.add_argument("--include-spam-trash", action="store_true",
                        help="Search Spam and Trash as well")
    parser.add_argument("--workers", type=int, default=4, help="Parallel downloads (default 4)")
    parser.add_argument("--force", action="store_true", help="Re-download even if already in the manifest")
    parser.add_argument("--dry-run", action="store_true", help="List what would be downloaded, fetch nothing")
    parser.add_argument("--html-index", action="store_true",
                        help="Write out/index.html — a tap-to-play page for every clip")
    parser.add_argument("--credentials", default="credentials.json",
                        help="Google OAuth client JSON (Desktop app type)")
    parser.add_argument("--token", default=None,
                        help="Where to cache the login token (default <out>/.token.json). "
                             "Env GMAIL_AUDIO_TOKEN also works.")
    parser.add_argument("--tz", default="Asia/Kolkata",
                        help="Timezone for filenames and the playlist (default Asia/Kolkata)")
    parser.add_argument("--ffmpeg", default=None, help="Path to ffmpeg if it is not on PATH")
    args = parser.parse_args(argv)

    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    tz = get_timezone(args.tz)

    query = args.query or PRESETS[args.preset]
    extra = []
    if args.after:
        extra.append(f"after:{args.after.replace('-', '/')}")
    if args.before:
        extra.append(f"before:{args.before.replace('-', '/')}")
    if extra:
        query = f"{query} {' '.join(extra)}"

    log(f"Gmail search : {query}")
    log(f"Output folder: {out_dir}")

    ffmpeg = None
    if (args.format != "keep" or args.merge) and not args.dry_run:
        try:
            ffmpeg = find_ffmpeg(args.ffmpeg)
            log(f"ffmpeg       : {ffmpeg}")
        except FFmpegMissing as exc:
            log(f"! {exc}")
            return 2
    elif args.dry_run:
        try:
            ffmpeg = find_ffmpeg(args.ffmpeg)
        except FFmpegMissing:
            ffmpeg = None

    token_path = Path(args.token).expanduser() if args.token else \
        Path(os.environ.get("GMAIL_AUDIO_TOKEN") or (out_dir / ".token.json"))
    client = GmailClient(Path(args.credentials).expanduser(), token_path)

    # ---- 1. discover -----------------------------------------------------
    log("Searching Gmail…")
    parts: List[AudioPart] = []
    seen_ids: set = set()
    with ThreadPoolExecutor(max_workers=max(1, min(8, args.workers))) as pool:
        pending = []
        for msg in client.iter_message_ids(query, limit=args.limit,
                                           include_spam_trash=args.include_spam_trash):
            if msg["id"] in seen_ids:
                continue
            seen_ids.add(msg["id"])
            pending.append(pool.submit(client.audio_parts, msg["id"]))
            if len(pending) >= 200:
                for fut in as_completed(pending):
                    parts.extend(fut.result())
                pending = []
        for fut in as_completed(pending):
            parts.extend(fut.result())

    parts.sort(key=lambda p: (p.when, p.filename))
    total_source = sum(p.size for p in parts)
    log(f"Found {len(parts)} audio attachment(s) in {len(seen_ids)} message(s), "
        f"{human_size(total_source)} before conversion")

    if not parts:
        log("Nothing matched — try a broader --query (or --include-spam-trash).")
        return 1

    # ---- 2. skip work already done ---------------------------------------
    manifest = Manifest(out_dir / "manifest.csv")
    todo: List[AudioPart] = []
    skipped = 0
    for part in parts:
        row = manifest.lookup(part)
        if row and not args.force:
            existing = out_dir / row["output_file"]
            if existing.exists():
                skipped += 1
                continue
        todo.append(part)
    log(f"{skipped} already downloaded, {len(todo)} to fetch")

    if args.dry_run:
        for part in todo:
            local = part.when.astimezone(tz)
            log(f"  {local:%Y-%m-%d %H:%M}  {human_size(part.size):>9}  "
                f"{part.filename}  ({part.mime_type})")
        log("\nDry run only — nothing was downloaded.")
        return 0

    # ---- 3. download + convert ------------------------------------------
    clips: List[Clip] = []
    taken: set = set()
    failures: List[Tuple[AudioPart, str]] = []
    lock = threading.Lock()
    started = time.time()

    def work(item: Tuple[int, AudioPart]) -> Optional[Clip]:
        index, part = item
        with lock:
            return download_one(client, part, out_dir, ffmpeg, args.format, args.bitrate,
                                args.keep_original, tz, taken, index)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(work, (i, p)): p for i, p in enumerate(todo)}
        done = 0
        for fut in as_completed(futures):
            part = futures[fut]
            done += 1
            try:
                clip = fut.result()
            except Exception as exc:
                failures.append((part, str(exc)))
                log(f"  [{done}/{len(todo)}] FAILED {part.filename}: {exc}")
                continue
            if clip is None:
                continue
            clips.append(clip)
            local = part.when.astimezone(tz)
            log(f"  [{done}/{len(todo)}] {local:%d %b %Y %H:%M}  "
                f"{human_duration(clip.duration):>8}  → {clip.out_path.name}")
            manifest.add({
                "status": "ok",
                "when_utc": part.when.isoformat(),
                "when_local": local.isoformat(),
                "sender": part.sender,
                "subject": part.subject,
                "original_filename": part.filename,
                "mime_type": part.mime_type,
                "source_bytes": str(part.size),
                "message_id": part.message_id,
                "attachment_id": part.attachment_id,
                "output_file": str(clip.out_path.relative_to(out_dir)),
                "output_bytes": str(clip.out_bytes),
                "duration_seconds": f"{clip.duration:.2f}",
                "sha256": clip.sha256,
            })
            manifest.save()  # journal after every clip, so a crash loses nothing

    # include clips downloaded on earlier runs so merging stays complete
    all_clips: Dict[str, Clip] = {c.out_path.name: c for c in clips}
    for row in manifest.rows:
        if row.get("status") != "ok":
            continue
        path = out_dir / row["output_file"]
        if not path.exists() or path.name in all_clips:
            continue
        fake = AudioPart(
            message_id=row["message_id"], thread_id="", attachment_id=row["attachment_id"],
            filename=row["original_filename"], mime_type=row["mime_type"],
            size=int(row["source_bytes"] or 0), sender=row["sender"], subject=row["subject"],
            when=parse_when(row["when_utc"]) or datetime.now(tz=timezone.utc),
        )
        all_clips[path.name] = Clip(part=fake, out_path=path,
                                    duration=float(row["duration_seconds"] or 0),
                                    sha256=row["sha256"],
                                    out_bytes=int(row["output_bytes"] or 0))

    ordered = sorted(all_clips.values(), key=lambda c: c.part.when)

    # ---- 4. optional merge ----------------------------------------------
    merged: List[Tuple[Path, float]] = []
    if args.merge and ordered and ffmpeg:
        buckets: Dict[str, List[Clip]] = {}
        for clip in ordered:
            key = clip.part.when.astimezone(tz).strftime("%Y-%m-%d")
            buckets.setdefault(key, []).append(clip)
        merged_dir = out_dir / "merged"
        log(f"\nMerging {len(buckets)} day(s) → {merged_dir}")
        for key, bucket in sorted(buckets.items()):
            sender_slug = slugify(bucket[0].part.sender.split("<")[0], fallback="audio")
            target = merged_dir / f"{sender_slug}_{key}{OUTPUT_EXT[args.format]}"
            try:
                duration = merge_clips(ffmpeg, bucket, target, args.format, args.bitrate, args.gap)
                merged.append((target, duration))
                log(f"  {target.name}  ({len(bucket)} clips, {human_duration(duration)}, "
                    f"{human_size(target.stat().st_size)})")
            except Exception as exc:
                log(f"  ! could not merge {key}: {exc}")

    # ---- 5. playlist page -------------------------------------------------
    if args.html_index:
        page = write_html_index(out_dir, ordered, merged, tz)
        log(f"\nPlaylist page: {page}")

    # ---- 6. summary -------------------------------------------------------
    ok_seconds = sum(c.duration for c in ordered)
    ok_bytes = sum(c.out_bytes for c in ordered)
    elapsed = time.time() - started
    log("\n" + "─" * 58)
    log(f"Done in {elapsed:.1f}s — {len(clips)} new, {skipped} already had, "
        f"{len(failures)} failed")
    log(f"Collection: {len(ordered)} clips · {human_duration(ok_seconds)} · {human_size(ok_bytes)}")
    if merged:
        log(f"Albums    : {len(merged)} file(s) in {out_dir / 'merged'}")
    log(f"Manifest  : {out_dir / 'manifest.csv'}")
    duplicates = _find_duplicates(ordered)
    if duplicates:
        log(f"Note      : {duplicates} clip(s) are byte-identical to another clip "
            f"(WhatsApp re-sends). Nothing was deleted.")
    if failures:
        log(f"\n{len(failures)} attachment(s) could not be saved:")
        for part, reason in failures[:10]:
            log(f"  • {part.filename} ({part.message_id}): {reason[:160]}")
        log("Re-run the same command to retry only the missing ones.")
        return 1
    return 0


def _find_duplicates(clips: Sequence[Clip]) -> int:
    seen: Dict[str, int] = {}
    dupes = 0
    for clip in clips:
        if clip.sha256:
            if clip.sha256 in seen:
                dupes += 1
            else:
                seen[clip.sha256] = 1
    return dupes


if __name__ == "__main__":
    sys.exit(main())
