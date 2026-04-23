function updateLiveBuffers(d) {
  const nowMs = Date.now();
  const entry = Object.assign({ _ts: nowMs }, d);
  state.liveFrames.push(entry);

  if (Array.isArray(d.melFrame)) {
    if (!state.liveMelBins) {
      state.liveMelBins = d.melFrame.length;
    }
    if (!state.clipFrameHopSec) {
      state.clipFrameHopSec = 0.01;
    }
    const t = (state.liveFrames.length - 1) * state.clipFrameHopSec;
    state.liveMelTimes.push(t);
  }

  const cutoff = nowMs - state.liveBufferSec * 1000;
  while (state.liveFrames.length && state.liveFrames[0]._ts < cutoff) {
    state.liveFrames.shift();
  }
  while (state.liveMelTimes.length && state.liveFrames.length && state.liveMelTimes.length > state.liveFrames.length) {
    state.liveMelTimes.shift();
  }
  return entry;
}

function renderLiveGraphsWindow() {
  if (!state.liveFrames.length) return;
  const endIdx = state.liveFrames.length - 1;
  const endTime = endIdx * state.clipFrameHopSec;
  const startTime = Math.max(0, endTime - state.clipWindowSec);
  const startIdx = Math.max(0, Math.floor(startTime / state.clipFrameHopSec));

  const visible = state.liveFrames.slice(startIdx, endIdx + 1);
  const overviewLabels = state.liveFrames.map((_, i) => `${(i * state.clipFrameHopSec).toFixed(2)}s`);
  const detailLabels = visible.map((_, i) => `${(startTime + i * state.clipFrameHopSec).toFixed(2)}s`);

  Object.entries(state.graphs).forEach(([graphId, g]) => {
    refillChart(g.overview, state.liveFrames, overviewLabels);
    refillChart(g.detail, visible, detailLabels);

    const fractionStart = state.liveFrames.length ? (startIdx / state.liveFrames.length) : 0;
    const fractionWidth = state.liveFrames.length ? ((visible.length) / state.liveFrames.length) : 1;

    g.box.style.left = `${fractionStart * 100}%`;
    g.box.style.width = `${Math.max(2, fractionWidth * 100)}%`;
  });

  const last = state.liveFrames[state.liveFrames.length - 1];
  if (last) updateLatestValues(last);

  drawHeatmap(visible, startIdx);
}

function renderLivePoint(d) {
  updateLatestValues(d);
  const label = new Date().toLocaleTimeString();

  Object.values(state.graphs).forEach(g => {
    g.detail.data.labels.push(label);
    g.overview.data.labels.push(label);

    g.detail.data.datasets.forEach(ds => {
      const v = scaleValue(ds._key, d[ds._key], ds._scale);
      ds.data.push(v);
      if (ds.data.length > state.liveMax) ds.data.shift();
    });

    g.overview.data.datasets.forEach(ds => {
      const v = scaleValue(ds._key, d[ds._key], ds._scale);
      ds.data.push(v);
      if (ds.data.length > state.liveMax) ds.data.shift();
    });

    if (g.detail.data.labels.length > state.liveMax) g.detail.data.labels.shift();
    if (g.overview.data.labels.length > state.liveMax) g.overview.data.labels.shift();

    g.detail.update("none");
    g.overview.update("none");

    g.box.style.left = "0px";
    g.box.style.width = "100%";
  });
}

function handleProsodyMessage(d) {
  if (state.currentMode !== "live") return;
  if (!d || d.type !== "prosody_features") return;
  const entry = updateLiveBuffers(d);
  renderLivePoint(entry);
  renderLiveGraphsWindow();

  if (Array.isArray(d.melFrame) && d.melFrame.length) {
    state.liveSpecCols.push(d.melFrame);
    if (state.liveSpecCols.length > state.liveMax) {
      state.liveSpecCols.shift();
    }
    renderLiveSpectrogram();
  }

  drawLiveWaveform();
}

function drawLiveWaveform() {
  const ctx = state.clipWaveformCtx;
  if (!ctx || !state.liveFrames.length) return;
  const endIdx = state.liveFrames.length - 1;
  const hop = state.clipFrameHopSec > 0 ? state.clipFrameHopSec : 0.02;
  const startIdx = Math.max(0, state.liveFrames.length - Math.floor(state.clipWindowSec / hop));
  const windowFrames = state.liveFrames.slice(startIdx, endIdx + 1);
  drawWaveform(windowFrames);
}
