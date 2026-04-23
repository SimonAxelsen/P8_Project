function drawHeatmap(frames, windowStartIdx = 0) {
  if (!frames || !frames.length) return;
  const w = state.heatmap.width;
  const h = state.heatmap.height;
  const img = state.heatmapCtx.createImageData(w, h);

  const visible = frames;
  const n = visible.length;
  const topBand = Math.floor(h * 0.4);
  const midBand = Math.floor(h * 0.35);
  const botBand = h - topBand - midBand;

  const f0Vals = visible.map(f => f.f0Mean || 0);
  const rmsVals = visible.map(f => f.rmsDb || -60);
  const bcVals = visible.map(f => f.boundaryConfidence || 0);

  const f0Min = Math.min(...f0Vals.filter(v => v > 0).concat([80]));
  const f0Max = Math.max(...f0Vals.concat([300]));
  const rmsMin = -60;
  const rmsMax = -10;

  for (let x = 0; x < w; x++) {
    const idx = Math.min(n - 1, Math.floor((x / w) * n));
    const f0 = f0Vals[idx];
    const rms = rmsVals[idx];
    const bc = bcVals[idx];

    const f0n = f0 > 0 ? clamp((f0 - f0Min) / (f0Max - f0Min + 1e-6), 0, 1) : 0;
    const rmsn = clamp((rms - rmsMin) / (rmsMax - rmsMin), 0, 1);
    const bcn = clamp(bc, 0, 1);

    for (let y = 0; y < h; y++) {
      let r = 10, g = 10, b = 12, a = 255;
      if (y < topBand) {
        const t = f0n;
        r = Math.floor(40 + 60 * t);
        g = Math.floor(80 + 60 * t);
        b = Math.floor(160 + 90 * t);
      } else if (y < topBand + midBand) {
        const t = rmsn;
        r = Math.floor(30 + 50 * t);
        g = Math.floor(90 + 130 * t);
        b = Math.floor(50 + 60 * t);
      } else {
        const t = bcn;
        r = Math.floor(120 + 120 * t);
        g = Math.floor(70 + 90 * t);
        b = Math.floor(20 + 30 * t);
      }

      const row = h - 1 - y;
      const p = (row * w + x) * 4;
      img.data[p] = r;
      img.data[p + 1] = g;
      img.data[p + 2] = b;
      img.data[p + 3] = a;
    }
  }

  state.heatmapCtx.putImageData(img, 0, 0);
}
