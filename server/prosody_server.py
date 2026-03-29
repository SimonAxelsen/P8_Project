import asyncio, json, time
import numpy as np
import websockets
import webrtcvad
import pyworld as pw

SR = 16000
FRAME_MS = 20
FRAME_SAMPLES = SR * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono
FEATURE_HZ = 10
OUT_INTERVAL = 1.0 / FEATURE_HZ

PITCH_WIN_SEC = 1.0                 # pitch computed over last 1.0s
PITCH_WIN_SAMPLES = int(SR * PITCH_WIN_SEC)

vad = webrtcvad.Vad(2)  # 0-3 aggressiveness

class State:
    def __init__(self):
        self.last_voice_ts = None
        self.speech_start_ts = None
        self.vad_on = False

def rms_from_int16(x: np.ndarray) -> float:
    xf = x.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(xf * xf)))

def pitch_features_from_buffer(x_int16: np.ndarray, sr: int):
    """
    Returns f0Mean, f0Slope, voicedRatio from a float64 waveform using pyworld.
    """
    if x_int16.size < int(sr * 0.2):  # need some minimum audio
        return None, None, None

    x = (x_int16.astype(np.float64) / 32768.0).copy()
    x = x - np.mean(x)  # DC removal helps

    # pyworld pitch extraction
    _f0, t = pw.dio(x, sr)                # initial F0
    f0 = pw.stonemask(x, _f0, t, sr)      # refine

    voiced = f0 > 0
    voiced_ratio = float(np.mean(voiced)) if f0.size else 0.0

    if voiced_ratio < 0.05:
        return None, None, voiced_ratio

    f0_voiced = f0[voiced]
    f0_mean = float(np.mean(f0_voiced))

    # Slope over the last 0.5s of frames (linear fit on voiced frames)
    # t is in seconds, aligned with f0
    cutoff = t[-1] - 0.5
    idx = (t >= cutoff) & voiced
    if np.sum(idx) >= 3:
        tt = t[idx]
        yy = f0[idx]
        # linear regression slope (Hz/sec)
        slope = float(np.polyfit(tt, yy, 1)[0])
    else:
        slope = None

    return f0_mean, slope, voiced_ratio

async def handler(ws):
    st = State()
    buf = bytearray()
    last_out = time.time()

    # ring buffer for last 1s of audio
    ring = np.zeros(PITCH_WIN_SAMPLES, dtype=np.int16)
    ring_write = 0
    ring_filled = 0

    await ws.send(json.dumps({"type": "hello", "sr": SR, "frame_ms": FRAME_MS}))

    async for msg in ws:
        if isinstance(msg, str):
            # allow JSON control/config messages if needed
            continue

        buf.extend(msg)

        while len(buf) >= FRAME_BYTES:
            frame = bytes(buf[:FRAME_BYTES])
            del buf[:FRAME_BYTES]

            now = time.time()

            # VAD
            is_speech = vad.is_speech(frame, SR)
            if is_speech:
                st.last_voice_ts = now
                if not st.vad_on:
                    st.vad_on = True
                    st.speech_start_ts = now
            else:
                if st.last_voice_ts and (now - st.last_voice_ts) > 0.2:
                    st.vad_on = False
                    st.speech_start_ts = None

            # Update audio ring buffer
            x_frame = np.frombuffer(frame, dtype=np.int16)
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

            # Output features at 10 Hz
            if (now - last_out) >= OUT_INTERVAL:
                last_out = now

                rms = rms_from_int16(x_frame)

                pause_ms = 0.0
                speech_ms = 0.0
                if st.vad_on:
                    speech_ms = (now - (st.speech_start_ts or now)) * 1000.0
                else:
                    if st.last_voice_ts:
                        pause_ms = (now - st.last_voice_ts) * 1000.0

                # Prepare ring buffer in time order for pitch extraction
                if ring_filled < ring.size:
                    x_win = ring[:ring_filled].copy()
                else:
                    x_win = np.concatenate([ring[ring_write:], ring[:ring_write]])

                f0Mean, f0Slope, voicedRatio = pitch_features_from_buffer(x_win, SR)

                out = {
                    "type": "prosody_features",
                    "vad": 1 if st.vad_on else 0,
                    "rms": rms,
                    "pauseMs": pause_ms,
                    "speechMs": speech_ms,
                    "f0Mean": 0.0 if f0Mean is None else float(f0Mean),
                    "f0Slope": 0.0 if f0Slope is None else float(f0Slope),
                    "voicedRatio": 0.0 if voicedRatio is None else float(voicedRatio),
                }
                await ws.send(json.dumps(out))

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765, max_size=2**23):
        print("Prosody server on ws://0.0.0.0:8765")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())