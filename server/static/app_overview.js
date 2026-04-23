function overviewEventToTime(e) {
  if (!state.clipMel || !state.clipMel.length || !state.clipMel[0] || !state.clipFrameHopSec) return 0;
  const rect = state.clipSpecOverview.getBoundingClientRect();
  if (!rect.width || !isFinite(rect.width)) return 0;
  const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
  const frames = state.clipMel[0].length;
  if (!frames) return 0;
  const frac = x / rect.width;
  const frameIdx = Math.floor(frac * frames);
  return frameIdx * state.clipFrameHopSec;
}

function seekFromOverviewEvent(e) {
  const t = overviewEventToTime(e);
  const player = document.getElementById("player");
  if (!player) return;
  player.currentTime = Math.max(0, Math.min(state.clipDuration, t));
  renderClipAtTime(player.currentTime);
}
