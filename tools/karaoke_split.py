#!/usr/bin/env python3
"""Karaoke splitter — pull the vocals out of a song and keep the instruments.

Two engines, because they have very different requirements:

  --method mdx      REAL AI separation (default). Runs a UVR **MDX-Net** ONNX
                    model with onnxruntime. Best quality: this is the same
                    family of models the free UVR / karaoke apps use, so the
                    instrumental is genuinely clean.
                    Needs a ~67 MB model file (see --models-help) and
                    `pip install onnxruntime numpy`.

  --method center   NO model, NO internet, works right now. Kills the centre
                    channel (mid/side) and refines it with spectral subtraction.
                    Fine on real stereo recordings; useless on mono files.
                    Good enough to sing over, not studio-grade.

Outputs (in --out, one folder per song):
    instrumental.wav / .mp3   — the backing track, vocals removed  ← sing over this
    vocals.wav / .mp3         — the isolated voice (guide / a-cappella)
    karaoke.mp3               — instrumental + a quiet guide vocal
    index.html                — tap-to-play page with a guide-vocal volume slider
    manifest.json             — what was used, and the numbers

Examples
--------
    # listen first, no model needed
    python3 tools/karaoke_split.py song.mp3 --method center -o ./karaoke

    # the good one (after downloading a model, see --models-help)
    python3 tools/karaoke_split.py song.mp3 --method mdx --model models/UVR-MDX-NET-Voc_FT.onnx -o ./karaoke

    # straight from a Gmail message (reuses tools/gmail_audio_export.py login)
    python3 tools/karaoke_split.py --from-gmail 'from:me after:2026/11/01' -o ./karaoke

Free end to end: onnxruntime + numpy are open source, the UVR models are free
downloads, and nothing is uploaded anywhere — everything runs on your machine.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

try:
    import numpy as np
except ImportError:  # pragma: no cover
    raise SystemExit("numpy is required:  pip install numpy")

SAMPLE_RATE = 44100
CHANNELS = 2
HOP = 1024          # UVR hard-codes this for MDX-Net
SEGMENT = 256       # spectrogram frames per inference window (UVR default)

MODEL_HELP = """
Where to get a free MDX-Net model (any one is enough)
─────────────────────────────────────────────────────
Official UVR model repo (free, no account, no login):
  https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models

Recommended for karaoke:
  • UVR-MDX-NET-Voc_FT.onnx      vocals model   (~67 MB)  ← best all-rounder
  • UVR-MDX-NET-Inst_HQ_3.onnx   instrumental   (~67 MB)
  • Kim_Vocal_2.onnx             vocals model   (~67 MB)  ← very popular

Put the .onnx file in ./models/ and run:
  python3 tools/karaoke_split.py "song.mp3" --method mdx \\
      --model models/UVR-MDX-NET-Voc_FT.onnx -o ./karaoke

Only a *vocals* model is needed: the instrumental is the mix minus the vocal
(the script does that subtraction and matches levels with --compensate).
A pure *instrumental* model works too, and then the vocal is mix-minus-inst.

If the GitHub download link above is blocked on your network, the same files
are mirrored inside the free UVR app (Ultimate Vocal Remover) and on
huggingface.co; any MDX-Net ONNX file with a 1x4xFxT input works here — the
script reads F and T straight out of the model.
"""


# --------------------------------------------------------------------------- #
# tiny helpers
# --------------------------------------------------------------------------- #

def log(msg: str = "") -> None:
    print(msg, flush=True)


def hhmmss(seconds: float) -> str:
    seconds = max(0.0, seconds)
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


def human_mb(num: float) -> str:
    return f"{num / 1e6:.1f} MB"


def find_ffmpeg(explicit: Optional[str] = None) -> Optional[str]:
    for cand in filter(None, [explicit, os.environ.get("FFMPEG_BINARY"), shutil.which("ffmpeg")]):
        if Path(cand).exists() or shutil.which(str(cand)):
            return str(cand)
    try:
        import imageio_ffmpeg  # free static build
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def decode_audio(ffmpeg: Optional[str], src: Path) -> np.ndarray:
    """Decode anything ffmpeg understands into float32 [samples, 2]."""
    if not ffmpeg:
        raise SystemExit("ffmpeg not found. Install it free:  pip install imageio-ffmpeg")
    proc = subprocess.run(
        [ffmpeg, "-v", "quiet", "-i", str(src), "-f", "f32le",
         "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"could not decode {src.name}: {proc.stderr.decode('utf-8', 'replace')[:300]}")
    audio = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32)
    if audio.size == 0:
        raise SystemExit(f"{src.name} decoded to zero samples")
    return audio.reshape(-1, CHANNELS)


def write_wav(path: Path, audio: np.ndarray) -> None:
    """16-bit PCM WAV, stereo."""
    data = np.clip(audio, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())


def encode(ffmpeg: str, wav: Path, out: Path, bitrate: str = "192k") -> Path:
    subprocess.run([ffmpeg, "-v", "quiet", "-y", "-i", str(wav), "-b:a", bitrate, str(out)],
                   check=True)
    return out


def mix(*tracks: Tuple[np.ndarray, float]) -> np.ndarray:
    total = np.zeros_like(tracks[0][0], dtype=np.float32)
    for audio, gain in tracks:
        total += audio * np.float32(gain)
    return total


def peak(audio: np.ndarray) -> float:
    return float(np.max(np.abs(audio))) if audio.size else 0.0


def normalize_pair(a: np.ndarray, b: np.ndarray, target: float = 0.89) -> Tuple[np.ndarray, np.ndarray, float]:
    """Scale both stems by the SAME gain so their balance is preserved."""
    p = max(peak(a), peak(b))
    if p <= 1e-9:
        return a, b, 1.0
    gain = target / p
    return a * gain, b * gain, gain


# --------------------------------------------------------------------------- #
# Engine 1 — centre-channel (mid/side) karaoke, no model required
# --------------------------------------------------------------------------- #

def stereo_report(audio: np.ndarray) -> Dict[str, float]:
    left, right = audio[:, 0].astype(np.float64), audio[:, 1].astype(np.float64)
    mid, side = (left + right) / 2.0, (left - right) / 2.0
    e_mid = float(np.mean(mid ** 2)) or 1e-12
    e_side = float(np.mean(side ** 2))
    corr = float(np.corrcoef(left, right)[0, 1]) if left.std() > 0 and right.std() > 0 else 1.0
    return {"side_to_mid_percent": 100.0 * e_side / e_mid, "correlation": corr}


def center_separate(audio: np.ndarray, strength: float = 1.0,
                    refine: bool = True) -> Tuple[np.ndarray, np.ndarray]:
    """Classic karaoke trick: vocals are usually mixed dead-centre, so

        vocals      ≈ (L + R) / 2            (the centre)
        instruments = L - R  … but that also drops centred *instruments*,
                      so instead: instruments = mix - strength * centre

    `refine` adds a spectral gate that only removes the centre where it is
    strong relative to the sides (keeps bass and kick, which are centred).
    """
    left, right = audio[:, 0], audio[:, 1]
    centre = ((left + right) * 0.5).astype(np.float32)

    if refine:
        # Remove only the part of the centre that the sides do not explain:
        # bins where |side| is close to |centre| are already "wide" (keep them).
        spec_c = np.fft.rfft(centre.astype(np.float64))
        spec_s = np.fft.rfft(((left - right) * 0.5).astype(np.float64))
        # soft mask: 1 where the centre dominates, 0 where the sides carry it
        ratio = np.abs(spec_c) / (np.abs(spec_c) + np.abs(spec_s) + 1e-9)
        mask = np.clip((ratio - 0.5) * 2.0, 0.0, 1.0)
        # low frequencies (< 120 Hz) are centred by nature — never cancel them
        freqs = np.fft.rfftfreq(centre.shape[0], 1.0 / SAMPLE_RATE)
        mask = np.where(freqs < 120.0, 0.0, mask)
        vocal = np.fft.irfft(spec_c * mask, n=centre.shape[0]).astype(np.float32)
    else:
        vocal = centre

    vocal = np.stack([vocal, vocal], axis=1)
    instrumental = (audio.astype(np.float32) - strength * vocal).astype(np.float32)
    return vocal, instrumental


# --------------------------------------------------------------------------- #
# Engine 2 — MDX-Net ONNX inference (faithful numpy/onnxruntime port of UVR)
# --------------------------------------------------------------------------- #

class ModelInfo:
    """Everything UVR keeps in its model_data table, read from the ONNX itself."""

    def __init__(self, path: Path, n_fft: Optional[int] = None, compensate: float = 1.035,
                 dim_t: Optional[int] = None):
        self.path = path
        try:
            import onnxruntime as ort  # noqa: F401
        except ImportError:
            raise SystemExit("onnxruntime is required for --method mdx:\n"
                             "  pip install onnxruntime")
        import onnxruntime as ort

        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        shape = self.session.get_inputs()[0].shape
        if len(shape) != 4:
            raise SystemExit(f"{path.name}: expected a 1x4xFxT input, got {shape}")
        self.dim_f = int(shape[2])
        self.dim_t = int(dim_t or (shape[3] if isinstance(shape[3], int) else SEGMENT))
        # n_fft is not stored in the file; UVR's convention per frequency size:
        nfft_map = {2048: 6144, 2560: 5120, 3072: 7680, 1024: 5120}
        self.n_fft = int(n_fft or nfft_map.get(self.dim_f, self.dim_f * 2))
        self.hop = HOP
        self.trim = self.n_fft // 2
        self.chunk_size = self.hop * (self.dim_t - 1)
        self.gen_size = self.chunk_size - 2 * self.trim
        self.compensate = float(compensate)
        self.window = _hann_periodic(self.n_fft)

    def describe(self) -> str:
        return (f"{self.path.name}: dim_f={self.dim_f} dim_t={self.dim_t} "
                f"n_fft={self.n_fft} chunk={self.chunk_size} compensate={self.compensate}")


def _hann_periodic(n: int) -> np.ndarray:
    return np.hanning(n + 1)[:-1].astype(np.float32)   # matches torch.hann_window(periodic=True)


def _stft(x: np.ndarray, n_fft: int, hop: int, window: np.ndarray, dim_f: int) -> np.ndarray:
    """torch.stft(center=True, return_complex=False) → (2*channels, dim_f, frames)."""
    pad = n_fft // 2
    padded = np.pad(x, ((pad, pad), (0, 0)), mode="reflect")
    frames = 1 + (padded.shape[0] - n_fft) // hop
    view = np.lib.stride_tricks.sliding_window_view(padded, n_fft, axis=0)[::hop][:frames]
    spec = np.fft.rfft(view * window[None, None, :], axis=2)          # (frames, ch, bins)
    spec = spec.transpose(1, 2, 0)                                    # (ch, bins, frames)
    if spec.shape[1] < dim_f:                    # UVR zero-pads a short frequency axis
        spec = np.pad(spec, ((0, 0), (0, dim_f - spec.shape[1]), (0, 0)))
    spec = spec[:, :dim_f, :]                                         # (ch, dim_f, frames)
    out = np.stack([spec.real, spec.imag], axis=1)                    # (ch, 2, dim_f, frames)
    return out.reshape(2 * spec.shape[0], dim_f, frames).astype(np.float32)


def _istft(spec: np.ndarray, n_fft: int, hop: int, window: np.ndarray,
           length: int) -> np.ndarray:
    """Inverse of _stft: (4, dim_f, frames) real/imag → (samples, 2)."""
    ch, dim_f, frames = spec.shape
    bins = n_fft // 2 + 1
    comp = spec.reshape(ch // 2, 2, dim_f, frames)
    freq = (comp[:, 0] + 1j * comp[:, 1]).astype(np.complex64)        # (ch, dim_f, frames)
    padded = np.zeros((ch // 2, bins, frames), dtype=np.complex64)
    padded[:, :min(dim_f, bins), :] = freq[:, :min(dim_f, bins), :]
    out_len = n_fft + hop * (frames - 1)
    out = np.zeros((ch // 2, out_len), dtype=np.float32)
    wsum = np.zeros(out_len, dtype=np.float32)
    win_sq = (window ** 2).astype(np.float32)
    for i in range(frames):
        frame = np.fft.irfft(padded[:, :, i], n=n_fft, axis=-1).astype(np.float32)
        start = i * hop
        out[:, start:start + n_fft] += frame * window[None, :]
        wsum[start:start + n_fft] += win_sq
    wsum[wsum < 1e-8] = 1e-8
    out = out / wsum[None, :]
    centre = n_fft // 2
    out = out[:, centre:centre + length]
    if out.shape[1] < length:                     # pad if rounding lost samples
        out = np.pad(out, ((0, 0), (0, length - out.shape[1])))
    return out.T.astype(np.float32)


def mdx_demix(info: ModelInfo, mix: np.ndarray, overlap: float = 0.25,
              progress: bool = True) -> np.ndarray:
    """UVR's demix(): fold overlapping windows of the mix through the net.

    Returns the model's primary stem as (samples, 2). The secondary stem is
    computed by the caller as  mix - compensate * primary, exactly like UVR.
    """
    length = mix.shape[0]
    trim, chunk = info.trim, info.chunk_size
    step = max(1, int((1.0 - overlap) * chunk))

    pad = info.gen_size + trim - (length % info.gen_size)
    mixture = np.concatenate([
        np.zeros((trim, CHANNELS), dtype=np.float32),
        mix.astype(np.float32),
        np.zeros((pad, CHANNELS), dtype=np.float32),
    ], axis=0)

    total = len(range(0, mixture.shape[0], step))
    result = np.zeros((mixture.shape[0], CHANNELS), dtype=np.float64)
    divider = np.zeros((mixture.shape[0], 1), dtype=np.float64)

    started = time.time()
    for n, start in enumerate(range(0, mixture.shape[0], step), start=1):
        end = min(start + chunk, mixture.shape[0])
        part = mixture[start:end]
        real = end - start
        if real < chunk:                          # zero-pad the tail window
            part = np.pad(part, ((0, chunk - real), (0, 0)))
        window = _hann_periodic(real).astype(np.float32) if overlap != 0 else None

        spek = _stft(part, info.n_fft, info.hop, info.window, info.dim_f)
        spek[:, :3, :] = 0.0                      # UVR zeroes the lowest 3 bins
        pred = info.session.run(None, {info.session.get_inputs()[0].name: spek[None]})[0][0]
        wave = _istft(pred, info.n_fft, info.hop, info.window, chunk)

        if window is not None:
            wave[:real] *= window[:real, None]
            result[start:end] += wave[:real]
            divider[start:end, 0] += window[:real]
        else:
            result[start:end] += wave[:real]
            divider[start:end, 0] += 1.0

        if progress and (n % 5 == 0 or n == total):
            done = n / total
            elapsed = time.time() - started
            eta = elapsed / done * (1 - done) if done > 0 else 0
            log(f"      {n}/{total} windows  ({done * 100:4.0f}%  eta {hhmmss(eta)})")

    divider[divider < 1e-8] = 1e-8
    out = (result / divider)[trim:trim + length]
    return out.astype(np.float32)


def mdx_separate(info: ModelInfo, mix: np.ndarray, primary_is: str = "auto",
                 overlap: float = 0.25) -> Tuple[np.ndarray, np.ndarray]:
    """Returns (vocals, instrumental) whatever the model's primary stem is."""
    primary = mdx_demix(info, mix, overlap=overlap)
    secondary = (mix.astype(np.float32) - info.compensate * primary).astype(np.float32)

    # A model trained on vocals outputs vocals as primary; one trained on
    # instrumental outputs the instrumental. auto = the louder-difference rule:
    # the *removed* part is normally the smaller signal.
    if primary_is == "auto":
        primary_is = ("instrumental"
                      if float(np.mean(primary ** 2)) > float(np.mean(secondary ** 2))
                      else "vocals")
    if primary_is == "vocals":
        return primary, secondary
    return secondary, primary


# --------------------------------------------------------------------------- #
# Gmail input (optional, reuses the free exporter's login)
# --------------------------------------------------------------------------- #

def fetch_from_gmail(query: str, out_dir: Path, credentials: str, token: Optional[str]) -> Path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from gmail_audio_export import GmailClient  # reuse the existing tool
    except ImportError as exc:
        raise SystemExit(f"--from-gmail needs tools/gmail_audio_export.py next to this file ({exc})")

    token_path = Path(token).expanduser() if token else (out_dir / ".token.json")
    client = GmailClient(Path(credentials).expanduser(), token_path)
    log(f"  searching Gmail: {query}")
    for msg in client.iter_message_ids(query):
        parts = client.audio_parts(msg["id"])
        if parts:
            part = parts[0]
            dest = out_dir / "input" / re.sub(r"[^\w.\- ]", "_", part.filename)[:90]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(client.download(part))
            log(f"  downloaded {part.filename} ({human_mb(len(dest.read_bytes()) if False else part.size)})")
            return dest
    raise SystemExit(f"no audio attachment matched: {query}")


# --------------------------------------------------------------------------- #
# Player page
# --------------------------------------------------------------------------- #

def write_page(out_dir: Path, title: str, files: Dict[str, Path], meta: Dict[str, object]) -> Path:
    def rel(p: Path) -> str:
        return p.relative_to(out_dir).as_posix()

    solo = {k: v for k, v in files.items() if k in ("vocals", "instrumental", "karaoke")}
    extra_stems = {k: v for k, v in files.items() if k not in solo}
    rows = "".join(
        f"<li><b>{k}</b> — <audio controls preload='none' src='{rel(p)}'></audio></li>"
        for k, p in solo.items()
    )
    extra = "".join(f"<li><b>{k}</b> — <audio controls preload='none' src='{rel(p)}'></audio></li>"
                    for k, p in extra_stems.items())
    info = ", ".join(f"{k}: {v}" for k, v in meta.items())
    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Karaoke — {title}</title><style>
 :root{{color-scheme:light dark}} body{{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
 max-width:760px;margin:auto;padding:20px;line-height:1.5}}
 h1{{font-size:1.25rem;margin:0 0 2px}} .sub{{color:#6b7280;font-size:.82rem;margin-bottom:18px}}
 ul{{list-style:none;padding:0}} li{{padding:9px 0;border-bottom:1px solid #e5e7eb;font-size:.9rem}}
 audio{{width:100%;height:34px;margin-top:6px}}
 .mixer{{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin:18px 0}}
 @media(prefers-color-scheme:dark){{.mixer{{background:#111827;border-color:#1f2937}}}}
 .mixer label{{display:flex;align-items:center;gap:10px;font-size:.85rem}}
 input[type=range]{{flex:1}} .row{{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}}
 button{{font:inherit;padding:8px 14px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;cursor:pointer}}
 footer{{color:#9ca3af;font-size:.74rem;margin-top:22px}}
</style></head><body>
<h1>Karaoke — {title}</h1>
<div class="sub">{info}</div>

<div class="mixer">
  <strong style="font-size:.9rem">Practice mixer</strong>
  <p style="font-size:.8rem;color:#6b7280;margin:4px 0 12px">
    Instrumental at full volume; slide the guide vocal to taste, then press play.</p>
  <label>Guide vocal <input id="g" type="range" min="0" max="1" step="0.01" value="0.12">
    <span id="gv">12%</span></label>
  <div class="row"><button id="play">▶ Play</button><button id="stop">■ Stop</button></div>
  <audio id="none" style="display:none"></audio>
</div>

<ul>{rows}{extra}</ul>
<footer>Made with tools/karaoke_split.py — everything ran locally, nothing was uploaded.</footer>
<script>
const gEl=document.getElementById('g'), gv=document.getElementById('gv');
const ctx=new (window.AudioContext||window.webkitAudioContext)();
const srcs={{}}; let playing=false, gains={{}};
['instrumental','vocals'].forEach(n=>{{
  const el=[...document.querySelectorAll('audio')].find(a=>a.src.includes(n+'.'));
  if(!el) return;
  const s=ctx.createMediaElementSource(el), g=ctx.createGain();
  g.gain.value = n==='vocals' ? parseFloat(gEl.value) : 1;
  s.connect(g).connect(ctx.destination); srcs[n]=el; gains[n]=g;
}});
function sync(){{ if(gains.vocals) gains.vocals.gain.value=parseFloat(gEl.value);
  gv.textContent=Math.round(gEl.value*100)+'%'; }}
gEl.addEventListener('input',sync);
document.getElementById('play').onclick=async()=>{{
  await ctx.resume(); sync();
  Object.values(srcs).forEach(el=>{{el.currentTime=0; el.play();}});
  playing=true; }};
document.getElementById('stop').onclick=()=>{{ Object.values(srcs).forEach(el=>el.pause());
  playing=false; }};
</script></body></html>"""
    path = out_dir / "index.html"
    path.write_text(doc, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="Split a song into vocals + instrumental for karaoke.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=MODEL_HELP)
    p.add_argument("input", nargs="?", help="audio/video file to split")
    p.add_argument("-o", "--out", default="./karaoke", help="output folder (default ./karaoke)")
    p.add_argument("--method", choices=["mdx", "center"], default="mdx",
                   help="mdx = real AI separation (needs a model); center = no model, works now")
    p.add_argument("--model", action="append", default=[],
                   help="MDX-Net .onnx file (repeatable: vocal model + instrumental model)")
    p.add_argument("--models-dir", default="models", help="where models live (default ./models)")
    p.add_argument("--which", choices=["vocals", "instrumental", "auto"], default="auto",
                   help="what the model's main output is (default auto)")
    p.add_argument("--overlap", type=float, default=0.25, help="window overlap 0..0.9 (default 0.25)")
    p.add_argument("--compensate", type=float, default=1.035,
                   help="level match for the subtracted stem (default 1.035, UVR's value)")
    p.add_argument("--n-fft", type=int, default=None, help="override STFT size if the result sounds wrong")
    p.add_argument("--guide", type=float, default=0.12,
                   help="guide-vocal level baked into karaoke.mp3, 0..1 (default 0.12)")
    p.add_argument("--strength", type=float, default=1.0,
                   help="--method center: how much centre to remove (default 1.0)")
    p.add_argument("--format", default="wav", choices=["wav", "mp3", "both"],
                   help="stem format (default wav; mp3 is smaller for phones)")
    p.add_argument("--bitrate", default="192k", help="mp3 bitrate (default 192k)")
    p.add_argument("--split-stems", action="store_true",
                   help="also write drums/bass/other when those models are in --models-dir")
    p.add_argument("--from-gmail", metavar="QUERY", default=None,
                   help="fetch the song from Gmail instead of a local file")
    p.add_argument("--credentials", default="credentials.json")
    p.add_argument("--token", default=None)
    p.add_argument("--ffmpeg", default=None)
    p.add_argument("--models-help", action="store_true", help="print model download help and exit")
    args = p.parse_args(argv)

    if args.models_help:
        print(MODEL_HELP)
        return 0

    t0 = time.time()
    ffmpeg = find_ffmpeg(args.ffmpeg)
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- 1. get the audio -------------------------------------------------
    if args.from_gmail:
        source = fetch_from_gmail(args.from_gmail, out_dir, args.credentials, args.token)
    elif args.input:
        source = Path(args.input).expanduser()
        if not source.exists():
            raise SystemExit(f"no such file: {source}")
    else:
        raise SystemExit("give me an input file (or --from-gmail QUERY, or --models-help)")

    log(f"Song      : {source.name}")
    audio = decode_audio(ffmpeg, source)
    log(f"Decoded   : {len(audio) / SAMPLE_RATE:.1f}s, {SAMPLE_RATE} Hz, stereo")

    report = stereo_report(audio)
    log(f"Stereo    : side/mid {report['side_to_mid_percent']:.1f}%, "
        f"L/R correlation {report['correlation']:.2f}")

    # ---- 2. separate ------------------------------------------------------
    method = args.method
    model_desc = ""
    if method == "mdx":
        models = [Path(m).expanduser() for m in args.model]
        if not models:
            d = Path(args.models_dir).expanduser()
            models = sorted(d.glob("*.onnx")) if d.is_dir() else []
        if not models:
            log("\nNo MDX-Net model found.")
            print(MODEL_HELP)
            log("Falling back to --method center (no model needed)…\n")
            method = "center"
        elif not any(m.exists() for m in models):
            raise SystemExit(f"model file not found: {models[0]}")

    if method == "mdx":
        models = [m for m in models if m.exists()]
        log(f"Engine    : MDX-Net ONNX ({len(models)} model(s))")
        vocals = np.zeros_like(audio)
        instrumental = audio.copy()
        for model_path in models:
            info = ModelInfo(model_path, n_fft=args.n_fft, compensate=args.compensate)
            log(f"  model   : {info.describe()}")
            v, i = mdx_separate(info, instrumental if len(models) > 1 else audio,
                                primary_is=args.which, overlap=args.overlap)
            vocals = (vocals + v * (1.0 if len(models) == 1 else 0.5)).astype(np.float32)
            instrumental = i if len(models) == 1 else (instrumental * 0.5 + i * 0.5).astype(np.float32)
        model_desc = ", ".join(m.name for m in models)
    else:
        log("Engine    : centre-channel + spectral gate (no model)")
        if report["side_to_mid_percent"] < 1.0:
            log("  ! this looks almost mono — centre separation cannot work well on mono audio")
        vocals, instrumental = center_separate(audio, strength=args.strength)

    vocals, instrumental, gain = normalize_pair(vocals, instrumental)
    log(f"Levels    : joint gain {20 * math.log10(gain):+.1f} dB "
        f"(stems keep their original balance)")

    # ---- 3. write stems ---------------------------------------------------
    files: Dict[str, Path] = {}
    ext = args.format if args.format != "both" else "wav"
    outputs = {"vocals": vocals, "instrumental": instrumental,
               "karaoke": mix((instrumental, 1.0), (vocals, args.guide))}
    for name, data in outputs.items():
        wav = out_dir / f"{name}.wav"
        write_wav(wav, data)
        files[name] = wav
        if args.format in ("mp3", "both") and ffmpeg:
            mp3 = encode(ffmpeg, wav, out_dir / f"{name}.mp3", args.bitrate)
            files[name] = mp3
            if args.format == "mp3":
                wav.unlink(missing_ok=True)

    # optional extra stems (drums / bass / other) from models in --models-dir
    if args.split_stems and method == "mdx":
        d = Path(args.models_dir).expanduser()
        wanted = {"drums": "drums", "bass": "bass", "other": "other"}
        for name, token in wanted.items():
            hit = next((m for m in d.glob("*.onnx") if token in m.name.lower()), None) if d.is_dir() else None
            if not hit:
                log(f"  (no {name} model in {d} — skipped)")
                continue
            info = ModelInfo(hit, n_fft=args.n_fft, compensate=args.compensate)
            stem, _ = mdx_separate(info, instrumental, primary_is="auto", overlap=args.overlap)
            wav = out_dir / f"{name}.wav"
            write_wav(wav, stem)
            files[name] = wav
            log(f"  stem    : {name} ← {hit.name}")

    # ---- 4. page + manifest ----------------------------------------------
    meta = {
        "song": source.name[:60],
        "engine": ("MDX-Net: " + model_desc) if method == "mdx" else "centre-channel",
        "length": hhmmss(len(audio) / SAMPLE_RATE),
        "side/mid": f"{report['side_to_mid_percent']:.1f}%",
    }
    page = write_page(out_dir, source.stem[:50], files, meta)
    (out_dir / "manifest.json").write_text(json.dumps({
        "source": source.name, "method": method, "models": model_desc,
        "stereo": report, "guide_level": args.guide, "seconds": round(len(audio) / SAMPLE_RATE, 2),
        "files": {k: v.name for k, v in files.items()},
    }, indent=2), encoding="utf-8")

    log("\n" + "─" * 58)
    for name, path in files.items():
        size = path.stat().st_size
        log(f"  {name:<13} {path.name:<22} {human_mb(size)}")
    log(f"  player        {page.name}")
    log(f"Done in {time.time() - t0:.1f}s → {out_dir}")
    if method == "center":
        log("\nNote: the centre-channel method also thins any instrument that sits in\n"
            "the middle of the mix. For a clean karaoke track use --method mdx with\n"
            "a UVR model (see --models-help).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
