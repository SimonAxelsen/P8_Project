import asyncio, json, os, time
import numpy as np
import websockets
import pyworld as pw
import librosa

HOST = os.getenv("PROSODY_HOST", "0.0.0.0")
PORT = int(os.getenv("PROSODY_PORT", "8765"))

SR = 16000
FRAME_MS = 20
FRAME_SAMPLES = SR * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono

FEATURE_HZ = 10
OUT_INTERVAL = 1.0 / FEATURE_HZ

WIN_SEC = 1.0
WIN_SAMPLES = int(SR * WIN_SEC)

# Energy-based VAD parameters
NOISE_EMA_ALPHA = 0.95
SNR_ON = 2.5
SNR_OFF = 1.8
HANGOVER_SEC = 0.20

# Monitor subscribers
SUBSCRIBERS = set()

class State:
    def __init__(self):
        self.vad_on = False
        self.speech_start_ts = None
        self.last_voice_ts = None
        self.noise_rms = 0.01

def rms_from_int16(x: np.ndarray) -> float:
    xf = x.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(xf * xf) + 1e-12))

def pitch_features_from_buffer(x_int16: np.ndarray, sr: int):
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
        f0_slope = float(np.polyfit(tt, yy, 1)[0])
    else:
        f0_slope = 0.0

    return f0_mean, f0_slope, voiced_ratio

def compute_librosa_features(y: np.ndarray, sr: int):
    # 25ms window, 10ms hop at 16k
    n_fft = 512
    hop = 160
    win = 400

    # Guard: if we don’t have enough samples, return zeros
    if y is None or y.size < win:
        return {
            "rmsDb": 0.0,
            "zcr": 0.0,
            "specCentroid": 0.0,
            "specRolloff": 0.0,
            "specFlatness": 0.0,
            "specFlux": 0.0,
            "bandEnergyRatio": 0.0,
            "mfcc0": 0.0,
            "mfcc1": 0.0,
            "mfcc2": 0.0,
            "mfccDelta0": 0.0,
        }

    rms = float(np.sqrt(np.mean(y * y) + 1e-12))
    rms_db = float(20.0 * np.log10(rms + 1e-9))
    zcr = float(librosa.feature.zero_crossing_rate(y, frame_length=win, hop_length=hop, center=False).mean())

    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop, win_length=win, center=False)) + 1e-9

    centroid = float(librosa.feature.spectral_centroid(S=S, sr=sr).mean())
    rolloff = float(librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=0.85).mean())
    flatness = float(librosa.feature.spectral_flatness(S=S).mean())

    dS = np.diff(S, axis=1)
    flux = float(np.mean(np.sqrt(np.sum(np.maximum(dS, 0.0) ** 2, axis=0)))) if dS.size else 0.0

    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    band = (freqs >= 300) & (freqs <= 3400)
    band_energy = float(np.sum(S[band, :]))
    total_energy = float(np.sum(S))
    ber = float(band_energy / (total_energy + 1e-9))

    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, n_fft=n_fft, hop_length=hop, win_length=win, center=False)
    d1 = librosa.feature.delta(mfcc)

    return {
        "rmsDb": rms_db,
        "zcr": zcr,
        "specCentroid": centroid,
        "specRolloff": rolloff,
        "specFlatness": flatness,
        "specFlux": flux,
        "bandEnergyRatio": ber,
        "mfcc0": float(mfcc[0].mean()),
        "mfcc1": float(mfcc[1].mean()),
        "mfcc2": float(mfcc[2].mean()),
        "mfccDelta0": float(d1[0].mean()),
    }

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

                # noise estimate when not speaking
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

                if (now - last_out) >= OUT_INTERVAL:
                    last_out = now

                    pause_ms = 0.0
                    speech_ms = 0.0
                    if st.vad_on:
                        speech_ms = (now - (st.speech_start_ts or now)) * 1000.0
                    else:
                        if st.last_voice_ts:
                            pause_ms = (now - st.last_voice_ts) * 1000.0

                    # time-ordered window
                    if ring_filled < ring.size:
                        x_win = ring[:ring_filled].copy()
                    else:
                        x_win = np.concatenate([ring[ring_write:], ring[:ring_write]])

                    f0Mean, f0Slope, voicedRatio = pitch_features_from_buffer(x_win, SR)

                    y = x_win.astype(np.float32) / 32768.0
                    lib = compute_librosa_features(y, SR)

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
                        **lib,
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