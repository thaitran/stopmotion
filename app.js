'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('stage'),
  video: $('live'),
  canvas: $('frameCanvas'),
  flash: $('flash'),
  badge: $('badge'),
  message: $('message'),
  messageText: $('messageText'),
  retryBtn: $('retryBtn'),
  cameraSelect: $('cameraSelect'),
  mirrorInput: $('mirrorInput'),
  captureBtn: $('captureBtn'),
  removeBtn: $('removeBtn'),
  playBtn: $('playBtn'),
  downloadBtn: $('downloadBtn'),
  clearBtn: $('clearBtn'),
  micSelect: $('micSelect'),
  recordAudioBtn: $('recordAudioBtn'),
  removeAudioBtn: $('removeAudioBtn'),
  fpsInput: $('fpsInput'),
  fpsOut: $('fpsOut'),
  ghostInput: $('ghostInput'),
  ghostOut: $('ghostOut'),
  frameCount: $('frameCount'),
  duration: $('duration'),
  filmstrip: $('filmstrip'),
};

const ctx = els.canvas.getContext('2d');

const state = {
  stream: null,
  deviceId: null,
  mirror: false,       // flip the camera image left-to-right (live view and captures)
  frames: [],          // { url, img }, in playback order
  current: -1,         // index of the frame shown in the preview
  width: 0,            // output frame size, fixed by the first captured frame
  height: 0,
  busy: false,         // a capture is being encoded
  playing: false,
  playHandle: 0,
  playIndex: 0,
  playOnEnd: null,
  exporting: false,
  audio: null,         // { blob, url, fps }: the recording and the speed it was recorded at
  recording: null,     // { recorder } while recording audio
};

/* ---------- Preferences ---------- */

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('stopmotion.' + key);
      return v === null ? fallback : v;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('stopmotion.' + key, value); } catch {}
  },
};

els.fpsInput.value = prefs.get('frameRate', '8');
els.ghostInput.value = prefs.get('ghostAmount', '50');

const fps = () => Number(els.fpsInput.value);
const ghost = () => Number(els.ghostInput.value) / 100;

/* ---------- Camera ---------- */

function showMessage(text, retry = true) {
  els.messageText.textContent = text;
  els.retryBtn.hidden = !retry;
  els.message.hidden = false;
}

function hideMessage() {
  els.message.hidden = true;
}

function stopStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  els.video.srcObject = null;
}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage('This browser can’t access cameras here. Open the app from http://localhost (or https) in Chrome, Edge, Firefox or Safari.', false);
    return;
  }

  stopStream();
  const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (deviceId) video.deviceId = { exact: deviceId };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      // Remembered camera is gone; fall back to whatever is available.
      return startCamera(null);
    }
    const reasons = {
      NotAllowedError: 'Camera access was blocked. Open this page in Chrome, Safari or Firefox and allow camera access when asked. On a Mac, the browser also needs to be turned on under System Settings → Privacy & Security → Camera.',
      NotFoundError: 'No camera found. Plug in a USB camera, then try again.',
      NotReadableError: 'The camera is in use by another app (or can’t be opened). Close other apps using it, then try again.',
    };
    showMessage(reasons[err.name] || `Couldn’t start the camera: ${err.message || err.name}`);
    await refreshCameraList();
    updateControls();
    return;
  }

  state.stream = stream;
  const track = stream.getVideoTracks()[0];
  state.deviceId = track.getSettings().deviceId || deviceId || null;
  if (state.deviceId) prefs.set('camera', state.deviceId);

  // Front cameras are mirrored like a mirror, unless the user chose otherwise for this camera.
  const saved = prefs.get('mirror.' + state.deviceId, null);
  setMirror(saved === null ? isFrontCamera(track) : saved === '1');

  track.addEventListener('ended', () => {
    if (state.stream !== stream) return;
    showMessage('The camera was disconnected. Reconnect it or pick another camera.');
    refreshCameraList();
    updateControls();
  });

  els.video.srcObject = stream;
  await els.video.play().catch(() => {});
  if (!els.video.videoWidth) {
    await new Promise((r) => els.video.addEventListener('loadedmetadata', r, { once: true }));
  }

  hideMessage();
  updateStageAspect();
  await refreshCameraList();
  updateControls();
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const all = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'videoinput');
  // Without camera permission, browsers hide the real list and return a
  // single placeholder with an empty deviceId.
  const devices = all.filter((d) => d.deviceId);

  const sel = els.cameraSelect;
  sel.innerHTML = '';
  if (!devices.length) {
    sel.add(new Option(all.length ? 'Allow camera access to see cameras' : 'No cameras found', ''));
    sel.disabled = true;
    return;
  }
  devices.forEach((d, i) => {
    sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId));
  });
  if (state.deviceId && devices.some((d) => d.deviceId === state.deviceId)) {
    sel.value = state.deviceId;
  }
  sel.disabled = devices.length < 2 && !!state.stream;
}

els.cameraSelect.addEventListener('change', () => {
  const id = els.cameraSelect.value;
  if (id && id !== state.deviceId) startCamera(id);
});

els.retryBtn.addEventListener('click', () => startCamera(els.cameraSelect.value || prefs.get('camera', null)));

navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  await refreshCameraList();
  // A camera came back after being unplugged.
  if (!state.stream?.active) startCamera(prefs.get('camera', null));
});

els.video.addEventListener('resize', updateStageAspect);

function isFrontCamera(track) {
  if (track.getSettings().facingMode === 'user') return true;
  const label = track.label || els.cameraSelect.selectedOptions[0]?.text || '';
  if (/\b(back|rear)\b/i.test(label)) return false;
  return /facetime|front|integrated|built-?in|user[- ]facing|webcam/i.test(label);
}

function setMirror(on) {
  state.mirror = on;
  els.mirrorInput.checked = on;
  els.video.classList.toggle('mirrored', on);
}

els.mirrorInput.addEventListener('change', () => {
  setMirror(els.mirrorInput.checked);
  if (state.deviceId) prefs.set('mirror.' + state.deviceId, state.mirror ? '1' : '0');
});


/* ---------- Stage ---------- */

function updateStageAspect() {
  const w = state.width || els.video.videoWidth;
  const h = state.height || els.video.videoHeight;
  if (w && h) els.stage.style.setProperty('--ar', (w / h).toFixed(4));
}

// Draw a source into a w×h target, letterboxed so nothing is cropped,
// optionally flipped left-to-right.
function drawContain(target, source, sw, sh, w, h, mirror = false) {
  target.fillStyle = '#000';
  target.fillRect(0, 0, w, h);
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  target.save();
  if (mirror) {
    target.translate(w, 0);
    target.scale(-1, 1);
  }
  target.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
  target.restore();
}

function showFrame(index) {
  const frame = state.frames[index];
  if (!frame) {
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    return;
  }
  ctx.drawImage(frame.img, 0, 0, state.width, state.height);
}

function render() {
  const n = state.frames.length;
  els.stage.classList.toggle('has-frame', n > 0);
  els.stage.classList.toggle('playing', state.playing);
  els.stage.classList.toggle('recording', !!state.recording);
  els.video.style.opacity = n > 0 && !state.playing ? ghost() : 1;
  renderBadge();

  els.frameCount.textContent = n;
  els.duration.textContent = (n / fps()).toFixed(1) + 's';

  updateControls();
}

function renderBadge() {
  const n = state.frames.length;
  if (state.recording) {
    els.badge.textContent = `● RECORDING  ${state.playIndex + 1} / ${n}`;
  } else if (state.playing) {
    els.badge.textContent = `▶ PLAYING  ${state.playIndex + 1} / ${n}`;
  } else if (n === 0) {
    els.badge.textContent = 'LIVE';
  } else {
    els.badge.textContent = `FRAME ${state.current + 1}`;
  }
}

function updateControls() {
  const n = state.frames.length;
  const live = !!state.stream?.active && els.video.videoWidth > 0;
  const recording = !!state.recording;
  const locked = state.playing || state.exporting || recording;

  els.captureBtn.disabled = !live || locked;
  els.removeBtn.disabled = n === 0 || locked;
  els.playBtn.disabled = n === 0 || state.exporting || recording;
  els.downloadBtn.disabled = n === 0 || locked;
  els.clearBtn.disabled = (n === 0 && !state.audio) || locked;
  els.recordAudioBtn.disabled = !recording && (n === 0 || locked);
  els.removeAudioBtn.disabled = !state.audio || locked;
  els.micSelect.disabled = locked;
  els.fpsInput.disabled = recording || state.exporting;
  els.cameraSelect.disabled = state.exporting || els.cameraSelect.options.length < 2;

  els.playBtn.classList.toggle('is-playing', state.playing && !recording);
  els.playBtn.querySelector('.label').textContent = state.playing && !recording ? 'Stop' : 'Play';

  els.recordAudioBtn.classList.toggle('is-recording', recording);
  els.recordAudioBtn.querySelector('.label').textContent =
    recording ? 'Stop recording' : state.audio ? 'Re-record audio' : 'Record audio';
}

/* ---------- Capture / remove / select ---------- */

async function capture() {
  if (els.captureBtn.disabled || state.busy) return;
  const v = els.video;
  if (!v.videoWidth) return;

  state.busy = true;
  try {
    if (state.frames.length === 0) {
      state.width = v.videoWidth;
      state.height = v.videoHeight;
      els.canvas.width = state.width;
      els.canvas.height = state.height;
      updateStageAspect();
    }

    // Grab the frame straight onto the stage so it appears instantly.
    // Captures are flipped the same way as the live view, so the ghost lines up.
    drawContain(ctx, v, v.videoWidth, v.videoHeight, state.width, state.height, state.mirror);
    els.stage.classList.add('has-frame');
    flash();

    const blob = await new Promise((r) => els.canvas.toBlob(r, 'image/jpeg', 0.92));
    const url = URL.createObjectURL(blob);
    const img = new Image();
    // Wait for load rather than img.decode(), which can stall while the page isn't being painted.
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    // New frames go right after the one in the preview, which then moves to it.
    const frame = { url, img };
    const at = state.current + 1;
    state.frames.splice(at, 0, frame);
    state.current = at;
    renderFilmstrip();
  } finally {
    state.busy = false;
    render();
  }
}

// Removes the frame shown in the preview and selects the one before it.
function removeFrame() {
  if (els.removeBtn.disabled || state.busy) return;
  const i = state.current;
  const frame = state.frames[i];
  if (!frame) return;
  state.frames.splice(i, 1);
  URL.revokeObjectURL(frame.url);

  if (state.frames.length === 0) {
    state.current = -1;
    resetFrameSize();
  } else {
    state.current = Math.max(0, i - 1);
  }
  showFrame(state.current);
  renderFilmstrip();
  render();
}

function selectFrame(index) {
  if (state.busy || state.exporting || state.recording) return;
  if (index < 0 || index >= state.frames.length) return;
  stop();
  state.current = index;
  showFrame(index);
  highlightThumb(index);
  render();
}

function clearAll() {
  if (els.clearBtn.disabled) return;
  const parts = [];
  if (state.frames.length) parts.push(`all ${state.frames.length} frames`);
  if (state.audio) parts.push('the audio');
  if (!confirm(`Delete ${parts.join(' and ')} and start over?`)) return;
  state.frames.forEach((f) => URL.revokeObjectURL(f.url));
  state.frames = [];
  state.current = -1;
  setAudio(null);
  renderFilmstrip();
  resetFrameSize();
  render();
}

function resetFrameSize() {
  // With no frames, the next capture can adopt the current camera's resolution.
  state.width = 0;
  state.height = 0;
  updateStageAspect();
}

function flash() {
  els.flash.classList.remove('on');
  void els.flash.offsetWidth;
  els.flash.classList.add('on');
}

/* ---------- Filmstrip ---------- */

function renderFilmstrip() {
  els.filmstrip.querySelectorAll('.thumb').forEach((t) => t.remove());
  state.frames.forEach((frame, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb';
    btn.dataset.index = i;
    btn.title = `Frame ${i + 1}`;
    const img = document.createElement('img');
    img.src = frame.url;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = i + 1;
    btn.append(img, label);
    els.filmstrip.append(btn);
  });
  const empty = els.filmstrip.querySelector('.empty');
  if (empty) empty.hidden = state.frames.length > 0;
  highlightThumb(state.current);
}

function highlightThumb(index) {
  els.filmstrip.querySelectorAll('.thumb').forEach((t, i) => {
    const on = i === index;
    t.classList.toggle('active', on);
    if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

els.filmstrip.addEventListener('click', (e) => {
  const thumb = e.target.closest('.thumb');
  if (thumb) selectFrame(Number(thumb.dataset.index));
});

/* ---------- Playback ---------- */

// Plays from the first frame. With loop off, stops after the last frame
// has had its full time on screen and calls onEnd.
function play({ loop = true, withAudio = true, onEnd = null } = {}) {
  if (!state.frames.length || state.exporting) return;
  state.playing = true;
  state.playIndex = 0;
  state.playOnEnd = onEnd;
  showFrame(0);
  highlightThumb(0);
  if (withAudio) startAudio();
  render();

  // The frame is worked out from elapsed time, so the pictures stay in step
  // with the soundtrack even if some animation frames are skipped.
  let start = performance.now();
  const tick = (now) => {
    const interval = 1000 / fps();
    const n = state.frames.length;
    const length = n * interval;
    if (now - start >= length) {
      if (!loop) {
        stop();
        return;
      }
      // Start the next loop on schedule, or from now after a long stall.
      start = now - start < length + interval ? start + length : now;
      if (withAudio) startAudio();
    }
    const index = Math.min(n - 1, Math.floor((now - start) / interval));
    if (index !== state.playIndex) {
      state.playIndex = index;
      showFrame(index);
      highlightThumb(index);
      renderBadge();
    }
    state.playHandle = requestAnimationFrame(tick);
  };
  state.playHandle = requestAnimationFrame(tick);
}

function stop() {
  if (!state.playing) return;
  cancelAnimationFrame(state.playHandle);
  stopAudio();
  state.playing = false;
  showFrame(state.current);
  highlightThumb(state.current);
  render();
  const onEnd = state.playOnEnd;
  state.playOnEnd = null;
  onEnd?.();
}

function togglePlay() {
  if (els.playBtn.disabled) return;
  state.playing ? stop() : play();
}

/* ---------- Audio ---------- */

let audioContext = null;
function audioCtx() {
  audioContext ??= new AudioContext();
  audioContext.resume();
  return audioContext;
}

// The soundtrack plays through a media element so it can be sped up or slowed
// down to fit the current frame rate without changing its pitch. It is wired
// into Web Audio so the download can record it too.
const player = new Audio();
player.preservesPitch = player.mozPreservesPitch = player.webkitPreservesPitch = true;
let playerNodes = null;

function playerOutput() {
  if (!playerNodes) {
    const ac = audioCtx();
    const source = ac.createMediaElementSource(player);
    const speakers = ac.createGain();
    source.connect(speakers).connect(ac.destination);
    playerNodes = { source, speakers };
  }
  return playerNodes;
}

// Stretches the recording so it lasts as long as the animation does now.
function audioRate() {
  return Math.min(16, Math.max(0.0625, fps() / state.audio.fps));
}

// The soundtrack always starts with the first frame.
function startAudio({ toSpeakers = true } = {}) {
  if (!state.audio) return Promise.resolve();
  playerOutput().speakers.gain.value = toSpeakers ? 1 : 0;
  if (player.src !== state.audio.url) player.src = state.audio.url;
  player.defaultPlaybackRate = player.playbackRate = audioRate();
  player.currentTime = 0;
  return player.play().catch(() => {});
}

function stopAudio() {
  player.pause();
}

function setAudio(audio) {
  stopAudio();
  if (state.audio) URL.revokeObjectURL(state.audio.url);
  state.audio = audio;
}

async function refreshMicList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const mics = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput' && d.deviceId &&
      d.deviceId !== 'default' && d.deviceId !== 'communications');
  const sel = els.micSelect;
  const wanted = sel.value || prefs.get('mic', '');
  sel.innerHTML = '';
  sel.add(new Option('Default microphone', ''));
  mics.forEach((d, i) => sel.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  sel.value = mics.some((d) => d.deviceId === wanted) ? wanted : '';
}

els.micSelect.addEventListener('change', () => prefs.set('mic', els.micSelect.value));

async function openMic() {
  const id = els.micSelect.value;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
  } catch (err) {
    if (id && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      els.micSelect.value = '';
      return openMic();
    }
    throw err;
  }
}

async function toggleRecordAudio() {
  if (state.recording) {
    stopRecording();
    return;
  }
  if (els.recordAudioBtn.disabled) return;
  if (typeof MediaRecorder === 'undefined') {
    alert('Sorry, this browser can’t record audio.');
    return;
  }
  stop();

  let mic;
  try {
    mic = await openMic();
  } catch (err) {
    alert(err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow microphone access for this page in your browser’s site settings, then try again.'
      : `Couldn’t start the microphone: ${err.message || err.name}`);
    return;
  }
  refreshMicList();

  const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
    .find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(mic, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    mic.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType });
    try {
      // Check the recording is playable before replacing the old one.
      await audioCtx().decodeAudioData(await blob.arrayBuffer());
      setAudio({ blob, url: URL.createObjectURL(blob), fps: recordedFps });
    } catch {
      alert('Couldn’t read the recorded audio. Please try recording again.');
    }
    render();
  };

  // The speed slider is locked while recording, so this is the recording's speed.
  const recordedFps = fps();
  // Backup for the end of the pass, in case the tab is hidden and playback pauses.
  const length = (state.frames.length / recordedFps) * 1000;
  state.recording = { recorder, timer: setTimeout(stopRecording, length + 100) };
  recorder.start();
  play({ loop: false, withAudio: false, onEnd: stopRecording });
}

function stopRecording() {
  const rec = state.recording;
  if (!rec) return;
  clearTimeout(rec.timer);
  state.recording = null;
  stop();
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  render();
}

function removeAudio() {
  if (els.removeAudioBtn.disabled) return;
  if (!confirm('Remove the recorded audio?')) return;
  setAudio(null);
  render();
}

/* ---------- Export ---------- */

function pickMimeType(withAudio) {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = withAudio ? [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/mp4',
    'video/webm',
  ] : [
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function download() {
  if (els.downloadBtn.disabled) return;
  const mimeType = pickMimeType(!!state.audio);
  if (!mimeType) {
    alert('Sorry, this browser can’t record video. Try a recent Chrome, Edge, Firefox or Safari.');
    return;
  }

  state.exporting = true;
  render();
  const label = els.downloadBtn.querySelector('.label');

  // H.264 needs even dimensions.
  const w = state.width - (state.width % 2);
  const h = state.height - (state.height % 2);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  const draw = (i) => octx.drawImage(state.frames[i].img, 0, 0, w, h);

  const rate = fps();
  const interval = 1000 / rate;
  draw(0);

  let canvasStream = out.captureStream(0);
  let track = canvasStream.getVideoTracks()[0];
  const manual = typeof track.requestFrame === 'function';
  if (!manual) {
    track.stop();
    canvasStream = out.captureStream(rate);
    track = canvasStream.getVideoTracks()[0];
  }

  // Route the soundtrack into the recording (silently, not to the speakers).
  let audioDest = null;
  let audioTrack = null;
  if (state.audio) {
    audioDest = audioCtx().createMediaStreamDestination();
    playerOutput().source.connect(audioDest);
    audioTrack = audioDest.stream.getAudioTracks()[0];
  }
  const stream = new MediaStream(audioTrack ? [track, audioTrack] : [track]);

  try {
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.round(w * h * rate * 0.25),
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { recorder.onstop = r; });

    // MediaRecorder works in real time, so frames are pushed on the clock.
    recorder.start();
    await startAudio({ toSpeakers: false });
    const start = performance.now();
    const n = state.frames.length;
    for (let i = 0; i < n; i++) {
      draw(i);
      if (manual) track.requestFrame();
      label.textContent = `Exporting ${Math.round(((i + 1) / n) * 100)}%`;
      await sleep(start + (i + 1) * interval - performance.now());
    }
    // Re-send the final frame so it is held for its full duration.
    draw(n - 1);
    if (manual) track.requestFrame();
    await sleep(50);
    recorder.stop();
    await stopped;

    const type = recorder.mimeType || mimeType;
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stop-motion-${stamp}.${ext}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    alert(`Export failed: ${err.message || err}`);
  } finally {
    stopAudio();
    if (audioDest) playerOutput().source.disconnect(audioDest);
    track.stop();
    audioTrack?.stop();
    label.textContent = 'Download';
    state.exporting = false;
    render();
  }
}

/* ---------- Wiring ---------- */

els.captureBtn.addEventListener('click', capture);
els.removeBtn.addEventListener('click', removeFrame);
els.playBtn.addEventListener('click', togglePlay);
els.downloadBtn.addEventListener('click', download);
els.clearBtn.addEventListener('click', clearAll);
els.recordAudioBtn.addEventListener('click', toggleRecordAudio);
els.removeAudioBtn.addEventListener('click', removeAudio);

els.fpsInput.addEventListener('input', () => {
  els.fpsOut.textContent = els.fpsInput.value;
  prefs.set('frameRate', els.fpsInput.value);
  if (state.audio) player.playbackRate = audioRate();
  render();
});

els.ghostInput.addEventListener('input', () => {
  els.ghostOut.textContent = els.ghostInput.value;
  prefs.set('ghostAmount', els.ghostInput.value);
  render();
});

const isTextField = (el) =>
  el && (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el.type)));

window.addEventListener('keydown', (e) => {
  if (isTextField(e.target) || e.altKey) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (e.code === 'Space' && !mod) {
    e.preventDefault(); // also stops a focused button from being clicked
    if (!e.repeat) capture();
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && !mod) {
    e.preventDefault();
    removeFrame();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    const from = state.current < 0 ? 0 : state.current;
    selectFrame(from + (e.key === 'ArrowLeft' ? -1 : 1));
  } else if (key === 'p' && !mod) {
    togglePlay();
  } else if (key === 'r' && !mod && !e.repeat) {
    toggleRecordAudio();
  } else if (e.key === 'Escape') {
    state.recording ? stopRecording() : stop();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !isTextField(e.target)) e.preventDefault();
});

window.addEventListener('beforeunload', (e) => {
  if (state.frames.length || state.audio) {
    e.preventDefault();
    e.returnValue = '';
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', refreshMicList);

els.fpsOut.textContent = els.fpsInput.value;
els.ghostOut.textContent = els.ghostInput.value;
render();
refreshMicList();
startCamera(prefs.get('camera', null));
