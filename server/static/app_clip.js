function collectSelectedFilters() {
  const filters = [];
  document.querySelectorAll('#filterList input[type="checkbox"]').forEach(cb => {
    if (cb.checked) filters.push(cb.dataset.filter);
  });
  return filters;
}

function summarizeFilters(filters) {
  if (!filters.length) return "Raw";
  const labels = {
    noise: "Noise suppression",
    highpass: "High-pass (80 Hz)",
    lowpass: "Low-pass (4 kHz)",
    bandpass: "Band-pass (80-4000 Hz)",
    normalize: "Normalize RMS",
    preemphasis: "Pre-emphasis",
    distortion: "Drive / distortion",
    tremolo: "Tremolo (volume mod)",
    sawtooth: "Sawtooth mod",
    ringmod: "Ring mod",
    bitcrush: "Bitcrush",
    echo: "Echo",
  };
  return filters.map(f => labels[f] || f).join(", ");
}

function computeBaselineFromFeatures(features) {
  if (!features || !features.length) return null;
  const stats = {};
  ALL_SIGNALS.forEach(sig => {
    const vals = features
      .map(f => f[sig.key])
      .filter(v => typeof v === "number" && isFinite(v));
    if (!vals.length) return;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varSum = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length;
    const std = Math.sqrt(varSum + 1e-9);
    stats[sig.key] = { mean, std };
  });
  return stats;
}

function applyBaselineTransform(key, value) {
  const baselineNormalize = state.baselineNormalize;
  if (!baselineNormalize || !baselineNormalize.checked) return value;
  if (!state.baselineStats || !state.baselineStats[key]) return value;
  const { mean, std } = state.baselineStats[key];
  if (!isFinite(mean) || !isFinite(std) || std <= 0) return value;
  return (value - mean) / std;
}

function scaleValue(key, raw, scale) {
  if (raw === undefined || raw === null) return null;
  const normalized = applyBaselineTransform(key, raw);
  const baselineNormalize = state.baselineNormalize;
  if (baselineNormalize && baselineNormalize.checked) {
    return normalized;
  }
  return normalized * scale;
}

function renderBoundaryList(boundaries) {
  const box = document.getElementById("boundaryList");
  if (!boundaries || !boundaries.length) {
    box.innerHTML = "None";
    return;
  }
  box.innerHTML = boundaries
    .map(b => `t=${b.t.toFixed(2)}s, conf=${b.confidence.toFixed(2)}`)
    .join("<br/>");
}

function findNearestPoint(t, arr) {
  if (!arr.length) return null;
  let best = arr[0];
  let bestDiff = Math.abs((best.t || 0) - t);

  for (let i = 1; i < arr.length; i++) {
    const diff = Math.abs((arr[i].t || 0) - t);
    if (diff < bestDiff) {
      best = arr[i];
      bestDiff = diff;
    }
  }
  return best;
}

function findCurrentSegment(t, segments) {
  for (const s of segments) {
    if (t >= s.start && t <= s.end) return s;
  }
  return null;
}

function visibleClipWindow(t) {
  const half = state.clipWindowSec / 2;
  let start = Math.max(0, t - half);
  let end = Math.min(state.clipDuration, t + half);

  if ((end - start) < state.clipWindowSec) {
    if (start <= 0) {
      end = Math.min(state.clipDuration, state.clipWindowSec);
    } else if (end >= state.clipDuration) {
      start = Math.max(0, state.clipDuration - state.clipWindowSec);
    }
  }

  return { start, end };
}

function renderClipAtTime(t) {
  const sourceFeatures = state.showOriginal && state.clipOriginal ? state.clipOriginal : state.clipFeatures;
  if (!sourceFeatures || !sourceFeatures.length) return;

  const windowInfo = visibleClipWindow(t);
  const start = windowInfo.start;
  const end = windowInfo.end;

  const visible = sourceFeatures.filter(p => p.t >= start && p.t <= end);
  const overviewLabels = sourceFeatures.map(p => `${p.t.toFixed(2)}s`);
  const detailLabels = visible.map(p => `${p.t.toFixed(2)}s`);

  const overlayActive = state.overlayMode && state.clipOriginal && state.clipFeatures && state.clipOriginal.length;
  const overlayVisibleOriginal = overlayActive ? state.clipOriginal.filter(p => p.t >= start && p.t <= end) : null;
  const overlayVisibleProcessed = overlayActive ? state.clipFeatures.filter(p => p.t >= start && p.t <= end) : null;

  Object.entries(state.graphs).forEach(([graphId, g]) => {
    if (overlayActive) {
      refillOverlayChart(g.overview, state.clipFeatures, state.clipOriginal, overviewLabels);
      refillOverlayChart(g.detail, overlayVisibleProcessed, overlayVisibleOriginal, detailLabels);
    } else {
      refillChart(g.overview, sourceFeatures, overviewLabels);
      refillChart(g.detail, visible, detailLabels);
    }

    const fractionStart = state.clipDuration > 0 ? (start / state.clipDuration) : 0;
    const fractionWidth = state.clipDuration > 0 ? ((end - start) / state.clipDuration) : 1;

    g.box.style.left = `${fractionStart * 100}%`;
    g.box.style.width = `${Math.max(2, fractionWidth * 100)}%`;
  });

  const nearest = findNearestPoint(t, sourceFeatures);
  if (nearest) updateLatestValues(nearest);

  const seg = state.showOriginal && state.clipOriginalMeta ? findCurrentSegment(t, state.clipOriginalMeta.segments || []) : findCurrentSegment(t, state.clipSegments);
  const segEl = document.getElementById("currentSegment");
  if (segEl) {
    const valueEl = segEl.querySelector(".segment-value");
    const text = seg ? `${seg.type} (${seg.start.toFixed(2)}s ⇄ ${seg.end.toFixed(2)}s)` : "none";
    if (valueEl) {
      valueEl.textContent = text;
    } else {
      segEl.textContent = `Current segment: ${text}`;
    }
  }

  if (state.clipFrameHopSec > 0) {
    const w = visibleClipWindow(t);
    const useMel = state.showOriginal && state.clipOriginalMeta && state.clipOriginalMeta.mel ? state.clipOriginalMeta.mel : state.clipMel;
    const hop = state.showOriginal && state.clipOriginalMeta && state.clipOriginalMeta.hop ? state.clipOriginalMeta.hop : state.clipFrameHopSec;
    if (useMel) {
      const startIdx = Math.floor(w.start / hop);
      const endIdx = Math.ceil(w.end / hop);
      renderSpectrogramCanvas(state.clipSpecCtx, useMel, startIdx, endIdx, true);
      renderOverviewWithWindow(useMel, startIdx, endIdx);
    }
  }

  if (state.clipWaveformCtx) {
    resizeCanvasToDisplaySize(state.clipWaveformCtx.canvas, window.devicePixelRatio || 1);
    const w = visibleClipWindow(t);
    const useFeatures = state.showOriginal && state.clipOriginal ? state.clipOriginal : state.clipFeatures;
    const windowed = useFeatures.filter(p => p.t >= w.start && p.t <= w.end);
    drawWaveform(windowed);
  }

  if (sourceFeatures && sourceFeatures.length) {
    const w = visibleClipWindow(t);
    const hop = state.showOriginal && state.clipOriginalMeta && state.clipOriginalMeta.hop ? state.clipOriginalMeta.hop : state.clipFrameHopSec;
    const startIdx = Math.max(0, Math.floor(w.start / hop));
    const endIdx = Math.min(sourceFeatures.length, Math.ceil(w.end / hop));
    const windowFrames = sourceFeatures.slice(startIdx, endIdx);
    drawHeatmap(windowFrames, startIdx);
  }
}

function drawWaveform(frames) {
  const ctx = state.clipWaveformCtx;
  if (!ctx) return;
  const ratio = window.devicePixelRatio || 1;
  resizeCanvasToDisplaySize(ctx.canvas, ratio);
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const pad = 6 * ratio;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
  ctx.fillRect(0, 0, w, h);

  if (!frames || !frames.length) return;

  const vals = frames.map(f => pickWaveValue(f));
  const max = Math.max(...vals, 1e-6);

  ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
  ctx.lineWidth = 2 * ratio;
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const idx = Math.min(vals.length - 1, Math.floor((i / w) * vals.length));
    const v = vals[idx] / max;
    const y = h / 2 - (v * (h / 2 - pad));
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const idx = Math.min(vals.length - 1, Math.floor((i / w) * vals.length));
    const v = vals[idx] / max;
    const y = h / 2 + (v * (h / 2 - pad));
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  }
  ctx.stroke();
}

async function handleClipUpload() {
  const fileInput = document.getElementById("audioFile");
  const status = document.getElementById("uploadStatus");
  const summary = document.getElementById("clipSummary");
  const spectroStatus = document.getElementById("spectrogramStatus");
  const player = document.getElementById("player");
  const filters = collectSelectedFilters();

  if (!fileInput.files.length) {
    status.textContent = "Choose an audio file first.";
    return;
  }

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("filters", JSON.stringify(filters));

  status.textContent = "Uploading and processing...";
  spectroStatus.textContent = "Rendering spectrogram...";
  summary.innerHTML = "";

  try {
    const res = await fetch("/analyze_clip", {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      const txt = await res.text();
      status.textContent = "Processing failed: " + txt;
      if (player) {
        player.src = "/clip_audio?variant=processed";
        player.load();
      }
      return;
    }

    const result = await res.json();

    state.currentMode = "clip";
    setModeChip();
    state.showOriginal = state.activeClipVariant === "original";
    state.clipFeatures = result.features || [];
    state.clipSegments = result.segments || [];
    state.clipBoundaries = result.boundaries || [];
    state.clipDuration = (result.summary && result.summary.durationSec) ? result.summary.durationSec : 0;
    state.clipMel = result.melSpectrogram || null;
    state.clipFrameHopSec = result.melFrameHopSec || 0.01;

    if (result.original) {
      state.clipOriginal = result.original.features || null;
      state.clipOriginalMeta = {
        segments: result.original.segments || [],
        boundaries: result.original.boundaries || [],
        duration: (result.original.summary && result.original.summary.durationSec) ? result.original.summary.durationSec : 0,
        mel: result.original.melSpectrogram || null,
        hop: result.original.melFrameHopSec || state.clipFrameHopSec,
      };
    } else {
      state.clipOriginal = null;
      state.clipOriginalMeta = null;
    }

    const activeBoundaries = state.showOriginal && state.clipOriginalMeta ? (state.clipOriginalMeta.boundaries || []) : state.clipBoundaries;
    renderBoundaryList(activeBoundaries);
    renderClipAtTime(0);

    const hasSpectro = state.showOriginal && state.clipOriginalMeta ? !!state.clipOriginalMeta.mel : !!state.clipMel;
    spectroStatus.textContent = hasSpectro ? "" : "Spectrogram not available.";

    const s = result.summary || {};
    const filterLabel = summarizeFilters(filters);
    summary.innerHTML = "";
    const rows = [
      ["Duration", `${(s.durationSec ?? 0).toFixed(2)} s`],
      ["Frames", `${Math.round(s.numFrames ?? 0)}`],
      ["Filters", filterLabel],
      ["Mean RMS dB", `${(s.meanRmsDb ?? 0).toFixed(2)}`],
      ["Mean F0", `${(s.meanF0 ?? 0).toFixed(2)} Hz`],
      ["Speech confidence", `${(s.meanSpeechConfidence ?? 0).toFixed(2)}`],
      ["Boundary confidence", `${(s.meanBoundaryConfidence ?? 0).toFixed(2)}`],
      ["Voiced ratio", `${(s.voicedFrameRatio ?? 0).toFixed(2)}`],
      ["Speech-like ratio", `${(s.speechLikeRatio ?? 0).toFixed(2)}`],
      ["Segments", `${state.clipSegments.length}`],
      ["Boundaries", `${state.clipBoundaries.length}`],
    ];
    rows.forEach(([label, value]) => {
      const div = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      div.appendChild(strong);
      div.appendChild(document.createTextNode(value));
      summary.appendChild(div);
    });

    status.textContent = "Processing done. Press play to see the highlighted window move.";
    updateViewButtons();
    state.lastFilterPayload = filters;

    rebuildGraphDatasets("g1");
    rebuildGraphDatasets("g2");

    const variant = state.showOriginal ? "original" : "processed";
    player.src = `/clip_audio?variant=${variant}`;
  } catch (err) {
    status.textContent = "Processing failed: " + err;
    spectroStatus.textContent = "Spectrogram failed to load.";
    if (player) {
      player.src = "/clip_audio?variant=processed";
      player.load();
    }
  }
}
