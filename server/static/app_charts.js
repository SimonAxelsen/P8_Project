const ALL_SIGNALS = [
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
  { key: "speechConfidence", label: "speechConfidence", scale: 1 },
  { key: "boundaryConfidence", label: "boundaryConfidence*100", scale: 100 },
  { key: "turnEndScore", label: "turnEndScore", scale: 1 },
  { key: "questionLike", label: "questionLike", scale: 1 },
  { key: "engagementScore", label: "engagementScore", scale: 1 },
  { key: "mfcc0", label: "mfcc0", scale: 1 },
  { key: "mfcc1", label: "mfcc1", scale: 1 },
  { key: "mfcc2", label: "mfcc2", scale: 1 },
  { key: "mfccDelta0", label: "mfccDelta0", scale: 1 },
];

const DEFAULT_SELECTIONS = {
  g1: ["rmsDb", "snrLike", "pauseMs", "vad", "f0Mean", "voicedRatio"],
  g2: ["specCentroid", "specRolloff", "specFlatness", "specFlux", "speechConfidence", "boundaryConfidence", "turnEndScore", "questionLike", "engagementScore"],
};

state.graphConfigs = {
  g1: { selected: new Set(DEFAULT_SELECTIONS.g1) },
  g2: { selected: new Set(DEFAULT_SELECTIONS.g2) },
};

const CHART_FONT_FAMILY = "Manrope, IBM Plex Sans, Segoe UI, sans-serif";
const CHART_TICK_FONT = { family: CHART_FONT_FAMILY, size: 13, weight: "600" };
const CHART_LEGEND_FONT = { family: CHART_FONT_FAMILY, size: 13, weight: "700" };

function lineColor(idx) {
  const palette = [
    cssVar("--series-1"), cssVar("--series-2"), cssVar("--series-3"), cssVar("--series-4"), cssVar("--series-5"),
    cssVar("--series-6"), cssVar("--series-7"), cssVar("--series-8"), cssVar("--series-9"), cssVar("--series-10"),
  ];
  return palette[idx % palette.length] || cssVar("--series-1") || "#2b6cb0";
}

function lineColorForKey(key) {
  const order = [
    "rmsDb", "snrLike", "pauseMs", "vad", "rms", "noiseRms", "zcr",
    "f0Mean", "f0Slope", "voicedRatio", "specCentroid", "specRolloff",
    "specFlatness", "specFlux", "speechConfidence", "boundaryConfidence",
    "turnEndScore", "questionLike", "engagementScore", "mfcc0", "mfcc1",
    "mfcc2", "mfccDelta0"
  ];
  const idx = Math.max(0, order.indexOf(key));
  return lineColor(idx);
}

function chartThemeOptions() {
  return {
    grid: cssVar("--grid") || "rgba(68, 86, 110, 0.18)",
    text: cssVar("--text") || "#1a2333",
  };
}

function signalsForGraph(graphId) {
  return ALL_SIGNALS.filter(s => state.graphConfigs[graphId].selected.has(s.key));
}

function datasetsForGraph(graphId) {
  return signalsForGraph(graphId).map((s) => ({
    label: s.label,
    data: [],
    _key: s.key,
    _colorKey: s.key,
    _scale: s.scale,
    tension: 0.15,
    pointRadius: 0,
    borderWidth: 2,
    borderColor: lineColorForKey(s.key),
    backgroundColor: lineColorForKey(s.key),
  }));
}

function datasetsForOverlay(graphId) {
  const base = signalsForGraph(graphId);
  const processed = [];
  const original = [];

  base.forEach((s) => {
    processed.push({
      label: `${s.label} (processed)`,
      data: [],
      _key: s.key,
      _colorKey: s.key,
      _scale: s.scale,
      _source: "processed",
      tension: 0.15,
      pointRadius: 0,
      borderWidth: 2,
      borderColor: lineColorForKey(s.key),
      backgroundColor: lineColorForKey(s.key),
    });
    original.push({
      label: `${s.label} (original)`,
      data: [],
      _key: s.key,
      _colorKey: s.key,
      _scale: s.scale,
      _source: "original",
      tension: 0.15,
      pointRadius: 0,
      borderWidth: 1,
      borderDash: [6, 4],
      borderColor: lineColorForKey(s.key),
      backgroundColor: lineColorForKey(s.key),
    });
  });

  return processed.concat(original);
}

function createChart(canvasId, graphId, showPoints=false) {
  const theme = chartThemeOptions();
  return new Chart(document.getElementById(canvasId), {
    type: "line",
    data: {
      labels: [],
      datasets: datasetsForGraph(graphId),
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      devicePixelRatio: Math.max(3, window.devicePixelRatio || 1),
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          display: true,
          ticks: { maxTicksLimit: 10, color: theme.text, font: CHART_TICK_FONT, padding: 6 },
          grid: { color: theme.grid }
        },
        y: {
          ticks: { color: theme.text, font: CHART_TICK_FONT, padding: 6 },
          grid: { color: theme.grid }
        }
      },
      plugins: {
        legend: { display: false }
      },
      elements: {
        point: {
          radius: showPoints ? 2 : 0
        }
      }
    }
  });
}

function initCharts() {
  state.graphs = {
    g1: {
      overview: createChart("overview_g1", "g1", false),
      detail: createChart("detail_g1", "g1", true),
      box: document.getElementById("box_g1"),
    },
    g2: {
      overview: createChart("overview_g2", "g2", false),
      detail: createChart("detail_g2", "g2", true),
      box: document.getElementById("box_g2"),
    },
  };
  updateChartTheme();
  updateGraphLegends();
}

function rebuildGraphDatasets(graphId) {
  const graph = state.graphs[graphId];
  if (state.overlayMode && state.clipOriginal) {
    graph.overview.data.datasets = datasetsForOverlay(graphId);
    graph.detail.data.datasets = datasetsForOverlay(graphId);
  } else {
    graph.overview.data.datasets = datasetsForGraph(graphId);
    graph.detail.data.datasets = datasetsForGraph(graphId);
  }
  graph.overview.update("none");
  graph.detail.update("none");
  updateGraphLegends();
}

function updateChartTheme() {
  if (!state.graphs) return;
  const theme = chartThemeOptions();
  Object.values(state.graphs).forEach(g => {
    [g.overview, g.detail].forEach(chart => {
      chart.data.datasets.forEach(ds => {
        const c = lineColorForKey(ds._colorKey || ds._key || "");
        ds.borderColor = c;
        ds.backgroundColor = c;
      });
      chart.options.scales.x.ticks.color = theme.text;
      chart.options.scales.x.grid.color = theme.grid;
      if (chart.options.scales.y) {
        chart.options.scales.y.ticks.color = theme.text;
        chart.options.scales.y.grid.color = theme.grid;
      }
      if (chart.options.plugins && chart.options.plugins.legend) {
        chart.options.plugins.legend.labels.color = theme.text;
        chart.options.plugins.legend.labels.font = CHART_LEGEND_FONT;
      }
      chart.update("none");
    });
  });
  updateGraphLegends();
}

function updateGraphLegends() {
  ["g1", "g2"].forEach(graphId => {
    const legendEl = document.getElementById(`legend_${graphId}`);
    if (!legendEl) return;
    const signals = signalsForGraph(graphId);
    legendEl.innerHTML = "";
    signals.forEach(sig => {
      const item = document.createElement("div");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = lineColorForKey(sig.key);
      const label = document.createElement("span");
      label.textContent = sig.label;
      item.appendChild(swatch);
      item.appendChild(label);
      legendEl.appendChild(item);
    });
  });
}

function rebuildSignalToggles() {
  ["g1", "g2"].forEach(graphId => {
    const wrap = document.getElementById("signals_" + graphId);
    wrap.innerHTML = "";

    ALL_SIGNALS.forEach(sig => {
      const label = document.createElement("label");
      const checked = state.graphConfigs[graphId].selected.has(sig.key) ? "checked" : "";
      label.innerHTML = `<input type="checkbox" data-graph="${graphId}" data-key="${sig.key}" ${checked}> ${sig.label}`;
      wrap.appendChild(label);
    });
  });

  document.querySelectorAll('.signal-list input[type="checkbox"][data-graph]').forEach(cb => {
    cb.addEventListener("change", () => {
      const graphId = cb.dataset.graph;
      const key = cb.dataset.key;
      if (!state.graphConfigs[graphId]) return;
      if (cb.checked) {
        state.graphConfigs[graphId].selected.add(key);
      } else {
        state.graphConfigs[graphId].selected.delete(key);
      }
      rebuildGraphDatasets(graphId);
      rerenderCurrentMode();
    });
  });
  updateGraphLegends();
}

function clearChart(chart) {
  chart.data.labels = [];
  chart.data.datasets.forEach(ds => ds.data = []);
  chart.update("none");
}

function clearAllCharts() {
  Object.values(state.graphs).forEach(g => {
    clearChart(g.overview);
    clearChart(g.detail);
  });
}

function refillChart(chart, points, labels) {
  chart.data.labels = labels.slice();
  chart.data.datasets.forEach(ds => {
    ds.data = points.map(p => scaleValue(ds._key, p[ds._key], ds._scale));
  });
  chart.update("none");
}

function refillOverlayChart(chart, processed, original, labels) {
  chart.data.labels = labels.slice();
  chart.data.datasets.forEach(ds => {
    const src = ds._source === "original" ? original : processed;
    if (!src) {
      ds.data = [];
      return;
    }
    ds.data = src.map(p => scaleValue(ds._key, p[ds._key], ds._scale));
  });
  chart.update("none");
}
