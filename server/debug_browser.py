import asyncio
import json
import os
import tempfile
import wave
from typing import Any

import librosa
import numpy as np
import uvicorn
import websockets
from fastapi import FastAPI, File, Form, UploadFile, WebSocket, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

try:
    from scipy.signal import butter, filtfilt
except Exception:  # pragma: no cover
    butter = None
    filtfilt = None

from prosody_core import (
    ProsodyConfig,
    analyze_audio_array,
    compute_mel_spectrogram,
    downsample_spectrogram,
    float_audio_to_int16,
    load_audio_mono_16k,
)

PROSODY_WS = os.getenv("PROSODY_WS", "ws://localhost:8765")
DEBUG_BROWSER_HOST = os.getenv("DEBUG_BROWSER_HOST", "127.0.0.1")
DEBUG_BROWSER_PORT = int(os.getenv("DEBUG_BROWSER_PORT", "8000"))

BASE_DIR = os.path.dirname(__file__)
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

latest = None
clients = set()
audio_cache = {"processed": None, "original": None}


def _ensure_runtime_dirs() -> None:
    os.makedirs(STATIC_DIR, exist_ok=True)
    os.makedirs(TEMPLATES_DIR, exist_ok=True)


def _template_response(name: str) -> FileResponse | HTMLResponse:
    path = os.path.join(TEMPLATES_DIR, name)
    if os.path.exists(path):
        return FileResponse(path)
    return HTMLResponse(
        f"Missing template: {name}. Expected at {path}.",
        status_code=503,
    )


_ensure_runtime_dirs()
app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _butter_filter(y: np.ndarray, sr: int, *, low: float | None, high: float | None) -> np.ndarray:
    if butter is None or filtfilt is None:
        if low is not None:
            return librosa.effects.preemphasis(y, coef=0.97)
        return y

    nyq = 0.5 * float(sr)
    lo = None if low is None else float(low) / nyq
    hi = None if high is None else float(high) / nyq

    if lo is not None and lo <= 0:
        lo = None
    if hi is not None and hi >= 1:
        hi = 0.99

    if lo is None and hi is None:
        return y

    if lo is not None and hi is not None:
        btype = "bandpass"
        Wn = [lo, hi]
    elif lo is not None:
        btype = "highpass"
        Wn = lo
    else:
        btype = "lowpass"
        Wn = hi

    b, a = butter(4, Wn, btype=btype)
    return filtfilt(b, a, y).astype(np.float32)


def apply_filters(y: np.ndarray, sr: int, filters: list[str]) -> np.ndarray:
    if y is None or y.size == 0:
        return y

    out = np.asarray(y, dtype=np.float32)
    out = np.clip(out, -1.0, 1.0)

    if "noise" in filters:
        stft = librosa.stft(out)
        mag = np.abs(stft)
        phase = stft / np.maximum(mag, 1e-9)
        noise_profile = np.median(mag, axis=1, keepdims=True)
        mask = mag >= (noise_profile * 1.5)
        mag_d = mag * mask
        out = librosa.istft(mag_d * phase, length=out.shape[0])

    if "highpass" in filters:
        out = _butter_filter(out, sr, low=80.0, high=None)

    if "bandpass" in filters:
        out = _butter_filter(out, sr, low=80.0, high=4000.0)

    if "normalize" in filters:
        rms = float(np.sqrt(np.mean(out * out) + 1e-12))
        target = 0.1
        out = out * (target / max(rms, 1e-6))

    if "preemphasis" in filters:
        out = librosa.effects.preemphasis(out, coef=0.97)

    if "distortion" in filters:
        drive = 2.5
        out = np.tanh(out * drive)

    if "tremolo" in filters:
        rate_hz = 5.0
        depth = 0.6
        t = np.arange(out.shape[0], dtype=np.float32) / float(sr)
        mod = 1.0 - depth + depth * (0.5 * (1.0 + np.sin(2 * np.pi * rate_hz * t)))
        out = out * mod

    if "sawtooth" in filters:
        rate_hz = 4.0
        depth = 0.5
        t = np.arange(out.shape[0], dtype=np.float32) / float(sr)
        phase = (t * rate_hz) % 1.0
        wave = 2.0 * phase - 1.0
        mod = 1.0 - depth + depth * ((wave + 1.0) / 2.0)
        out = out * mod

    if "ringmod" in filters:
        rate_hz = 35.0
        depth = 0.7
        t = np.arange(out.shape[0], dtype=np.float32) / float(sr)
        carrier = np.sin(2 * np.pi * rate_hz * t)
        out = out * (1.0 - depth + depth * carrier)

    if "bitcrush" in filters:
        bits = 6
        levels = float(2 ** bits)
        out = np.round(out * levels) / levels

    if "echo" in filters:
        delay_sec = 0.18
        decay = 0.45
        delay = int(delay_sec * sr)
        if delay > 0:
            wet = np.zeros_like(out)
            wet[delay:] = out[:-delay]
            out = np.clip(out + (wet * decay), -1.0, 1.0)

    return np.clip(out, -1.0, 1.0)


def _write_wav(path: str, y: np.ndarray, sr: int) -> None:
    x = float_audio_to_int16(y)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(x.tobytes())


def _store_audio(variant: str, y: np.ndarray, sr: int) -> str:
    prev = audio_cache.get(variant)
    if prev:
        try:
            os.unlink(prev)
        except Exception:
            pass
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    tmp.close()
    _write_wav(tmp.name, y, sr)
    audio_cache[variant] = tmp.name
    return tmp.name


@app.get("/")
def root():
    return _template_response("index.html")


@app.get("/legend")
def legend_page():
    return _template_response("legend.html")


@app.get("/clip_audio")
def clip_audio(variant: str = "processed"):
    path = audio_cache.get(variant)
    if not path or not os.path.exists(path):
        return HTMLResponse("No audio available", status_code=404)
    return FileResponse(path, media_type="audio/wav")


@app.websocket("/ws")
async def ws_clients(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        if latest is not None:
            await ws.send_text(json.dumps(latest))
        while True:
            await asyncio.sleep(10)
    finally:
        clients.discard(ws)


@app.post("/analyze_clip")
async def analyze_clip(file: UploadFile = File(...), filters: str | None = Form(None)):
    data = await file.read()
    max_bytes = 50 * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")
    suffix = os.path.splitext(file.filename or "")[1].lower() or ".wav"

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        cfg = ProsodyConfig()
        y = load_audio_mono_16k(tmp_path, sr=cfg.sr)

        allowed_filters = {
            "noise",
            "highpass",
            "bandpass",
            "normalize",
            "preemphasis",
            "distortion",
            "tremolo",
            "sawtooth",
            "ringmod",
            "bitcrush",
            "echo",
        }
        filter_list: list[str] = []
        if filters:
            try:
                parsed = json.loads(filters)
                if isinstance(parsed, list):
                    filter_list = [f for f in parsed if isinstance(f, str) and f in allowed_filters]
            except Exception:
                filter_list = []

        y_filtered = apply_filters(y, cfg.sr, filter_list)
        _store_audio("original", y, cfg.sr)
        _store_audio("processed", y_filtered, cfg.sr)

        result: dict[str, Any] = analyze_audio_array(y_filtered, config=cfg, include_features=True)

        mel_db = compute_mel_spectrogram(
            y_filtered,
            cfg.sr,
            n_fft=cfg.n_fft,
            hop=cfg.hop,
            win=cfg.win,
            n_mels=cfg.mel_n_mels,
            fmin=cfg.mel_fmin,
            fmax=cfg.mel_fmax,
        )
        mel_ds, _ = downsample_spectrogram(mel_db, cfg.mel_max_frames)
        hop_sec = float(cfg.hop) / float(cfg.sr)
        if mel_db.shape[1] > 0 and mel_ds.shape[1] > 0:
            hop_sec = hop_sec * (float(mel_db.shape[1]) / float(mel_ds.shape[1]))
        result["melSpectrogram"] = mel_ds.tolist()
        result["melFrameHopSec"] = hop_sec

        original = analyze_audio_array(y, config=cfg, include_features=True)
        mel_db_raw = compute_mel_spectrogram(
            y,
            cfg.sr,
            n_fft=cfg.n_fft,
            hop=cfg.hop,
            win=cfg.win,
            n_mels=cfg.mel_n_mels,
            fmin=cfg.mel_fmin,
            fmax=cfg.mel_fmax,
        )
        mel_ds_raw, _ = downsample_spectrogram(mel_db_raw, cfg.mel_max_frames)
        hop_sec_raw = float(cfg.hop) / float(cfg.sr)
        if mel_db_raw.shape[1] > 0 and mel_ds_raw.shape[1] > 0:
            hop_sec_raw = hop_sec_raw * (float(mel_db_raw.shape[1]) / float(mel_ds_raw.shape[1]))
        original["melSpectrogram"] = mel_ds_raw.tolist()
        original["melFrameHopSec"] = hop_sec_raw
        result["original"] = original

        return result
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


async def prosody_listener():
    global latest
    while True:
        try:
            async with websockets.connect(PROSODY_WS, max_size=2**23) as ws:
                await ws.send("monitor")
                while True:
                    msg = await ws.recv()
                    if isinstance(msg, bytes):
                        continue
                    d = json.loads(msg)
                    if d.get("type") != "prosody_features":
                        continue
                    latest = d
                    payload = json.dumps(d)
                    dead = []
                    for c in list(clients):
                        try:
                            await c.send_text(payload)
                        except Exception:
                            dead.append(c)
                    for c in dead:
                        clients.discard(c)
        except Exception:
            await asyncio.sleep(1)


@app.on_event("startup")
async def _startup():
    asyncio.create_task(prosody_listener())


if __name__ == "__main__":
    uvicorn.run(app, host=DEBUG_BROWSER_HOST, port=DEBUG_BROWSER_PORT)
