import asyncio
import json
import os
import time

import numpy as np
import websockets

from prosody_core import (
    ProsodyConfig,
    init_prosody_state,
    update_prosody_frame,
)

HOST = os.getenv("PROSODY_HOST", "0.0.0.0")
PORT = int(os.getenv("PROSODY_PORT", "8765"))

config = ProsodyConfig(
    sr=16000,
    frame_ms=int(os.getenv("PROSODY_FRAME_MS", "20")),
    feature_hz=int(os.getenv("PROSODY_FEATURE_HZ", "10")),
    win_sec=float(os.getenv("PROSODY_WIN_SEC", "1.0")),
    n_fft=int(os.getenv("PROSODY_NFFT", "512")),
    hop=int(os.getenv("PROSODY_HOP", "160")),
    win=int(os.getenv("PROSODY_WIN", "400")),
    slope_sec=float(os.getenv("PROSODY_SLOPE_SEC", "0.5")),
    noise_ema_alpha=float(os.getenv("PROSODY_NOISE_ALPHA", "0.95")),
    snr_on=float(os.getenv("PROSODY_SNR_ON", "2.5")),
    snr_off=float(os.getenv("PROSODY_SNR_OFF", "1.8")),
    hangover_sec=float(os.getenv("PROSODY_HANGOVER_SEC", "0.20")),
    smooth_alpha=float(os.getenv("PROSODY_SMOOTH_ALPHA", "0.80")),
    w_snr=float(os.getenv("PROSODY_W_SNR", "0.6")),
    w_speech_band=float(os.getenv("PROSODY_W_SPEECH_BAND", "1.0")),
    w_low_rumble=float(os.getenv("PROSODY_W_LOW_RUMBLE", "1.0")),
    w_flatness=float(os.getenv("PROSODY_W_FLATNESS", "1.0")),
    speech_conf_thr=float(os.getenv("PROSODY_SPEECHCONF_THR", "0.0")),
    mel_n_mels=int(os.getenv("PROSODY_MEL_N_MELS", "64")),
    mel_fmin=float(os.getenv("PROSODY_MEL_FMIN", "50.0")),
    mel_fmax=float(os.getenv("PROSODY_MEL_FMAX", "0")) or None,
    emit_mel_frame=os.getenv("PROSODY_EMIT_MEL_FRAME", "1") == "1",
    mel_max_frames=int(os.getenv("PROSODY_MEL_MAX_FRAMES", "700")),
)

SUBSCRIBERS = set()


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
    st = init_prosody_state()

    buf = bytearray()
    last_out = time.time()

    ring = np.zeros(config.win_samples, dtype=np.int16)
    ring_write = 0
    ring_filled = 0

    await ws.send(
        json.dumps(
            {
                "type": "hello",
                "sr": config.sr,
                "frame_ms": config.frame_ms,
            }
        )
    )

    try:
        async for msg in ws:
            # Monitor handshake
            if isinstance(msg, str):
                if msg.strip().lower() == "monitor":
                    SUBSCRIBERS.add(ws)
                    await ws.send(json.dumps({"type": "monitor_ok"}))
                continue

            # Unity binary PCM frames
            buf.extend(msg)

            while len(buf) >= config.frame_bytes:
                frame = bytes(buf[: config.frame_bytes])
                del buf[: config.frame_bytes]

                x_frame = np.frombuffer(frame, dtype=np.int16)
                now = time.time()

                ring_write, ring_filled, out = update_prosody_frame(
                    x_frame,
                    ring,
                    ring_write,
                    ring_filled,
                    st,
                    now,
                    config=config,
                )

                if (now - last_out) >= config.out_interval and out is not None:
                    last_out = now

                    # send to Unity client
                    await ws.send(json.dumps(out))

                    # broadcast to browser / monitor clients
                    await broadcast(out)

    finally:
        SUBSCRIBERS.discard(ws)


async def main():
    async with websockets.serve(handler, HOST, PORT, max_size=2**23):
        print(f"Prosody server on ws://{HOST}:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
