function melColor(v) {
  const t = clamp((v + 80) / 80, 0, 1);
  const r = Math.floor(24 + 220 * t);
  const g = Math.floor(18 + 120 * t);
  const b = Math.floor(36 + 70 * (1 - t));
  return [r, g, b, 255];
}

function renderSpectrogramCanvas(ctx, mel, startIdx = 0, endIdx = null, normalize = false) {
  if (!mel || !mel.length || !mel[0].length) return;

  const h = ctx.canvas.height;
  const w = ctx.canvas.width;
  const img = ctx.createImageData(w, h);

  const bins = mel.length;
  const frames = mel[0].length;
  const s = Math.max(0, Math.min(frames - 1, startIdx));
  const e = endIdx === null ? frames : Math.max(s + 1, Math.min(frames, endIdx));
  const viewFrames = Math.max(1, e - s);

  let vmin = 1e9;
  let vmax = -1e9;
  if (normalize) {
    for (let b = 0; b < bins; b++) {
      const row = mel[b];
      for (let f = s; f < e; f++) {
        const v = row[f];
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
    }
    if (!isFinite(vmin) || !isFinite(vmax) || Math.abs(vmax - vmin) < 1e-6) {
      vmin = -80;
      vmax = 0;
    }
  }

  for (let x = 0; x < w; x++) {
    const srcIdx = s + Math.floor((x / w) * viewFrames);
    for (let y = 0; y < h; y++) {
      const bin = Math.floor((y / h) * bins);
      let v = mel[bin][srcIdx];
      if (normalize) {
        const t = (v - vmin) / (vmax - vmin);
        v = (t * 80) - 80;
      }
      const [r, g, b, a] = melColor(v);
      const row = h - 1 - y;
      const idx = (row * w + x) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = a;
    }
  }

  ctx.putImageData(img, 0, 0);
}

function renderOverviewWithWindow(mel, startIdx, endIdx) {
  if (!mel || !mel.length) return;
  renderSpectrogramCanvas(state.clipSpecOverviewCtx, mel, 0, null, false);

  const frames = mel[0].length;
  if (frames <= 0) return;

  const w = state.clipSpecOverview.width;
  const h = state.clipSpecOverview.height;
  const x1 = Math.floor((startIdx / frames) * w);
  const x2 = Math.floor((endIdx / frames) * w);
  const boxW = Math.max(2, x2 - x1);

  state.clipSpecOverviewCtx.strokeStyle = "rgba(255,255,255,0.9)";
  state.clipSpecOverviewCtx.lineWidth = 2;
  state.clipSpecOverviewCtx.strokeRect(x1, 1, boxW, h - 2);
}

function renderLiveSpectrogram() {
  if (!state.liveSpecCols.length) return;
  if (!state.clipFrameHopSec || state.clipFrameHopSec <= 0) return;

  const endIdx = state.liveSpecCols.length - 1;
  const endTime = endIdx * state.clipFrameHopSec;
  const startTime = Math.max(0, endTime - state.clipWindowSec);
  const startIdx = Math.max(0, Math.floor(startTime / state.clipFrameHopSec));
  const endFrameIdx = endIdx + 1;

  const slice = state.liveSpecCols.slice(startIdx, endFrameIdx);
  if (!slice.length) return;

  const melWindow = [];
  const numBins = slice[0].length;
  for (let b = 0; b < numBins; b++) melWindow.push([]);
  for (let i = 0; i < slice.length; i++) {
    const col = slice[i];
    for (let b = 0; b < numBins; b++) {
      melWindow[b].push(col[b]);
    }
  }

  renderSpectrogramCanvas(state.liveSpecCtx, melWindow, 0, null, true);
}
