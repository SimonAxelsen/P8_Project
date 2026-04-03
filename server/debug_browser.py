import asyncio
import json
import websockets
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
import uvicorn

PROSODY_WS = "ws://localhost:8765"
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
    body { font-family: sans-serif; margin: 18px; }
    .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
    .card { padding: 12px; border: 1px solid #ddd; border-radius: 8px; }
    .controls { min-width: 340px; max-width: 420px; }
    .controls h3 { margin: 0 0 8px 0; }
    .controls .btnrow { display:flex; gap:8px; flex-wrap:wrap; margin: 8px 0; }
    button { padding: 6px 10px; cursor:pointer; }
    label { display:block; margin: 2px 0; }
    .small { font-size: 12px; color:#555; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .kv { display:flex; justify-content:space-between; gap:10px; }
    .k { color:#666; }
    .v { font-weight: 600; }
    canvas { max-width: 1200px; }
  </style>
</head>
<body>
  <h2>Prosody Debug (live)</h2>
  <div class="row">
    <div class="card controls">
      <h3>Signals</h3>
      <div class="btnrow">
        <button id="btnAll">All on</button>
        <button id="btnNone">All off</button>
        <button id="btnSolo">Solo selected</button>
      </div>
      <div class="btnrow">
        <button id="presetBasic">Preset: Basic</button>
        <button id="presetVAD">Preset: VAD</button>
        <button id="presetSpectral">Preset: Spectral</button>
        <button id="presetPitch">Preset: Pitch</button>
      </div>

      <div class="small">Tip: click a dataset name in the chart legend to toggle it too.</div>
      <hr/>
      <div id="checks"></div>
    </div>

    <div class="card" style="min-width: 360px;">
      <h3>Latest values</h3>
      <div class="grid" id="kvGrid"></div>
      <div class="small" style="margin-top:8px;">
        Source: <code>ws://localhost:8765</code> (monitor mode) → <code>http://localhost:8000</code>
      </div>
    </div>
  </div>

  <br/>
  <canvas id="chart" width="1200" height="420"></canvas>

<script>
const ws = new WebSocket("ws://" + location.host + "/ws");
const MAX = 300;

// key -> label + scale for plotting
const SIGNALS = [
  { key: "rmsDb", label: "rmsDb", scale: 1 },
  { key: "snrLike", label: "snrLike", scale: 1 },
  { key: "pauseMs", label: "pauseMs", scale: 1 },
  { key: "vad", label: "vad", scale: 1 },

  { key: "rms", label: "rms*100", scale: 100 },
  { key: "noiseRms", label: "noiseRms*100", scale: 100 },
  { key: "zcr", label: "zcr*100", scale: 100 },

  { key: "f0Mean", label: "f0Mean", scale: 1 },
  { key: "f0Slope", label: "f0Slope", scale: 1 },
  { key: "voicedRatio", label: "voicedRatio*300", scale: 300 },

  { key: "specCentroid", label: "specCentroid/100", scale: 0.01 },
  { key: "specRolloff", label: "specRolloff/100", scale: 0.01 },
  { key: "specFlatness", label: "specFlatness*50", scale: 50 },
  { key: "specFlux", label: "specFlux", scale: 1 },
  { key: "bandEnergyRatio", label: "bandEnergyRatio*100", scale: 100 },

  { key: "mfcc0", label: "mfcc0", scale: 1 },
  { key: "mfcc1", label: "mfcc1", scale: 1 },
  { key: "mfcc2", label: "mfcc2", scale: 1 },
  { key: "mfccDelta0", label: "mfccDelta0", scale: 1 },
];

const labels = [];
const series = Object.fromEntries(SIGNALS.map(s => [s.key, []]));
const enabled = Object.fromEntries(SIGNALS.map(s => [s.key, true]));

const checksDiv = document.getElementById("checks");
function rebuildChecks() {
  checksDiv.innerHTML = "";
  SIGNALS.forEach(s => {
    const id = "chk_" + s.key;
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" id="${id}" ${enabled[s.key] ? "checked" : ""}/> ${s.label}`;
    checksDiv.appendChild(lab);
    document.getElementById(id).addEventListener("change", (e) => {
      enabled[s.key] = e.target.checked;
      setDatasetVisible(s.key, enabled[s.key]);
    });
  });
}

function setDatasetVisible(key, isVisible) {
  const idx = chart.data.datasets.findIndex(d => d._key === key);
  if (idx >= 0) {
    chart.setDatasetVisibility(idx, isVisible);
    chart.update("none");
  }
}

function setAll(on) {
  SIGNALS.forEach(s => {
    enabled[s.key] = on;
    setDatasetVisible(s.key, on);
    const cb = document.getElementById("chk_" + s.key);
    if (cb) cb.checked = on;
  });
}

function soloSelected() {
  const selected = SIGNALS.filter(s => document.getElementById("chk_" + s.key)?.checked);
  if (selected.length === 0) return;
  setAll(false);
  selected.forEach(s => {
    enabled[s.key] = true;
    setDatasetVisible(s.key, true);
    const cb = document.getElementById("chk_" + s.key);
    if (cb) cb.checked = true;
  });
}

function applyPreset(keysOn) {
  setAll(false);
  keysOn.forEach(k => {
    enabled[k] = true;
    setDatasetVisible(k, true);
    const cb = document.getElementById("chk_" + k);
    if (cb) cb.checked = true;
  });
}

document.getElementById("btnAll").onclick = () => setAll(true);
document.getElementById("btnNone").onclick = () => setAll(false);
document.getElementById("btnSolo").onclick = () => soloSelected();

document.getElementById("presetBasic").onclick = () =>
  applyPreset(["rmsDb","snrLike","pauseMs","vad","f0Mean","voicedRatio"]);

document.getElementById("presetVAD").onclick = () =>
  applyPreset(["rms","noiseRms","snrLike","vad","pauseMs","speechMs"]);

document.getElementById("presetSpectral").onclick = () =>
  applyPreset(["specFlatness","specFlux","bandEnergyRatio","specCentroid","specRolloff"]);

document.getElementById("presetPitch").onclick = () =>
  applyPreset(["f0Mean","f0Slope","voicedRatio","rmsDb","pauseMs"]);

const kvGrid = document.getElementById("kvGrid");
function setKV(key, val) {
  let el = document.getElementById("kv_" + key);
  if (!el) {
    const row = document.createElement("div");
    row.className = "kv";
    row.id = "kv_" + key;
    row.innerHTML = `<span class="k">${key}</span><span class="v" id="kvv_${key}">-</span>`;
    kvGrid.appendChild(row);
    el = row;
  }
  const vv = document.getElementById("kvv_" + key);
  if (vv) vv.textContent = val;
}

const datasets = SIGNALS.map(s => ({
  label: s.label,
  data: series[s.key],
  _key: s.key,
}));

const chart = new Chart(document.getElementById("chart"), {
  type: "line",
  data: { labels, datasets },
  options: {
    animation: false,
    responsive: true,
    interaction: { mode: "nearest", intersect: false },
    scales: { x: { display: false } },
    plugins: { legend: { display: true } }
  }
});

rebuildChecks();

function push(arr, v) { arr.push(v); if (arr.length > MAX) arr.shift(); }

ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (!d || d.type !== "prosody_features") return;

  const keysToShow = ["vad","pauseMs","speechMs","rms","rmsDb","noiseRms","snrLike","zcr",
                      "f0Mean","f0Slope","voicedRatio",
                      "specCentroid","specRolloff","specFlatness","specFlux","bandEnergyRatio",
                      "mfcc0","mfcc1","mfcc2","mfccDelta0"];
  keysToShow.forEach(k => {
    if (d[k] !== undefined) {
      const val = (typeof d[k] === "number")
        ? d[k].toFixed((k==="vad")?0 : (k.includes("Ms")?0 : (k.startsWith("mfcc")?2 : (k==="rms"?4:2))))
        : String(d[k]);
      setKV(k, val);
    }
  });

  labels.push(Date.now()); if (labels.length > MAX) labels.shift();

  SIGNALS.forEach(s => {
    const raw = d[s.key];
    if (raw === undefined || raw === null) return;
    push(series[s.key], raw * s.scale);
  });

  SIGNALS.forEach(s => {
    if (series[s.key].length < labels.length) {
      const last = series[s.key].length ? series[s.key][series[s.key].length - 1] : 0;
      push(series[s.key], last);
    }
  });

  chart.update("none");
};

applyPreset(["rmsDb","snrLike","pauseMs","vad","f0Mean","voicedRatio"]);
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
        if latest is not None:
            await ws.send_text(json.dumps(latest))
        while True:
            await asyncio.sleep(10)
    finally:
        clients.discard(ws)

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
    uvicorn.run(app, host="127.0.0.1", port=8000)