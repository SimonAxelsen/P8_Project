import asyncio
import json
import collections
import websockets
import matplotlib.pyplot as plt

WS_URL = "ws://localhost:8765"
HISTORY = 300  # ~30 seconds at 10 Hz

rms = collections.deque(maxlen=HISTORY)
noise = collections.deque(maxlen=HISTORY)
snr = collections.deque(maxlen=HISTORY)
pause = collections.deque(maxlen=HISTORY)
vad = collections.deque(maxlen=HISTORY)
f0 = collections.deque(maxlen=HISTORY)
voiced = collections.deque(maxlen=HISTORY)

async def run():
    async with websockets.connect(WS_URL, max_size=2**23) as ws:
        # identify as monitor so server broadcasts features to us
        await ws.send("monitor")
        print("Connected to", WS_URL, "as monitor")

        plt.ion()
        fig, axs = plt.subplots(5, 1, figsize=(10, 10), sharex=True)

        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                continue
            data = json.loads(msg)
            if data.get("type") != "prosody_features":
                continue

            rms.append(float(data.get("rms", 0.0)))
            noise.append(float(data.get("noiseRms", 0.0)))
            snr.append(float(data.get("snrLike", 0.0)))
            pause.append(float(data.get("pauseMs", 0.0)))
            vad.append(int(data.get("vad", 0)))
            f0.append(float(data.get("f0Mean", 0.0)))
            voiced.append(float(data.get("voicedRatio", 0.0)))

            axs[0].cla(); axs[0].set_title("RMS energy + Noise floor")
            axs[0].plot(list(rms), label="rms")
            axs[0].plot(list(noise), label="noiseRms")
            axs[0].legend(loc="upper right")

            axs[1].cla(); axs[1].set_title("SNR-like (rms/noiseRms)")
            axs[1].plot(list(snr))

            axs[2].cla(); axs[2].set_title("VAD (0/1)")
            axs[2].plot(list(vad))

            axs[3].cla(); axs[3].set_title("pauseMs")
            axs[3].plot(list(pause))

            axs[4].cla(); axs[4].set_title("F0 mean + voicedRatio (scaled)")
            axs[4].plot(list(f0), label="f0Mean")
            axs[4].plot([v * 300 for v in voiced], label="voicedRatio*300")
            axs[4].legend(loc="upper right")

            plt.pause(0.001)

if __name__ == "__main__":
    asyncio.run(run())