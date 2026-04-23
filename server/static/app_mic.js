async function startMicStream() {
  const status = state.micStatusEl;
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.micCtx.createMediaStreamSource(state.micStream);
    state.micProcessor = state.micCtx.createScriptProcessor(2048, 1, 1);

    state.micSocket = new WebSocket(state.prosodyWs);
    state.micSocket.binaryType = "arraybuffer";
    state.micSocket.onopen = () => {
      status.textContent = `Mic streaming to ${state.prosodyWs}`;
      state.micUseDisplaySocket = true;
    };
    state.micSocket.onclose = () => {
      status.textContent = "Mic stream closed.";
      state.micUseDisplaySocket = false;
    };
    state.micSocket.onmessage = (e) => {
      const d = safeJsonParse(e.data);
      if (!d) return;
      handleProsodyMessage(d);
    };

    state.micProcessor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const down = downsampleFloat32(input, state.micCtx.sampleRate, MIC_SR_TARGET);
      const pcm = floatToInt16PCM(down);
      state.micBuffer.push(pcm);
      state.micBufferSamples += pcm.length;
      flushMicFrames();
    };

    source.connect(state.micProcessor);
    state.micProcessor.connect(state.micCtx.destination);
  } catch (err) {
    status.textContent = "Mic error: " + err;
  }
}

function flushMicFrames() {
  if (!state.micSocket || state.micSocket.readyState !== WebSocket.OPEN) return;
  while (state.micBufferSamples >= MIC_FRAME_SAMPLES) {
    const frame = new Int16Array(MIC_FRAME_SAMPLES);
    let offset = 0;
    while (offset < MIC_FRAME_SAMPLES && state.micBuffer.length) {
      const head = state.micBuffer[0];
      const take = Math.min(head.length, MIC_FRAME_SAMPLES - offset);
      frame.set(head.subarray(0, take), offset);
      offset += take;
      if (take < head.length) {
        state.micBuffer[0] = head.subarray(take);
      } else {
        state.micBuffer.shift();
      }
    }
    state.micBufferSamples -= MIC_FRAME_SAMPLES;
    state.micSocket.send(frame.buffer);
  }
}

function stopMicStream() {
  const status = state.micStatusEl;
  if (state.micProcessor) state.micProcessor.disconnect();
  if (state.micCtx) state.micCtx.close();
  if (state.micStream) state.micStream.getTracks().forEach(t => t.stop());
  if (state.micSocket && state.micSocket.readyState === WebSocket.OPEN) state.micSocket.close();
  state.micProcessor = null;
  state.micCtx = null;
  state.micStream = null;
  state.micSocket = null;
  state.micBuffer = [];
  state.micBufferSamples = 0;
  status.textContent = "Mic idle.";
  state.micUseDisplaySocket = false;
}
