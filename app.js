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
  captureBtn: $('captureBtn'),
  undoBtn: $('undoBtn'),
  playBtn: $('playBtn'),
  downloadBtn: $('downloadBtn'),
  clearBtn: $('clearBtn'),
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
  frames: [],          // { url, img }
  width: 0,            // output frame size, fixed by the first captured frame
  height: 0,
  busy: false,         // a capture is being encoded
  playing: false,
  playHandle: 0,
  playIndex: 0,
  exporting: false,
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
els.ghostInput.value = prefs.get('liveGhost', '25');

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

/* ---------- Stage ---------- */

function updateStageAspect() {
  const w = state.width || els.video.videoWidth;
  const h = state.height || els.video.videoHeight;
  if (w && h) els.stage.style.setProperty('--ar', (w / h).toFixed(4));
}

// Draw a source into a w×h target, letterboxed so nothing is cropped.
function drawContain(target, source, sw, sh, w, h) {
  target.fillStyle = '#000';
  target.fillRect(0, 0, w, h);
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  target.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
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
  els.video.style.opacity = n > 0 && !state.playing ? ghost() : 1;

  if (state.playing) {
    els.badge.textContent = `▶ PLAYING  ${state.playIndex + 1} / ${n}`;
  } else if (n === 0) {
    els.badge.textContent = 'LIVE';
  } else {
    els.badge.textContent = `FRAME ${n}`;
  }

  els.frameCount.textContent = n;
  els.duration.textContent = (n / fps()).toFixed(1) + 's';
  updateControls();
}

function updateControls() {
  const n = state.frames.length;
  const live = !!state.stream?.active && els.video.videoWidth > 0;
  const locked = state.playing || state.exporting;

  els.captureBtn.disabled = !live || locked;
  els.undoBtn.disabled = n === 0 || locked;
  els.playBtn.disabled = n === 0 || state.exporting;
  els.downloadBtn.disabled = n === 0 || locked;
  els.clearBtn.disabled = n === 0 || locked;
  els.cameraSelect.disabled = state.exporting || els.cameraSelect.options.length < 2;

  els.playBtn.classList.toggle('is-playing', state.playing);
  els.playBtn.querySelector('.label').textContent = state.playing ? 'Stop' : 'Play';
}

/* ---------- Capture / undo ---------- */

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
    drawContain(ctx, v, v.videoWidth, v.videoHeight, state.width, state.height);
    els.stage.classList.add('has-frame');
    flash();

    const blob = await new Promise((r) => els.canvas.toBlob(r, 'image/jpeg', 0.92));
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();

    state.frames.push({ url, img });
    addThumb(state.frames.length - 1);
  } finally {
    state.busy = false;
    render();
  }
}

function undo() {
  if (els.undoBtn.disabled || state.busy) return;
  const frame = state.frames.pop();
  if (!frame) return;
  URL.revokeObjectURL(frame.url);
  els.filmstrip.lastElementChild?.remove();
  if (state.frames.length === 0) resetFrameSize();
  showFrame(state.frames.length - 1);
  markLastThumb();
  render();
}

function clearAll() {
  if (els.clearBtn.disabled) return;
  if (!confirm(`Delete all ${state.frames.length} frames and start over?`)) return;
  state.frames.forEach((f) => URL.revokeObjectURL(f.url));
  state.frames = [];
  els.filmstrip.querySelectorAll('.thumb').forEach((t) => t.remove());
  resetFrameSize();
  render();
}

function resetFrameSize() {
  // With no frames, the next capture can adopt the current camera's resolution.
  state.width = 0;
  state.height = 0;
  updateStageAspect();
  updateEmptyHint();
}

function flash() {
  els.flash.classList.remove('on');
  void els.flash.offsetWidth;
  els.flash.classList.add('on');
}

/* ---------- Filmstrip ---------- */

function addThumb(index) {
  const div = document.createElement('div');
  div.className = 'thumb';
  const img = document.createElement('img');
  img.src = state.frames[index].url;
  img.alt = `Frame ${index + 1}`;
  const label = document.createElement('span');
  label.textContent = index + 1;
  div.append(img, label);
  els.filmstrip.append(div);
  updateEmptyHint();
  markLastThumb();
  els.filmstrip.scrollLeft = els.filmstrip.scrollWidth;
}

function markLastThumb() {
  const thumbs = els.filmstrip.querySelectorAll('.thumb');
  thumbs.forEach((t, i) => t.classList.toggle('last', i === thumbs.length - 1));
}

function markCurrentThumb(index) {
  els.filmstrip.querySelectorAll('.thumb').forEach((t, i) => {
    const on = i === index;
    t.classList.toggle('current', on);
    if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function updateEmptyHint() {
  const empty = els.filmstrip.querySelector('.empty');
  if (empty) empty.hidden = state.frames.length > 0;
}

/* ---------- Playback ---------- */

function play() {
  if (!state.frames.length || state.exporting) return;
  state.playing = true;
  state.playIndex = 0;
  showFrame(0);
  markCurrentThumb(0);
  render();

  let last = performance.now();
  const tick = (now) => {
    const interval = 1000 / fps();
    if (now - last >= interval) {
      // Keep cadence steady, but don't try to catch up after a long stall.
      last = now - last > interval * 2 ? now : last + interval;
      state.playIndex = (state.playIndex + 1) % state.frames.length;
      showFrame(state.playIndex);
      markCurrentThumb(state.playIndex);
      render();
    }
    state.playHandle = requestAnimationFrame(tick);
  };
  state.playHandle = requestAnimationFrame(tick);
}

function stop() {
  if (!state.playing) return;
  cancelAnimationFrame(state.playHandle);
  state.playing = false;
  markCurrentThumb(-1);
  showFrame(state.frames.length - 1);
  render();
}

function togglePlay() {
  if (els.playBtn.disabled) return;
  state.playing ? stop() : play();
}

/* ---------- Export ---------- */

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
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
  const mimeType = pickMimeType();
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

  let stream = out.captureStream(0);
  let track = stream.getVideoTracks()[0];
  const manual = typeof track.requestFrame === 'function';
  if (!manual) {
    track.stop();
    stream = out.captureStream(rate);
    track = stream.getVideoTracks()[0];
  }

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
    track.stop();
    label.textContent = 'Download';
    state.exporting = false;
    render();
  }
}

/* ---------- Wiring ---------- */

els.captureBtn.addEventListener('click', capture);
els.undoBtn.addEventListener('click', undo);
els.playBtn.addEventListener('click', togglePlay);
els.downloadBtn.addEventListener('click', download);
els.clearBtn.addEventListener('click', clearAll);

els.fpsInput.addEventListener('input', () => {
  els.fpsOut.textContent = els.fpsInput.value;
  prefs.set('frameRate', els.fpsInput.value);
  render();
});

els.ghostInput.addEventListener('input', () => {
  els.ghostOut.textContent = els.ghostInput.value;
  prefs.set('liveGhost', els.ghostInput.value);
  render();
});

const isTextField = (el) =>
  el && (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el.type)));

window.addEventListener('keydown', (e) => {
  if (isTextField(e.target) || e.altKey) return;
  const mod = e.metaKey || e.ctrlKey;

  if (e.code === 'Space' && !mod) {
    e.preventDefault(); // also stops a focused button from being clicked
    if (!e.repeat) capture();
  } else if ((e.key === 'Backspace' && !mod) || (mod && e.key.toLowerCase() === 'z' && !e.shiftKey)) {
    e.preventDefault();
    undo();
  } else if (e.key.toLowerCase() === 'p' && !mod) {
    togglePlay();
  } else if (e.key === 'Escape') {
    stop();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !isTextField(e.target)) e.preventDefault();
});

window.addEventListener('beforeunload', (e) => {
  if (state.frames.length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

els.fpsOut.textContent = els.fpsInput.value;
els.ghostOut.textContent = els.ghostInput.value;
render();
startCamera(prefs.get('camera', null));
