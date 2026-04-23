from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

import librosa
import numpy as np
import pyworld as pw


DEFAULT_SR = 16000
DEFAULT_FRAME_MS = 20
DEFAULT_FEATURE_HZ = 10
DEFAULT_WIN_SEC = 1.0

DEFAULT_N_FFT = 512
DEFAULT_HOP = 160
DEFAULT_WIN = 400

DEFAULT_SLOPE_SEC = 0.5

DEFAULT_NOISE_EMA_ALPHA = 0.95
DEFAULT_SNR_ON = 2.5
DEFAULT_SNR_OFF = 1.8
DEFAULT_HANGOVER_SEC = 0.20

DEFAULT_SMOOTH_ALPHA = 0.80

DEFAULT_W_SNR = 0.6
DEFAULT_W_SPEECH_BAND = 1.0
DEFAULT_W_LOW_RUMBLE = 1.0
DEFAULT_W_FLATNESS = 1.0
DEFAULT_SPEECH_CONF_THR = 0.0

DEFAULT_MEL_N_MELS = 64
DEFAULT_MEL_FMIN = 50.0
DEFAULT_MEL_FMAX = None
DEFAULT_EMIT_MEL_FRAME = True
DEFAULT_MEL_MAX_FRAMES = 700


@dataclass
class ProsodyConfig:
    sr: int = DEFAULT_SR
    frame_ms: int = DEFAULT_FRAME_MS
    feature_hz: int = DEFAULT_FEATURE_HZ
    win_sec: float = DEFAULT_WIN_SEC

    n_fft: int = DEFAULT_N_FFT
    hop: int = DEFAULT_HOP
    win: int = DEFAULT_WIN

    slope_sec: float = DEFAULT_SLOPE_SEC

    noise_ema_alpha: float = DEFAULT_NOISE_EMA_ALPHA
    snr_on: float = DEFAULT_SNR_ON
    snr_off: float = DEFAULT_SNR_OFF
    hangover_sec: float = DEFAULT_HANGOVER_SEC

    smooth_alpha: float = DEFAULT_SMOOTH_ALPHA

    w_snr: float = DEFAULT_W_SNR
    w_speech_band: float = DEFAULT_W_SPEECH_BAND
    w_low_rumble: float = DEFAULT_W_LOW_RUMBLE
    w_flatness: float = DEFAULT_W_FLATNESS
    speech_conf_thr: float = DEFAULT_SPEECH_CONF_THR

    mel_n_mels: int = DEFAULT_MEL_N_MELS
    mel_fmin: float = DEFAULT_MEL_FMIN
    mel_fmax: float | None = DEFAULT_MEL_FMAX
    emit_mel_frame: bool = DEFAULT_EMIT_MEL_FRAME
    mel_max_frames: int = DEFAULT_MEL_MAX_FRAMES

    @property
    def frame_samples(self) -> int:
        return self.sr * self.frame_ms // 1000

    @property
    def frame_bytes(self) -> int:
        return self.frame_samples * 2

    @property
    def out_interval(self) -> float:
        return 1.0 / self.feature_hz

    @property
    def win_samples(self) -> int:
        return int(self.sr * self.win_sec)

    @property
    def slope_n(self) -> int:
        return max(3, int(round(self.slope_sec * self.feature_hz)) + 1)


@dataclass
class ProsodyState:
    vad_on: bool = False
    speech_start_ts: float | None = None
    last_voice_ts: float | None = None
    noise_rms: float = 0.01

    snr_sm: float | None = None
    flat_sm: float | None = None
    flux_sm: float | None = None
    speech_ratio_sm: float | None = None
    low_ratio_sm: float | None = None

    speech_rmsdb_hist: deque[float] = field(default_factory=lambda: deque(maxlen=400))


def rms_from_int16(x: np.ndarray) -> float:
    xf = x.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(xf * xf) + 1e-12))


def ema(prev: float | None, x: float, alpha: float = DEFAULT_SMOOTH_ALPHA) -> float:
    if prev is None:
        return float(x)
    return float(alpha * prev + (1.0 - alpha) * float(x))


def clamp01(x: float) -> float:
    return float(max(0.0, min(1.0, float(x))))


def norm_range(x: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 0.0
    return clamp01((float(x) - float(lo)) / (float(hi) - float(lo)))


def slope_from_last(values: list[float] | np.ndarray, hz: float) -> float:
    if len(values) < 3:
        return 0.0
    y = np.asarray(values, dtype=float)
    x = np.arange(len(y), dtype=float)
    m = np.polyfit(x, y, 1)[0]
    return float(m * float(hz))


def pitch_features_from_buffer(x_int16: np.ndarray, sr: int) -> tuple[float, float, float]:
    if x_int16.size < int(sr * 0.2):
        return 0.0, 0.0, 0.0

    x = (x_int16.astype(np.float64) / 32768.0).copy()
    x -= np.mean(x)

    try:
        _f0, t = pw.dio(x, sr)
        f0 = pw.stonemask(x, _f0, t, sr)
    except Exception:
        return 0.0, 0.0, 0.0

    voiced = f0 > 0
    voiced_ratio = float(np.mean(voiced)) if f0.size else 0.0
    if voiced_ratio < 0.05:
        return 0.0, 0.0, voiced_ratio

    f0_voiced = f0[voiced]
    f0_mean = float(np.mean(f0_voiced))

    cutoff = t[-1] - 0.5 if t.size else 0.0
    idx = (t >= cutoff) & voiced
    if np.sum(idx) >= 3:
        tt = t[idx]
        yy = f0[idx]
        f0_slope = float(np.polyfit(tt, yy, 1)[0])
    else:
        f0_slope = 0.0

    return f0_mean, f0_slope, voiced_ratio


def compute_mel_spectrogram(
    y: np.ndarray,
    sr: int,
    *,
    n_fft: int,
    hop: int,
    win: int,
    n_mels: int,
    fmin: float,
    fmax: float | None,
) -> np.ndarray:
    fmax_use = float(fmax) if fmax is not None else float(sr / 2)
    power = (
        np.abs(
            librosa.stft(
                y,
                n_fft=n_fft,
                hop_length=hop,
                win_length=win,
                center=False,
            )
        )
        ** 2
    )

    mel = librosa.feature.melspectrogram(
        S=power,
        sr=sr,
        n_mels=n_mels,
        fmin=fmin,
        fmax=fmax_use,
    )
    mel_db = librosa.power_to_db(mel, ref=1.0, top_db=80.0)
    return mel_db


def downsample_spectrogram(mel_db: np.ndarray, max_frames: int) -> tuple[np.ndarray, np.ndarray]:
    if mel_db.size == 0:
        return mel_db, np.array([], dtype=float)

    frames = mel_db.shape[1]
    if frames <= max_frames:
        idx = np.arange(frames)
        return mel_db, idx.astype(float)

    idx = np.linspace(0, frames - 1, max_frames).astype(int)
    mel_ds = mel_db[:, idx]
    return mel_ds, idx.astype(float)


def compute_dsp_features(
    y: np.ndarray,
    sr: int = DEFAULT_SR,
    *,
    n_fft: int = DEFAULT_N_FFT,
    hop: int = DEFAULT_HOP,
    win: int = DEFAULT_WIN,
    mel_n_mels: int = DEFAULT_MEL_N_MELS,
    mel_fmin: float = DEFAULT_MEL_FMIN,
    mel_fmax: float | None = DEFAULT_MEL_FMAX,
    emit_mel_frame: bool = DEFAULT_EMIT_MEL_FRAME,
) -> dict[str, float]:
    if y is None or y.size < win:
        base = {
            "rmsDb": 0.0,
            "zcr": 0.0,
            "specCentroid": 0.0,
            "specRolloff": 0.0,
            "specFlatness": 0.0,
            "specFlux": 0.0,
            "lowEnergyRatio": 0.0,
            "speechEnergyRatio": 0.0,
            "highEnergyRatio": 0.0,
            "speechRmsDb": 0.0,
            "mfcc0": 0.0,
            "mfcc1": 0.0,
            "mfcc2": 0.0,
            "mfccDelta0": 0.0,
        }
        if emit_mel_frame:
            base["melFrame"] = [0.0 for _ in range(mel_n_mels)]
        return base

    rms = float(np.sqrt(np.mean(y * y) + 1e-12))
    rms_db = float(20.0 * np.log10(rms + 1e-9))

    zcr = float(
        librosa.feature.zero_crossing_rate(
            y,
            frame_length=win,
            hop_length=hop,
            center=False,
        ).mean()
    )

    S = (
        np.abs(
            librosa.stft(
                y,
                n_fft=n_fft,
                hop_length=hop,
                win_length=win,
                center=False,
            )
        )
        + 1e-9
    )

    centroid = float(librosa.feature.spectral_centroid(S=S, sr=sr).mean())
    rolloff = float(librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=0.85).mean())
    flatness = float(librosa.feature.spectral_flatness(S=S).mean())

    dS = np.diff(S, axis=1)
    flux = float(np.mean(np.sqrt(np.sum(np.maximum(dS, 0.0) ** 2, axis=0)))) if dS.size else 0.0

    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    total = float(np.sum(S))

    low = (freqs >= 0) & (freqs <= 200)
    speech = (freqs >= 300) & (freqs <= 3400)
    high = (freqs >= 4000) & (freqs <= min(8000, sr / 2))

    low_ratio = float(np.sum(S[low, :]) / (total + 1e-9))
    speech_ratio = float(np.sum(S[speech, :]) / (total + 1e-9))
    high_ratio = float(np.sum(S[high, :]) / (total + 1e-9))

    speech_power = float(np.mean(S[speech, :] ** 2)) if np.any(speech) else 0.0
    speech_rms = float(np.sqrt(speech_power + 1e-12))
    speech_rms_db = float(20.0 * np.log10(speech_rms + 1e-9))

    mfcc = librosa.feature.mfcc(
        y=y,
        sr=sr,
        n_mfcc=13,
        n_fft=n_fft,
        hop_length=hop,
        win_length=win,
        center=False,
    )

    if mfcc.shape[1] >= 9:
        d1 = librosa.feature.delta(mfcc)
        mfcc_delta0 = float(d1[0].mean())
    else:
        mfcc_delta0 = 0.0

    out = {
        "rmsDb": rms_db,
        "zcr": zcr,
        "specCentroid": centroid,
        "specRolloff": rolloff,
        "specFlatness": flatness,
        "specFlux": flux,
        "lowEnergyRatio": low_ratio,
        "speechEnergyRatio": speech_ratio,
        "highEnergyRatio": high_ratio,
        "speechRmsDb": speech_rms_db,
        "mfcc0": float(mfcc[0].mean()) if mfcc.shape[0] > 0 else 0.0,
        "mfcc1": float(mfcc[1].mean()) if mfcc.shape[0] > 1 else 0.0,
        "mfcc2": float(mfcc[2].mean()) if mfcc.shape[0] > 2 else 0.0,
        "mfccDelta0": mfcc_delta0,
    }

    if emit_mel_frame:
        fmax_use = float(mel_fmax) if mel_fmax is not None else float(sr / 2)
        mel = librosa.feature.melspectrogram(
            S=(S**2),
            sr=sr,
            n_mels=mel_n_mels,
            fmin=mel_fmin,
            fmax=fmax_use,
        )
        mel_db = librosa.power_to_db(mel, ref=1.0, top_db=80.0)
        if mel_db.shape[1] > 0:
            mel_frame = mel_db[:, -1]
        else:
            mel_frame = np.zeros(mel_n_mels, dtype=float)
        out["melFrame"] = [float(v) for v in mel_frame]

    return out


def speech_confidence(
    snr_like: float,
    speech_ratio: float,
    low_ratio: float,
    flatness: float,
    *,
    w_snr: float = DEFAULT_W_SNR,
    w_speech_band: float = DEFAULT_W_SPEECH_BAND,
    w_low_rumble: float = DEFAULT_W_LOW_RUMBLE,
    w_flatness: float = DEFAULT_W_FLATNESS,
) -> float:
    return (
        w_snr * float(snr_like)
        + w_speech_band * float(speech_ratio)
        - w_low_rumble * float(low_ratio)
        - w_flatness * float(flatness)
    )


def boundary_confidence(
    pause_ms: float,
    energy_slope: float,
    f0_slope: float,
    flux_sm: float,
    voiced_ratio: float,
    *,
    micro_min: float = 250,
    micro_max: float = 700,
    flux_thr: float = 3.0,
    energy_fall_thr: float = -0.8,
    f0_fall_thr: float = -15.0,
) -> float:
    if pause_ms < micro_min or pause_ms > micro_max:
        return 0.0

    score = 0.35
    if energy_slope < energy_fall_thr:
        score += 0.20
    if voiced_ratio > 0.2 and f0_slope < f0_fall_thr:
        score += 0.25
    if flux_sm > flux_thr:
        score += 0.20

    return max(0.0, min(1.0, score))


def init_prosody_state() -> ProsodyState:
    return ProsodyState()


def update_prosody_frame(
    frame_int16: np.ndarray,
    ring: np.ndarray,
    ring_write: int,
    ring_filled: int,
    state: ProsodyState,
    now_sec: float,
    *,
    config: ProsodyConfig,
) -> tuple[int, int, dict[str, Any] | None]:
    rms_frame = rms_from_int16(frame_int16)

    n = frame_int16.size
    end = ring_write + n
    if end <= ring.size:
        ring[ring_write:end] = frame_int16
    else:
        first = ring.size - ring_write
        ring[ring_write:] = frame_int16[:first]
        ring[: end - ring.size] = frame_int16[first:]

    ring_write = (ring_write + n) % ring.size
    ring_filled = min(ring.size, ring_filled + n)

    if not state.vad_on:
        state.noise_rms = (
            config.noise_ema_alpha * state.noise_rms
            + (1.0 - config.noise_ema_alpha) * rms_frame
        )

    snr_like = rms_frame / (state.noise_rms + 1e-6)

    if state.vad_on:
        if snr_like >= config.snr_off:
            state.last_voice_ts = now_sec
        else:
            if state.last_voice_ts and (now_sec - state.last_voice_ts) > config.hangover_sec:
                state.vad_on = False
                state.speech_start_ts = None
    else:
        if snr_like >= config.snr_on:
            state.vad_on = True
            state.speech_start_ts = now_sec
            state.last_voice_ts = now_sec

    if ring_filled < ring.size:
        x_win = ring[:ring_filled].copy()
    else:
        x_win = np.concatenate([ring[ring_write:], ring[:ring_write]])

    pause_ms = 0.0
    speech_ms = 0.0
    if state.vad_on:
        speech_ms = (now_sec - (state.speech_start_ts or now_sec)) * 1000.0
    else:
        if state.last_voice_ts:
            pause_ms = (now_sec - state.last_voice_ts) * 1000.0

    f0_mean, f0_slope, voiced_ratio = pitch_features_from_buffer(x_win, config.sr)

    y = x_win.astype(np.float32) / 32768.0
    dsp = compute_dsp_features(
        y,
        config.sr,
        n_fft=config.n_fft,
        hop=config.hop,
        win=config.win,
        mel_n_mels=config.mel_n_mels,
        mel_fmin=config.mel_fmin,
        mel_fmax=config.mel_fmax,
        emit_mel_frame=config.emit_mel_frame,
    )

    state.snr_sm = ema(state.snr_sm, snr_like, config.smooth_alpha)
    state.flat_sm = ema(state.flat_sm, dsp["specFlatness"], config.smooth_alpha)
    state.flux_sm = ema(state.flux_sm, dsp["specFlux"], config.smooth_alpha)
    state.speech_ratio_sm = ema(state.speech_ratio_sm, dsp["speechEnergyRatio"], config.smooth_alpha)
    state.low_ratio_sm = ema(state.low_ratio_sm, dsp["lowEnergyRatio"], config.smooth_alpha)

    state.speech_rmsdb_hist.append(dsp["speechRmsDb"])
    speech_energy_slope = slope_from_last(
        list(state.speech_rmsdb_hist)[-config.slope_n:],
        config.feature_hz,
    )

    sp_conf = speech_confidence(
        state.snr_sm,
        state.speech_ratio_sm,
        state.low_ratio_sm,
        state.flat_sm,
        w_snr=config.w_snr,
        w_speech_band=config.w_speech_band,
        w_low_rumble=config.w_low_rumble,
        w_flatness=config.w_flatness,
    )
    speech_like = 1 if sp_conf >= config.speech_conf_thr else 0

    bconf = boundary_confidence(
        pause_ms=pause_ms,
        energy_slope=speech_energy_slope,
        f0_slope=f0_slope,
        flux_sm=float(state.flux_sm or 0.0),
        voiced_ratio=voiced_ratio,
    )

    # turn-taking / question / engagement heuristics
    pause_norm = norm_range(pause_ms, 200.0, 900.0)
    speech_norm = norm_range(speech_ms, 400.0, 2500.0)
    energy_fall = norm_range(-speech_energy_slope, 0.3, 1.5)
    f0_fall = norm_range(-f0_slope, 5.0, 50.0)
    voiced_norm = norm_range(voiced_ratio, 0.15, 0.6)
    question_like = clamp01(norm_range(f0_slope, 5.0, 60.0) * 0.6 + norm_range(pause_ms, 120.0, 450.0) * 0.4)

    turn_end_score = clamp01(
        0.45 * pause_norm
        + 0.25 * energy_fall
        + 0.20 * f0_fall
        + 0.10 * speech_norm
    )

    engagement_score = clamp01(
        0.40 * norm_range(dsp["rmsDb"], -45.0, -12.0)
        + 0.30 * norm_range(dsp["specFlux"], 1.0, 6.0)
        + 0.30 * norm_range(dsp["specCentroid"], 1200.0, 3800.0)
    )

    out = {
        "type": "prosody_features",
        "vad": 1 if state.vad_on else 0,
        "rms": float(rms_frame),
        "noiseRms": float(state.noise_rms),
        "snrLike": float(snr_like),
        "pauseMs": float(pause_ms),
        "speechMs": float(speech_ms),
        "f0Mean": float(f0_mean),
        "f0Slope": float(f0_slope),
        "voicedRatio": float(voiced_ratio),
        **dsp,
        "snrLikeSm": float(state.snr_sm or 0.0),
        "specFlatnessSm": float(state.flat_sm or 0.0),
        "specFluxSm": float(state.flux_sm or 0.0),
        "speechEnergyRatioSm": float(state.speech_ratio_sm or 0.0),
        "lowEnergyRatioSm": float(state.low_ratio_sm or 0.0),
        "speechEnergySlope": float(speech_energy_slope),
        "speechConfidence": float(sp_conf),
        "speechLike": int(speech_like),
        "boundaryConfidence": float(bconf),
        "turnEndScore": float(turn_end_score),
        "questionLike": float(question_like),
        "engagementScore": float(engagement_score),
    }

    return ring_write, ring_filled, out


def load_audio_mono_16k(path: str, sr: int = DEFAULT_SR) -> np.ndarray:
    y, _ = librosa.load(path, sr=sr, mono=True)
    y = np.asarray(y, dtype=np.float32)
    y = np.clip(y, -1.0, 1.0)
    return y


def float_audio_to_int16(y: np.ndarray) -> np.ndarray:
    return np.clip(y * 32768.0, -32768, 32767).astype(np.int16)


def summarize_feature_timeline(features: list[dict[str, Any]]) -> dict[str, float]:
    if not features:
        return {
            "durationSec": 0.0,
            "numFrames": 0.0,
            "meanRmsDb": 0.0,
            "meanF0": 0.0,
            "meanSpeechConfidence": 0.0,
            "meanBoundaryConfidence": 0.0,
            "voicedFrameRatio": 0.0,
            "speechLikeRatio": 0.0,
        }

    def mean_of(key: str) -> float:
        vals = [float(f.get(key, 0.0)) for f in features]
        return float(np.mean(vals)) if vals else 0.0

    voiced_ratio = float(np.mean([1.0 if f.get("voicedRatio", 0.0) > 0.05 else 0.0 for f in features]))
    speech_like_ratio = float(np.mean([float(f.get("speechLike", 0)) for f in features]))
    duration_sec = float(features[-1].get("t", 0.0)) if features else 0.0

    voiced_f0 = [float(f["f0Mean"]) for f in features if float(f.get("f0Mean", 0.0)) > 0.0]
    mean_f0 = float(np.mean(voiced_f0)) if voiced_f0 else 0.0

    return {
        "durationSec": duration_sec,
        "numFrames": float(len(features)),
        "meanRmsDb": mean_of("rmsDb"),
        "meanF0": mean_f0,
        "meanSpeechConfidence": mean_of("speechConfidence"),
        "meanBoundaryConfidence": mean_of("boundaryConfidence"),
        "voicedFrameRatio": voiced_ratio,
        "speechLikeRatio": speech_like_ratio,
    }


def build_segments(features: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not features:
        return [], []

    segments: list[dict[str, Any]] = []
    boundaries: list[dict[str, Any]] = []

    def label_of(f: dict[str, Any]) -> str:
        bc = float(f.get("boundaryConfidence", 0.0))
        vad = int(f.get("vad", 0))
        voiced = float(f.get("voicedRatio", 0.0))
        pause_ms = float(f.get("pauseMs", 0.0))

        if bc >= 0.60:
            return "boundary"
        if vad == 1 or voiced > 0.20:
            return "voiced"
        if pause_ms > 150:
            return "pause"
        return "inactive"

    current_label = label_of(features[0])
    start_t = float(features[0].get("t", 0.0))

    first_bc = float(features[0].get("boundaryConfidence", 0.0))
    if first_bc >= 0.60:
        boundaries.append({
            "t": float(features[0].get("t", 0.0)),
            "confidence": first_bc,
        })

    for i in range(1, len(features)):
        f = features[i]
        t = float(f.get("t", 0.0))
        label = label_of(f)
        bc = float(f.get("boundaryConfidence", 0.0))

        if bc >= 0.60:
            boundaries.append({"t": t, "confidence": bc})

        if label != current_label:
            prev_t = float(features[i - 1].get("t", t))
            segments.append({
                "start": start_t,
                "end": prev_t,
                "type": current_label,
            })
            current_label = label
            start_t = t

    segments.append({
        "start": start_t,
        "end": float(features[-1].get("t", start_t)),
        "type": current_label,
    })

    return segments, boundaries


def analyze_audio_file(
    path: str,
    *,
    config: ProsodyConfig | None = None,
    include_features: bool = True,
) -> dict[str, Any]:
    config = config or ProsodyConfig()

    y = load_audio_mono_16k(path, sr=config.sr)
    return analyze_audio_array(y, config=config, include_features=include_features)


def analyze_audio_array(
    y: np.ndarray,
    *,
    config: ProsodyConfig | None = None,
    include_features: bool = True,
) -> dict[str, Any]:
    config = config or ProsodyConfig()
    y = np.asarray(y, dtype=np.float32)
    y = np.clip(y, -1.0, 1.0)

    x_int16 = float_audio_to_int16(y)

    ring = np.zeros(config.win_samples, dtype=np.int16)
    ring_write = 0
    ring_filled = 0
    state = init_prosody_state()

    frame_samples = config.frame_samples
    output_every_n_frames = max(1, round((config.sr / frame_samples) / config.feature_hz))

    features: list[dict[str, Any]] = []

    frame_idx = 0
    for start in range(0, len(x_int16) - frame_samples + 1, frame_samples):
        frame = x_int16[start:start + frame_samples]
        now_sec = start / config.sr

        ring_write, ring_filled, out = update_prosody_frame(
            frame,
            ring,
            ring_write,
            ring_filled,
            state,
            now_sec,
            config=config,
        )

        if frame_idx % output_every_n_frames == 0 and out is not None:
            out = dict(out)
            out["t"] = float(now_sec)
            features.append(out)

        frame_idx += 1

    segments, boundaries = build_segments(features)

    result = {
        "type": "clip_analysis",
        "summary": summarize_feature_timeline(features),
        "segments": segments,
        "boundaries": boundaries,
    }

    if include_features:
        result["features"] = features

    return result
