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

function updateLatestValues(d) {
  const keysToShow = [
    "vad","pauseMs","speechMs","rms","rmsDb","noiseRms","snrLike","zcr",
    "f0Mean","f0Slope","voicedRatio",
    "specCentroid","specRolloff","specFlatness","specFlux",
    "speechConfidence","boundaryConfidence","turnEndScore","questionLike","engagementScore",
    "mfcc0","mfcc1","mfcc2","mfccDelta0"
  ];

  keysToShow.forEach(k => {
    if (d[k] !== undefined) {
      const val = (typeof d[k] === "number")
        ? d[k].toFixed((k === "vad") ? 0 : (k.includes("Ms") ? 0 : 2))
        : String(d[k]);
      setKV(k, val);
    }
  });

  updateScoreCard("scoreTurnEnd", "scoreTurnEndVal", d.turnEndScore);
  updateScoreCard("scoreQuestion", "scoreQuestionVal", d.questionLike);
  updateScoreCard("scoreEngagement", "scoreEngagementVal", d.engagementScore);
}

function updateScoreCard(cardId, valId, score) {
  const card = document.getElementById(cardId);
  const val = document.getElementById(valId);
  if (!card || !val || score === undefined || score === null) return;

  const v = Number(score);
  val.textContent = v.toFixed(2);
  card.classList.remove("score-low", "score-mid", "score-high");
  if (v >= 0.7) {
    card.classList.add("score-high");
  } else if (v >= 0.4) {
    card.classList.add("score-mid");
  } else {
    card.classList.add("score-low");
  }
}
