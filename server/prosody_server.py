import asyncio, json, time
import numpy as np
import websockets
import pyworld as pw

# ---------------------------
# Audio format expected from Unity
# ---------------------------
SR = 16000
FRAME_MS = 20
FRAME_SAMPLES = SR * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono (2 bytes per sample)

# Feature output rate
FEATURE_HZ = 10
OUT_INTERVAL = 1.0 / FEATURE_HZ

# Pitch window (1 second)
PITCH_WIN_SEC = 1.0
PITCH_WIN_SAMPLES = int(SR * PITCH_WIN_SEC)

# ---------------------------
# Energy-based VAD parameters (tune if needed)
# ---------------------------
NOISE_EMA_ALPHA = 0.95     # closer to 1.0 = slower noise adaptation
SNR_ON = 2.5               # vad turns ON when rms/noise_rms >= this
SNR_OFF = 1.8              # vad turns OFF when rms/noise_rms < this (hysteresis)
HANGOVER_SEC = 0.20        # keep vad_on true briefly after it dips

# ---------------------------
# Monitor subscribers (receive broadcasted prosody_features)
# ---------------------------
SUBSCRIBERS = set()

class State:
    def __init__(self):
        self.vad_on = False
        self.speech_start_ts = None
        self.last_voice_ts = None
        self.noise_rms = 0.01  # initial noise floor (non-zero)

def rms_from_int16(x: np.ndarray) -> float:
    xf = x.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(xf * xf) + 1e-12))

def pitch_features_from_buffer(x_int16: np.ndarray, sr: int):
    """
    Returns: f0Mean (Hz), f0Slope (Hz/sec), voicedRatio (0..1)
    Uses pyworld dio + stonemask.
    """
    if x_int16.size < int(sr * 0.2):
        return 0.0, 0.0, 0.0

    x = (x_int16.astype(np.float64) / 32768.0).copy()
    x -= np.mean(x)  # DC removal

    _f0, t = pw.dio(x, sr)
    f0 = pw.stonemask(x, _f0, t, sr)

    voiced = f0 > 0
    voiced_ratio = float(np.mean(voiced)) if f0.size else 0.0
    if voiced_ratio < 0.05:
        return 0.0, 0.0, voiced_ratio

    f0_voiced = f0[voiced]
    f0_mean = float(np.mean(f0_voiced))

    # slope over last 0.5s (Hz/sec)
    cutoff = t[-1] - 0.5
    idx = (t >= cutoff) & voiced
    if np.sum(idx) >= 3:
        tt = t[idx]
        yy = f0[idx]
        f0_slope = float(np.polyfit(tt, yy, 1)[0])
    else:
        f0_slope = 0.0

    return f0_mean, f0_slope, voiced_ratio

async def broadcast(out: dict):
    """Send JSON to all monitor subscribers; drop dead connections."""
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
    global SUBSCRIBERS
    st = State()
    buf = bytearray()
    last_out = time.time()

    # ring buffer for pitch window
    ring = np.zeros(PITCH_WIN_SAMPLES, dtype=np.int16)
    ring_write = 0
    ring_filled = 0

    await ws.send(json.dumps({"type": "hello", "sr": SR, "frame_ms": FRAME_MS}))

    try:
        async for msg in ws:
            # --- monitor handshake ---
            if isinstance(msg, str):
                if msg.strip().lower() == "monitor":
                    SUBSCRIBERS.add(ws)
                    await ws.send(json.dumps({"type": "monitor_ok"}))
                # ignore other text messages
                continue

            # --- Unity binary PCM ---
            buf.extend(msg)

            while len(buf) >= FRAME_BYTES:
                frame = bytes(buf[:FRAME_BYTES])
                del buf[:FRAME_BYTES]

                now = time.time()
                x_frame = np.frombuffer(frame, dtype=np.int16)
                rms = rms_from_int16(x_frame)

                # update pitch ring buffer
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

                # update noise estimate when not speaking
                if not st.vad_on:
                    st.noise_rms = NOISE_EMA_ALPHA * st.noise_rms + (1.0 - NOISE_EMA_ALPHA) * rms

                snr_like = rms / (st.noise_rms + 1e-6)

                # hysteresis + hangover VAD
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

                    # pitch window in time order
                    if ring_filled < ring.size:
                        x_win = ring[:ring_filled].copy()
                    else:
                        x_win = np.concatenate([ring[ring_write:], ring[:ring_write]])

                    f0Mean, f0Slope, voicedRatio = pitch_features_from_buffer(x_win, SR)

                    out = {
                        "type": "prosody_features",
                        "vad": 1 if st.vad_on else 0,
                        "rms": float(rms),
                        "pauseMs": float(pause_ms),
                        "speechMs": float(speech_ms),
                        "f0Mean": float(f0Mean),
                        "f0Slope": float(f0Slope),
                        "voicedRatio": float(voicedRatio),
                        # helpful for debugging energy-vad (optional)
                        "noiseRms": float(st.noise_rms),
                        "snrLike": float(snr_like),
                    }

                    # send to Unity (same socket)
                    await ws.send(json.dumps(out))
                    # broadcast to monitors
                    await broadcast(out)

    finally:
        SUBSCRIBERS.discard(ws)

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765, max_size=2**23):
        print("Prosody server on ws://0.0.0.0:8765")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())