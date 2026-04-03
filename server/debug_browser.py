import asyncio
import json
import os
import websockets
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
import uvicorn

PROSODY_WS = os.getenv("PROSODY_WS", "ws://localhost:8765")
DEBUG_BROWSER_HOST = os.getenv("DEBUG_BROWSER_HOST", "127.0.0.1")
DEBUG_BROWSER_PORT = int(os.getenv("DEBUG_BROWSER_PORT", "8000"))
latest = None
clients = set()

app = FastAPI()

HTML = r"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Prosody Debug</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    .row { display: flex; gap: 20px; flex-wrap: wrap; }
    .card { padding: 12px; border: 1px solid #ddd; border-radius: 8px; }
    canvas { max-width: 900px; }
    code { background: #f5f5f5; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Prosody Debug (live)</h2>
  <div class="row">
    <div class="card">
      <div><b>VAD:</b> <span id="vad">-</span></div>
      <div><b>pauseMs:</b> <span id="pause">-</span></div>
      <div><b>speechMs:</b> <span id="speech">-</span></div>
      <div><b>rms:</b> <span id="rms">-</span></div>
      <div><b>noiseRms:</b> <span id="noise">-</span></div>
      <div><b>snrLike:</b> <span id="snr">-</span></div>
      <div><b>f0Mean:</b> <span id="f0">-</span></div>
      <div><b>voicedRatio:</b> <span id="voiced">-</span></div>
      <div style="margin-top:8px; font-size: 13px; color:#555">
        Source: <code>ws://localhost:8765</code> (monitor mode)
      </div>
    </div>
  </div>

  <canvas id="chart" width="900" height="360"></canvas>

<script>
const ws = new WebSocket("ws://" + location.host + "/ws");
const MAX = 300;

const labels = [];
const series = {
  rms: [],
  noise: [],
  snr: [],
  pause: [],
  vad: [],
  f0: [],
  voiced: []
};

function push(arr, v) {
  arr.push(v);
  if (arr.length > MAX) arr.shift();
}

const ctx = document.getElementById("chart");
const chart = new Chart(ctx, {
  type: "line",
  data: {
    labels: labels,
    datasets: [
      { label: "rms", data: series.rms },
      { label: "noiseRms", data: series.noise },
      { label: "snrLike", data: series.snr },
      { label: "pauseMs", data: series.pause },
      { label: "vad", data: series.vad },
      { label: "f0Mean", data: series.f0 },
      { label: "voicedRatio*300", data: series.voiced }
    ]
  },
  options: {
    animation: false,
    responsive: true,
    scales: { x: { display: false } }
  }
});

function setText(id, v) { document.getElementById(id).textContent = v; }

ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (!d || d.type !== "prosody_features") return;

  // update numbers
  setText("vad", d.vad);
  setText("pause", d.pauseMs.toFixed(0));
  setText("speech", d.speechMs.toFixed(0));
  setText("rms", d.rms.toFixed(4));
  setText("noise", (d.noiseRms ?? 0).toFixed(4));
  setText("snr", (d.snrLike ?? 0).toFixed(2));
  setText("f0", (d.f0Mean ?? 0).toFixed(1));
  setText("voiced", (d.voicedRatio ?? 0).toFixed(2));

  // update chart
  const t = Date.now();
  labels.push(t);
  if (labels.length > MAX) labels.shift();

  push(series.rms, d.rms);
  push(series.noise, d.noiseRms ?? 0);
  push(series.snr, d.snrLike ?? 0);
  push(series.pause, d.pauseMs);
  push(series.vad, d.vad);
  push(series.f0, d.f0Mean ?? 0);
  push(series.voiced, (d.voicedRatio ?? 0) * 300);

  chart.update("none");
};
</script>
</body>
</html>
"""

@app.get("/")
def root():
    return HTMLResponse(HTML)

@app.websocket("/ws")
async def ws_clients(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        # send latest immediately if available
        if latest is not None:
            await ws.send_text(json.dumps(latest))
        while True:
            await asyncio.sleep(10)  # keep open; server pushes from background task
    finally:
        clients.discard(ws)

async def prosody_listener():
    global latest
    while True:
        try:
            async with websockets.connect(PROSODY_WS, max_size=2**23) as ws:
                await ws.send("monitor")  # subscribe mode
                while True:
                    msg = await ws.recv()
                    if isinstance(msg, bytes):
                        continue
                    d = json.loads(msg)
                    if d.get("type") != "prosody_features":
                        continue
                    latest = d
                    dead = []
                    for c in list(clients):
                        try:
                            await c.send_text(json.dumps(d))
                        except Exception:
                            dead.append(c)
                    for c in dead:
                        clients.discard(c)
        except Exception:
            # retry
            await asyncio.sleep(1)

@app.on_event("startup")
async def _startup():
    asyncio.create_task(prosody_listener())

if __name__ == "__main__":
    uvicorn.run(app, host=DEBUG_BROWSER_HOST, port=DEBUG_BROWSER_PORT)
