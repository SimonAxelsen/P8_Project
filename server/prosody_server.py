import asyncio, json, os, time
from collections import deque
import numpy as np
import websockets
import pyworld as pw
import librosa

HOST = os.getenv("PROSODY_HOST", "0.0.0.0")
PORT = int(os.getenv("PROSODY_PORT", "8765"))

SR = 16000

FRAME_MS = int(os.getenv("PROSODY_FRAME_MS", "20"))
FRAME_SAMPLES = SR * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono

FEATURE_HZ = int(os.getenv("PROSODY_FEATURE_HZ", "10"))
OUT_INTERVAL = 1.0 / FEATURE_HZ

WIN_SEC = float(os.getenv("PROSODY_WIN_SEC", "1.0"))
WIN_SAMPLES = int(SR * WIN_SEC)

# STFT params (25ms window, 10ms hop at 16k)
N_FFT = int(os.getenv("PROSODY_NFFT", "512"))
HOP = int(os.getenv("PROSODY_HOP", "160"))
WIN = int(os.getenv("PROSODY_WIN", "400"))

# Slope window (seconds) for energy slope
SLOPE_SEC = float(os.getenv("PROSODY_SLOPE_SEC", "0.5"))
SLOPE_N = max(3, int(round(SLOPE_SEC * FEATURE_HZ)) + 1)  # number of points

# VAD parameters
NOISE_EMA_ALPHA = float(os.getenv("PROSODY_NOISE_ALPHA", "0.95"))
SNR_ON = float(os.getenv("PROSODY_SNR_ON", "2.5"))
SNR_OFF = float(os.getenv("PROSODY_SNR_OFF", "1.8"))
HANGOVER_SEC = float(os.getenv("PROSODY_HANGOVER_SEC", "0.20"))

# (1) Smoothing EMAs
SMOOTH_ALPHA = float(os.getenv("PROSODY_SMOOTH_ALPHA", "0.80"))  # 0.7–0.9 typical

# (2) Speech-confidence gate weights
# Higher means more confident that audio is speech-like
W_SNR = float(os.getenv("PROSODY_W_SNR", "0.6"))
W_SPEECH_BAND = float(os.getenv("PROSODY_W_SPEECH_BAND", "1.0"))
W_LOW_RUMBLE = float(os.getenv("PROSODY_W_LOW_RUMBLE", "1.0"))
W_FLATNESS = float(os.getenv("PROSODY_W_FLATNESS", "1.0"))

SPEECH_CONF_THR = float(os.getenv("PROSODY_SPEECHCONF_THR", "0.0"))  # gate threshold (tune)

SUBSCRIBERS = set()


class State:
    def __init__(self):
        self.vad_on = False
        self.speech_start_ts = None
        self.last_voice_ts = None
        self.noise_rms = 0.01

        # (1) EMA-smoothed versions of key signals
        self.snr_sm = None
        self.flat_sm = None
        self.flux_sm = None
        self.speech_ratio_sm = None
        self.low_ratio_sm = None

        # (3) Track speech-band energy slope
        self.speech_rmsdb_hist = deque(maxlen=400)  # keep plenty for slope windows


def rms_from_int16(x: np.ndarray) -> float:
    xf = x.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(xf * xf) + 1e-12))


def pitch_features_from_buffer(x_int16: np.ndarray, sr: int):
    """Returns f0Mean (Hz), f0Slope (Hz/sec), voicedRatio (0..1)."""
    if x_int16.size < int(sr * 0.2):
        return 0.0, 0.0, 0.0

    x = (x_int16.astype(np.float64) / 32768.0).copy()
    x -= np.mean(x)

    _f0, t = pw.dio(x, sr)
    f0 = pw.stonemask(x, _f0, t, sr)

    voiced = f0 > 0
    voiced_ratio = float(np.mean(voiced)) if f0.size else 0.0
    if voiced_ratio < 0.05:
        return 0.0, 0.0, voiced_ratio

    f0_voiced = f0[voiced]
    f0_mean = float(np.mean(f0_voiced))

    cutoff = t[-1] - 0.5
    idx = (t >= cutoff) & voiced
    if np.sum(idx) >= 3:
        tt = t[idx]
        yy = f0[idx]
        f0_slope = float(np.polyfit(tt, yy, 1)[0])  # Hz/sec
    else:
        f0_slope = 0.0

    return f0_mean, f0_slope, voiced_ratio


def ema(prev, x, alpha=0.8):
    if prev is None:
        return float(x)
    return float(alpha * prev + (1.0 - alpha) * float(x))


def slope_from_last(values, hz):
    """Linear slope over the last len(values) points; returns per-second slope."""
    if len(values) < 3:
        return 0.0
    y = np.asarray(values, dtype=float)
    x = np.arange(len(y), dtype=float)
    m = np.polyfit(x, y, 1)[0]
    return float(m * float(hz))


def compute_dsp_features(y: np.ndarray, sr: int = 16000) -> dict:
    """
    (2) Multi-band ratios + (classic) spectral features + MFCC summary.
    Also returns speech-band RMS dB for (3) speech-band slope.
    """
    if y is None or y.size < WIN:
        return {
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

    # Time-domain
    rms = float(np.sqrt(np.mean(y * y) + 1e-12))
    rms_db = float(20.0 * np.log10(rms + 1e-9))
    zcr = float(librosa.feature.zero_crossing_rate(y, frame_length=WIN, hop_length=HOP, center=False).mean())

    # STFT magnitude
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP, win_length=WIN, center=False)) + 1e-9

    centroid = float(librosa.feature.spectral_centroid(S=S, sr=sr).mean())
    rolloff = float(librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=0.85).mean())
    flatness = float(librosa.feature.spectral_flatness(S=S).mean())

    dS = np.diff(S, axis=1)
    flux = float(np.mean(np.sqrt(np.sum(np.maximum(dS, 0.0) ** 2, axis=0)))) if dS.size else 0.0

    # Multi-band energy ratios
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    total = float(np.sum(S))

    low = (freqs >= 0) & (freqs <= 200)
    speech = (freqs >= 300) & (freqs <= 3400)
    high = (freqs >= 4000) & (freqs <= min(8000, sr / 2))

    low_ratio = float(np.sum(S[low, :]) / (total + 1e-9))
    speech_ratio = float(np.sum(S[speech, :]) / (total + 1e-9))
    high_ratio = float(np.sum(S[high, :]) / (total + 1e-9))

    # (3) speech-band RMS dB (speech energy proxy; more robust than full-band in VR)
    speech_power = float(np.mean(S[speech, :] ** 2)) if np.any(speech) else 0.0
    speech_rms = float(np.sqrt(speech_power + 1e-12))
    speech_rms_db = float(20.0 * np.log10(speech_rms + 1e-9))

    # MFCC summary
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, n_fft=N_FFT, hop_length=HOP, win_length=WIN, center=False)
    d1 = librosa.feature.delta(mfcc)

    return {
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
        "mfcc0": float(mfcc[0].mean()),
        "mfcc1": float(mfcc[1].mean()),
        "mfcc2": float(mfcc[2].mean()),
        "mfccDelta0": float(d1[0].mean()),
    }


def speech_confidence(snr_like, speech_ratio, low_ratio, flatness):
    """
    (2) Gate: combine cues into a single speech-likeness score.
    Positive => more speech-like. Tune threshold in SPEECH_CONF_THR.
    """
    return (
        W_SNR * float(snr_like)
        + W_SPEECH_BAND * float(speech_ratio)
        - W_LOW_RUMBLE * float(low_ratio)
        - W_FLATNESS * float(flatness)
    )


def boundary_confidence(pause_ms, energy_slope, f0_slope, flux_sm, voiced_ratio,
                        micro_min=250, micro_max=700,
                        flux_thr=3.0, energy_fall_thr=-0.8, f0_fall_thr=-15.0):
    """Interpretable fusion score in [0,1]."""
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


async def broadcast(out: dict):
    if not SUBSCRIBERS:
        return
    payload = json.dumps(out)
    dead = []
    for sub in list(SUBSCRIBERS):
        try:
            await sub.send(payload)
        except Exception:
            dead.append(sub)
    for sub in dead:
        SUBSCRIBERS.discard(sub)


async def handler(ws):
    st = State()

    buf = bytearray()
    last_out = time.time()

    ring = np.zeros(WIN_SAMPLES, dtype=np.int16)
    ring_write = 0
    ring_filled = 0

    await ws.send(json.dumps({"type": "hello", "sr": SR, "frame_ms": FRAME_MS}))

    try:
        async for msg in ws:
            # Monitor handshake
            if isinstance(msg, str):
                if msg.strip().lower() == "monitor":
                    SUBSCRIBERS.add(ws)
                    await ws.send(json.dumps({"type": "monitor_ok"}))
                continue

            # Unity binary PCM
            buf.extend(msg)

            while len(buf) >= FRAME_BYTES:
                frame = bytes(buf[:FRAME_BYTES])
                del buf[:FRAME_BYTES]

                now = time.time()
                x_frame = np.frombuffer(frame, dtype=np.int16)
                rms_frame = rms_from_int16(x_frame)

                # ring buffer update
                n = x_frame.size
                end = ring_write + n
                if end <= ring.size:
                    ring[ring_write:end] = x_frame
                else:
                    first = ring.size - ring_write
                    ring[ring_write:] = x_frame[:first]
                    ring[:end - ring.size] = x_frame[first:]
                ring_write = (ring_write + n) % ring.size
                ring_filled = min(ring.size, ring_filled + n)

                # noise estimate
                if not st.vad_on:
                    st.noise_rms = NOISE_EMA_ALPHA * st.noise_rms + (1.0 - NOISE_EMA_ALPHA) * rms_frame

                snr_like = rms_frame / (st.noise_rms + 1e-6)

                # VAD hysteresis + hangover
                if st.vad_on:
                    if snr_like >= SNR_OFF:
                        st.last_voice_ts = now
                    else:
                        if st.last_voice_ts and (now - st.last_voice_ts) > HANGOVER_SEC:
                            st.vad_on = False
                            st.speech_start_ts = None
                else:
                    if snr_like >= SNR_ON:
                        st.vad_on = True
                        st.speech_start_ts = now
                        st.last_voice_ts = now

                # output at FEATURE_HZ
                if (now - last_out) >= OUT_INTERVAL:
                    last_out = now

                    pause_ms = 0.0
                    speech_ms = 0.0
                    if st.vad_on:
                        speech_ms = (now - (st.speech_start_ts or now)) * 1000.0
                    else:
                        if st.last_voice_ts:
                            pause_ms = (now - st.last_voice_ts) * 1000.0

                    # window in time order
                    if ring_filled < ring.size:
                        x_win = ring[:ring_filled].copy()
                    else:
                        x_win = np.concatenate([ring[ring_write:], ring[:ring_write]])

                    # pitch features
                    f0Mean, f0Slope, voicedRatio = pitch_features_from_buffer(x_win, SR)

                    # DSP features
                    y = x_win.astype(np.float32) / 32768.0
                    dsp = compute_dsp_features(y, SR)

                    # (1) Smooth the noisy signals
                    st.snr_sm = ema(st.snr_sm, snr_like, SMOOTH_ALPHA)
                    st.flat_sm = ema(st.flat_sm, dsp["specFlatness"], SMOOTH_ALPHA)
                    st.flux_sm = ema(st.flux_sm, dsp["specFlux"], SMOOTH_ALPHA)
                    st.speech_ratio_sm = ema(st.speech_ratio_sm, dsp["speechEnergyRatio"], SMOOTH_ALPHA)
                    st.low_ratio_sm = ema(st.low_ratio_sm, dsp["lowEnergyRatio"], SMOOTH_ALPHA)

                    # (3) speech-band energy slope
                    st.speech_rmsdb_hist.append(dsp["speechRmsDb"])
                    speech_energy_slope = slope_from_last(list(st.speech_rmsdb_hist)[-SLOPE_N:], FEATURE_HZ)

                    # (2) speech confidence gate
                    sp_conf = speech_confidence(st.snr_sm, st.speech_ratio_sm, st.low_ratio_sm, st.flat_sm)
                    speech_like = 1 if sp_conf >= SPEECH_CONF_THR else 0

                    # boundary score uses smoothed flux + speech-band slope
                    bconf = boundary_confidence(
                        pause_ms=pause_ms,
                        energy_slope=speech_energy_slope,
                        f0_slope=f0Slope,
                        flux_sm=st.flux_sm,
                        voiced_ratio=voicedRatio,
                    )

                    out = {
                        "type": "prosody_features",
                        "vad": 1 if st.vad_on else 0,
                        "rms": float(rms_frame),
                        "noiseRms": float(st.noise_rms),
                        "snrLike": float(snr_like),
                        "pauseMs": float(pause_ms),
                        "speechMs": float(speech_ms),
                        "f0Mean": float(f0Mean),
                        "f0Slope": float(f0Slope),
                        "voicedRatio": float(voicedRatio),

                        # Existing DSP extras
                        **dsp,

                        # (1) smoothed signals (use these for policy)
                        "snrLikeSm": float(st.snr_sm),
                        "specFlatnessSm": float(st.flat_sm),
                        "specFluxSm": float(st.flux_sm),
                        "speechEnergyRatioSm": float(st.speech_ratio_sm),
                        "lowEnergyRatioSm": float(st.low_ratio_sm),

                        # (3) speech-band slope
                        "speechEnergySlope": float(speech_energy_slope),

                        # (2) speech confidence
                        "speechConfidence": float(sp_conf),
                        "speechLike": int(speech_like),

                        # (3/4) boundary score (built on stable cues)
                        "boundaryConfidence": float(bconf),
                    }

                    # send to Unity (same socket)
                    await ws.send(json.dumps(out))
                    # broadcast to monitors/browser
                    await broadcast(out)

    finally:
        SUBSCRIBERS.discard(ws)


async def main():
    async with websockets.serve(handler, HOST, PORT, max_size=2**23):
        print(f"Prosody server on ws://{HOST}:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())