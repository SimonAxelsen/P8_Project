function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function downsampleFloat32(input, inRate, outRate) {
  if (outRate === inRate) return input;
  const ratio = inRate / outRate;
  const newLen = Math.floor(input.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const idx0 = Math.floor(idx);
    const idx1 = Math.min(input.length - 1, idx0 + 1);
    const frac = idx - idx0;
    out[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return out;
}

function floatToInt16PCM(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clearCanvas(ctx) {
  if (!ctx || !ctx.canvas) return;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function resizeCanvasToDisplaySize(canvas, ratio = window.devicePixelRatio || 1) {
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  const displayWidth = Math.round(rect.width * ratio);
  const displayHeight = Math.round(rect.height * ratio);
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    return true;
  }
  return false;
}

function pickWaveValue(frame) {
  if (!frame) return 0;
  if (typeof frame.rms === "number" && isFinite(frame.rms)) return frame.rms;
  if (typeof frame.rmsDb === "number" && isFinite(frame.rmsDb)) return Math.max(0, frame.rmsDb + 80) / 80;
  if (typeof frame.energy === "number" && isFinite(frame.energy)) return frame.energy;
  return 0;
}
