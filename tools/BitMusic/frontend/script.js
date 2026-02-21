const AudioContext = window.AudioContext || window.webkitAudioContext;
let ctx = null;

let masterGain;
let gains = { vocals: null, drums: null, bass: null, other: null };
let analysers = { vocals: null, drums: null, bass: null, other: null };
let sources = { vocals: null, drums: null, bass: null, other: null };
let buffers = { vocals: null, drums: null, bass: null, other: null };
let analyserData = { vocals: null, drums: null, bass: null, other: null };

let currentAlbum = null;
let currentTrackIndex = 0;
let lyrics = [];
let isPlaying = false;
let startOffset = 0;
let startTime = 0;
let animationFrameId = null;
let duration = 0;

// Preload buffer for gapless playback
let preloadedBuffers = null;
let preloadedIndex = -1;

// Audio analysis state (EMA smoothed, matching Bit-Karaoke)
const FFT_SIZE = 1024;
const SMOOTHING_FACTOR = 0.3;
const PEAK_THRESHOLD = 0.6;
const PEAK_DECAY = 0.95;

const stemAnalysis = {
  drums:  { rms: 0, low: 0, mid: 0, high: 0, peakDecay: 0, peakValue: 0, lowEnd: 0, midEnd: 0 },
  bass:   { rms: 0, low: 0, mid: 0, high: 0, peakDecay: 0, peakValue: 0, lowEnd: 0, midEnd: 0 },
  other:  { rms: 0, low: 0, mid: 0, high: 0, peakDecay: 0, peakValue: 0, lowEnd: 0, midEnd: 0 },
  vocals: { rms: 0, low: 0, mid: 0, high: 0, peakDecay: 0, peakValue: 0, lowEnd: 0, midEnd: 0 },
};

const trackListEl = document.getElementById('track-list');
const playBtn = document.getElementById('play-btn');
const playBtnIcon = playBtn.querySelector('i');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npImg = document.getElementById('np-img');
const progressFill = document.querySelector('.progress-fill');
const timeCurrent = document.querySelector('.time-current');
const timeTotal = document.querySelector('.time-total');
const progressBar = document.querySelector('.progress-bar');

const btnLoadBm = document.getElementById('btn-load-bm');
const bmFileInput = document.getElementById('bm-file-input');
const mixerPanel = document.getElementById('mixer-panel');

const karaokeView = document.getElementById('karaoke-view');
const lyricsPrev = document.getElementById('lyrics-prev');
const lyricsCurrent = document.getElementById('lyrics-current');
const lyricsNext = document.getElementById('lyrics-next');
const lyricsNext2 = document.getElementById('lyrics-next2');
const canvas = document.getElementById('karaoke-canvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

let shaderProgram = null;
let quadBuffer = null;
let positionLocation = -1;
let uniforms = {};
let visualizerStartTime = 0;

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_masterIntensity;

uniform vec4 u_drums;
uniform vec4 u_bass;
uniform vec4 u_other;
uniform vec4 u_vocals;

uniform float u_drumsPeak;
uniform float u_bassPeak;

#define PI 3.14159265359

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m * m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float softBlob(vec2 uv, vec2 center, float radius) {
  float d = length(uv - center);
  return exp(-d * d / (radius * radius));
}

vec2 blobPosition(float time, float seed, float speed, float range) {
  float x = snoise(vec2(time * speed + seed, seed * 2.0)) * range;
  float y = snoise(vec2(seed * 3.0, time * speed + seed)) * range;
  return vec2(x, y);
}

void main() {
  vec2 uv = v_uv;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = uv - 0.5;
  p.x *= aspect;
  float t = u_time;
  float radius = length(p);
  float totalIntensity = u_drums.x + u_bass.x + u_other.x + u_vocals.x;

  if (totalIntensity < 0.001) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 drumsColor = vec3(0.13, 0.87, 0.4);
  vec3 bassColor = vec3(0.27, 0.8, 1.0);
  vec3 otherColor = vec3(0.67, 0.33, 1.0);
  vec3 vocalsColor = vec3(1.0, 0.73, 0.2);

  float circleRadius = 0.42;
  float edgeFade = smoothstep(circleRadius + 0.08, circleRadius - 0.15, radius);

  vec3 finalColor = vec3(0.0);
  float totalGlow = 0.0;

  if (u_drums.x > 0.01) {
    float intensity = u_drums.x;
    float blobSize = 0.12 + intensity * 0.08;
    vec2 pos1 = vec2(-0.15, -0.1) + blobPosition(t, 1.0, 0.3, 0.12) * (0.5 + intensity);
    float b1 = softBlob(p, pos1, blobSize * 1.2);
    vec2 pos2 = vec2(0.18, 0.15) + blobPosition(t, 1.5, 0.25, 0.1) * (0.5 + intensity);
    float b2 = softBlob(p, pos2, blobSize * 0.9);
    vec2 pos3 = vec2(-0.08, 0.2) + blobPosition(t, 1.8, 0.35, 0.08) * (0.5 + intensity);
    float b3 = softBlob(p, pos3, blobSize * 0.7);
    float drumsGlow = (b1 + b2 * 0.8 + b3 * 0.6) * intensity;
    drumsGlow *= 1.0 + u_drumsPeak * 0.5;
    finalColor += drumsColor * drumsGlow * 1.2;
    totalGlow += drumsGlow;
  }

  if (u_bass.x > 0.01) {
    float intensity = u_bass.x;
    float blobSize = 0.15 + intensity * 0.1;
    vec2 pos1 = vec2(0.0, -0.12) + blobPosition(t, 2.0, 0.15, 0.15) * (0.4 + intensity);
    float b1 = softBlob(p, pos1, blobSize * 1.4);
    vec2 pos2 = vec2(-0.2, 0.08) + blobPosition(t, 2.3, 0.12, 0.12) * (0.4 + intensity);
    float b2 = softBlob(p, pos2, blobSize);
    vec2 pos3 = vec2(0.15, 0.1) + blobPosition(t, 2.6, 0.18, 0.1) * (0.4 + intensity);
    float b3 = softBlob(p, pos3, blobSize * 0.85);
    float bassGlow = (b1 + b2 * 0.9 + b3 * 0.7) * intensity;
    bassGlow *= 1.0 + u_bassPeak * 0.4;
    finalColor += bassColor * bassGlow * 1.1;
    totalGlow += bassGlow;
  }

  if (u_other.x > 0.01) {
    float intensity = u_other.x;
    float blobSize = 0.11 + intensity * 0.07;
    vec2 pos1 = vec2(0.12, -0.15) + blobPosition(t, 3.0, 0.28, 0.11) * (0.5 + intensity);
    float b1 = softBlob(p, pos1, blobSize * 1.1);
    vec2 pos2 = vec2(-0.18, -0.05) + blobPosition(t, 3.4, 0.22, 0.09) * (0.5 + intensity);
    float b2 = softBlob(p, pos2, blobSize * 0.9);
    vec2 pos3 = vec2(0.05, 0.18) + blobPosition(t, 3.7, 0.3, 0.1) * (0.5 + intensity);
    float b3 = softBlob(p, pos3, blobSize * 0.75);
    float otherGlow = (b1 + b2 * 0.85 + b3 * 0.65) * intensity;
    finalColor += otherColor * otherGlow * 1.15;
    totalGlow += otherGlow;
  }

  if (u_vocals.x > 0.01) {
    float intensity = u_vocals.x;
    float blobSize = 0.13 + intensity * 0.08;
    vec2 pos1 = vec2(0.0, 0.05) + blobPosition(t, 4.0, 0.2, 0.1) * (0.4 + intensity);
    float b1 = softBlob(p, pos1, blobSize * 1.3);
    vec2 pos2 = vec2(-0.12, -0.18) + blobPosition(t, 4.3, 0.25, 0.12) * (0.5 + intensity);
    float b2 = softBlob(p, pos2, blobSize * 0.95);
    vec2 pos3 = vec2(0.2, 0.0) + blobPosition(t, 4.6, 0.18, 0.08) * (0.5 + intensity);
    float b3 = softBlob(p, pos3, blobSize * 0.8);
    float vocalsGlow = (b1 + b2 * 0.8 + b3 * 0.65) * intensity;
    finalColor += vocalsColor * vocalsGlow * 1.2;
    totalGlow += vocalsGlow;
  }

  float maxComponent = max(max(finalColor.r, finalColor.g), finalColor.b);
  if (maxComponent > 1.0) {
    finalColor = finalColor / maxComponent * 0.95 + finalColor * 0.05;
  }

  float ambientGlow = totalGlow * 0.15;
  vec3 ambientColor = (drumsColor * u_drums.x + bassColor * u_bass.x +
                       otherColor * u_other.x + vocalsColor * u_vocals.x) /
                       max(totalIntensity, 0.001);
  finalColor += ambientColor * ambientGlow * 0.3;

  float masterBoost = 0.7 + u_masterIntensity * 0.6;
  finalColor *= masterBoost;
  finalColor *= edgeFade;

  float innerGlow = 1.0 - pow(radius * 1.5, 2.5) * 0.2;
  finalColor *= max(innerGlow, 0.5);

  vec3 gray = vec3(dot(finalColor, vec3(0.299, 0.587, 0.114)));
  finalColor = mix(gray, finalColor, 1.3);

  float dither = (fract(sin(dot(uv * u_resolution, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 128.0;
  finalColor += dither;

  fragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}`;

const sliders = {
  master: document.getElementById('vol-master'),
  vocals: document.getElementById('vol-vocals'),
  drums: document.getElementById('vol-drums'),
  bass: document.getElementById('vol-bass'),
  other: document.getElementById('vol-other')
};

// --- Audio Initialization ---

async function initAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);
    masterGain.gain.value = sliders.master.value;

    const sampleRate = ctx.sampleRate;
    const binSize = sampleRate / FFT_SIZE;
    const lowEnd = Math.floor(250 / binSize);
    const midEnd = Math.floor(2000 / binSize);

    ['vocals', 'drums', 'bass', 'other'].forEach(stem => {
      gains[stem] = ctx.createGain();
      gains[stem].connect(masterGain);
      gains[stem].gain.value = sliders[stem].value;

      analysers[stem] = ctx.createAnalyser();
      analysers[stem].fftSize = FFT_SIZE;
      analysers[stem].smoothingTimeConstant = 0.4;
      analyserData[stem] = new Uint8Array(analysers[stem].frequencyBinCount);

      stemAnalysis[stem].lowEnd = lowEnd;
      stemAnalysis[stem].midEnd = midEnd;
    });
  }
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
}

// --- FFT-based audio analysis (matching Bit-Karaoke) ---

function getAnalysedFeatures(stemName) {
  const analyser = analysers[stemName];
  const data = analyserData[stemName];
  const state = stemAnalysis[stemName];
  if (!analyser || !data) return { rms: 0, low: 0, mid: 0, high: 0, peak: false, peakValue: 0 };

  analyser.getByteFrequencyData(data);

  let sum = 0, lowSum = 0, midSum = 0, highSum = 0;
  let lowCount = 0, midCount = 0, highCount = 0;
  const len = data.length;

  for (let i = 0; i < len; i++) {
    const v = data[i] / 255;
    sum += v * v;
    if (i < state.lowEnd) { lowSum += v; lowCount++; }
    else if (i < state.midEnd) { midSum += v; midCount++; }
    else { highSum += v; highCount++; }
  }

  const rms = Math.sqrt(sum / len);
  const low = lowCount > 0 ? lowSum / lowCount : 0;
  const mid = midCount > 0 ? midSum / midCount : 0;
  const high = highCount > 0 ? highSum / highCount : 0;

  state.rms = state.rms * (1 - SMOOTHING_FACTOR) + rms * SMOOTHING_FACTOR;
  state.low = state.low * (1 - SMOOTHING_FACTOR) + low * SMOOTHING_FACTOR;
  state.mid = state.mid * (1 - SMOOTHING_FACTOR) + mid * SMOOTHING_FACTOR;
  state.high = state.high * (1 - SMOOTHING_FACTOR) + high * SMOOTHING_FACTOR;

  state.peakDecay *= PEAK_DECAY;
  const peak = rms > state.peakDecay && rms > PEAK_THRESHOLD;
  if (peak) {
    state.peakDecay = rms;
    state.peakValue = rms;
  }

  return {
    rms: state.rms,
    low: state.low,
    mid: state.mid,
    high: state.high,
    peak,
    peakValue: state.peakValue,
  };
}

// --- Event Listeners ---

function setupEventListeners() {
  btnLoadBm.addEventListener('click', () => bmFileInput.click());
  bmFileInput.addEventListener('change', handleBmUpload);
  playBtn.addEventListener('click', togglePlay);

  document.querySelector('.ph-skip-forward').parentElement.addEventListener('click', () => {
    if (currentAlbum && currentAlbum.tracks.length > 0) {
      playTrack((currentTrackIndex + 1) % currentAlbum.tracks.length);
    }
  });

  document.querySelector('.ph-skip-back').parentElement.addEventListener('click', () => {
    if (currentAlbum && currentAlbum.tracks.length > 0) {
      playTrack((currentTrackIndex - 1 + currentAlbum.tracks.length) % currentAlbum.tracks.length);
    }
  });

  progressBar.addEventListener('click', (e) => {
    if (!duration) return;
    const rect = progressBar.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(percent * duration);
  });

  const btnEnterKaraoke = document.getElementById('btn-enter-karaoke');
  const btnExitKaraoke = document.getElementById('btn-exit-karaoke');
  const btnToggleMixer = document.getElementById('btn-toggle-karaoke-mixer');

  if (btnEnterKaraoke) btnEnterKaraoke.addEventListener('click', toggleKaraokeMode);
  if (btnExitKaraoke) btnExitKaraoke.addEventListener('click', toggleKaraokeMode);
  if (btnToggleMixer) {
    btnToggleMixer.addEventListener('click', () => mixerPanel.classList.toggle('open'));
  }

  const btnCloseMixer = document.getElementById('btn-close-mixer');
  if (btnCloseMixer) {
    btnCloseMixer.addEventListener('click', () => mixerPanel.classList.remove('open'));
  }

  Object.keys(sliders).forEach(key => {
    sliders[key].addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (key === 'master') {
        if (masterGain) masterGain.gain.setTargetAtTime(val, ctx.currentTime, 0.05);
      } else {
        if (gains[key]) gains[key].gain.setTargetAtTime(val, ctx.currentTime, 0.05);
      }
    });
  });

  window.addEventListener('resize', resizeCanvas);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
  });
}

// --- .bm Loading ---

async function handleBmUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const zip = await JSZip.loadAsync(file);
    const manifestFile = zip.file('bm.json');
    if (!manifestFile) throw new Error('Invalid .bm file: missing bm.json');
    const manifest = JSON.parse(await manifestFile.async('string'));

    let coverUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='%23111'%3E%3Crect width='100' height='100'/%3E%3C/svg%3E";
    if (manifest.cover && zip.file(manifest.cover)) {
      const coverBlob = await zip.file(manifest.cover).async('blob');
      coverUrl = URL.createObjectURL(coverBlob);
    }

    currentAlbum = { ...manifest, coverUrl, zipRef: zip };
    renderTrackList();
    if (currentAlbum.tracks.length > 0) {
      playTrack(0, false);
    }
  } catch (err) {
    console.error('Error loading BM:', err);
    alert('Could not load .bm file: ' + err.message);
  }
}

function renderTrackList() {
  trackListEl.innerHTML = '';
  currentAlbum.tracks.forEach((track, index) => {
    const li = document.createElement('li');
    li.className = 'track-item';
    li.dataset.index = index;

    const durSecs = (track.duration_ms / 1000) || 0;
    const mins = Math.floor(durSecs / 60);
    const secs = Math.floor(durSecs % 60).toString().padStart(2, '0');

    li.innerHTML = `
      <div class="col-num">${index + 1}</div>
      <div class="col-title track-title-container">
        <img src="${currentAlbum.coverUrl}" class="track-img" alt="Cover">
        <div class="track-info">
          <div class="track-title">${track.title || 'Unknown Title'}</div>
          <div class="track-artist">${track.artist || currentAlbum.album_artist || 'Unknown Artist'}</div>
        </div>
      </div>
      <div class="col-album">${currentAlbum.title || 'Unknown Album'}</div>
      <div class="col-time">${mins}:${secs}</div>
    `;

    li.addEventListener('click', () => playTrack(index, true));
    trackListEl.appendChild(li);
  });
}

// --- Preloading for gapless playback ---

async function preloadNextTrack() {
  if (!currentAlbum) return;
  const nextIndex = currentTrackIndex + 1;
  if (nextIndex >= currentAlbum.tracks.length) return;
  if (preloadedIndex === nextIndex) return;

  const track = currentAlbum.tracks[nextIndex];
  if (!track.stems) return;

  await initAudio();

  const nextBuffers = { vocals: null, drums: null, bass: null, other: null };
  const stemsToLoad = ['vocals', 'drums', 'bass', 'other'];

  const loadPromises = stemsToLoad.map(async (stem) => {
    const stemPath = track.stems[stem];
    if (stemPath && currentAlbum.zipRef.file(stemPath)) {
      const arrayBuffer = await currentAlbum.zipRef.file(stemPath).async('arraybuffer');
      nextBuffers[stem] = await ctx.decodeAudioData(arrayBuffer);
    }
  });

  await Promise.all(loadPromises);
  preloadedBuffers = nextBuffers;
  preloadedIndex = nextIndex;
}

// --- Playback ---

async function playTrack(index, autoPlay = true) {
  stopSources();
  cancelAnimationFrame(animationFrameId);

  currentTrackIndex = index;
  const track = currentAlbum.tracks[index];

  document.querySelectorAll('.track-item').forEach(el => el.classList.remove('playing'));
  const row = trackListEl.querySelector(`[data-index="${index}"]`);
  if (row) row.classList.add('playing');

  npTitle.textContent = track.title || 'Unknown';
  npArtist.textContent = track.artist || currentAlbum.album_artist || '-';
  npImg.src = currentAlbum.coverUrl;

  await initAudio();

  lyrics = [];
  if (track.lrc_path && currentAlbum.zipRef.file(track.lrc_path)) {
    const lrcText = await currentAlbum.zipRef.file(track.lrc_path).async('string');
    parseLrc(lrcText);
  }
  updateLyricsDisplay(-1);

  duration = 0;

  if (preloadedIndex === index && preloadedBuffers) {
    buffers = preloadedBuffers;
    preloadedBuffers = null;
    preloadedIndex = -1;
    ['vocals', 'drums', 'bass', 'other'].forEach(stem => {
      if (buffers[stem]) duration = Math.max(duration, buffers[stem].duration);
    });
  } else {
    if (!track.stems) { console.warn('Track missing stems'); return; }

    const stemsToLoad = ['vocals', 'drums', 'bass', 'other'];
    const loadPromises = stemsToLoad.map(async (stem) => {
      const stemPath = track.stems[stem];
      if (stemPath && currentAlbum.zipRef.file(stemPath)) {
        const arrayBuffer = await currentAlbum.zipRef.file(stemPath).async('arraybuffer');
        buffers[stem] = await ctx.decodeAudioData(arrayBuffer);
        duration = Math.max(duration, buffers[stem].duration);
      } else {
        buffers[stem] = null;
      }
    });
    await Promise.all(loadPromises);
  }

  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60).toString().padStart(2, '0');
  timeTotal.textContent = `${mins}:${secs}`;
  startOffset = 0;

  if (autoPlay) {
    startPlayback(0);
    preloadNextTrack();
  }
}

function startPlayback(offset) {
  if (!ctx) return;
  stopSources();

  ['vocals', 'drums', 'bass', 'other'].forEach(stem => {
    if (buffers[stem]) {
      sources[stem] = ctx.createBufferSource();
      sources[stem].buffer = buffers[stem];
      sources[stem].connect(analysers[stem]);
      analysers[stem].connect(gains[stem]);
      sources[stem].start(0, offset);
    }
  });

  isPlaying = true;
  startOffset = offset;
  startTime = ctx.currentTime;

  playBtnIcon.classList.remove('ph-play-circle');
  playBtnIcon.classList.add('ph-pause-circle');

  updateLoop();
}

function pausePlayback() {
  stopSources();
  isPlaying = false;
  startOffset += (ctx.currentTime - startTime);
  playBtnIcon.classList.remove('ph-pause-circle');
  playBtnIcon.classList.add('ph-play-circle');
  cancelAnimationFrame(animationFrameId);
}

function stopPlayback() {
  stopSources();
  isPlaying = false;
  startOffset = 0;
  duration = 0;
  progressFill.style.width = '0%';
  timeCurrent.textContent = '0:00';
  playBtnIcon.classList.remove('ph-pause-circle');
  playBtnIcon.classList.add('ph-play-circle');
  cancelAnimationFrame(animationFrameId);
}

function stopSources() {
  ['vocals', 'drums', 'bass', 'other'].forEach(stem => {
    if (sources[stem]) {
      try { sources[stem].stop(); } catch (e) { }
      sources[stem].disconnect();
      sources[stem] = null;
    }
  });
}

function togglePlay() {
  if (!currentAlbum || !buffers.vocals) return;
  if (isPlaying) pausePlayback();
  else startPlayback(startOffset);
}

async function seek(time) {
  if (!currentAlbum) return;
  const wasPlaying = isPlaying;
  if (wasPlaying) pausePlayback();
  startOffset = Math.max(0, Math.min(time, duration));
  if (wasPlaying) {
    await initAudio();
    startPlayback(startOffset);
  } else {
    updateUI(startOffset);
  }
}

// --- Main Update Loop ---

function updateLoop() {
  if (!isPlaying) return;
  const currentPos = startOffset + (ctx.currentTime - startTime);

  if (currentPos >= duration && duration > 0) {
    if (currentAlbum && currentTrackIndex < currentAlbum.tracks.length - 1) {
      playTrack(currentTrackIndex + 1);
    } else {
      stopPlayback();
    }
    return;
  }

  updateUI(currentPos);
  drawVisualizer();
  animationFrameId = requestAnimationFrame(updateLoop);
}

function updateUI(currentPos) {
  const percent = (currentPos / duration) * 100;
  progressFill.style.width = `${percent}%`;

  const mins = Math.floor(currentPos / 60);
  const secs = Math.floor(currentPos % 60).toString().padStart(2, '0');
  timeCurrent.textContent = `${mins}:${secs}`;

  if (lyrics.length > 0) {
    let activeIdx = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (currentPos >= lyrics[i].time) activeIdx = i;
      else break;
    }
    updateLyricsDisplay(activeIdx);
  }
}

// --- Lyrics (Bit-Karaoke 4-line display) ---

let lastLyricIndex = -2;

function updateLyricsDisplay(index) {
  if (index === lastLyricIndex) return;

  const prev = index > 0 ? (lyrics[index - 1]?.text || '') : '';
  const current = index >= 0 ? (lyrics[index]?.text || '') : '';
  const next = lyrics[index + 1]?.text || '';
  const next2 = lyrics[index + 2]?.text || '';

  if (lyricsPrev) lyricsPrev.textContent = prev;
  if (lyricsCurrent) {
    lyricsCurrent.textContent = current;
    if (lastLyricIndex >= 0 && index > lastLyricIndex) {
      lyricsCurrent.classList.add('lyrics-transition');
      setTimeout(() => lyricsCurrent.classList.remove('lyrics-transition'), 300);
    }
  }
  if (lyricsNext) lyricsNext.textContent = next;
  if (lyricsNext2) lyricsNext2.textContent = next2;

  lastLyricIndex = index;
}

function toggleKaraokeMode() {
  const isKaraokeMode = karaokeView.style.display !== 'none';
  const sidebar = document.querySelector('.sidebar');
  const mainHeader = document.querySelector('.main-header');
  const mainBanner = document.getElementById('main-banner');
  const trackListSection = document.querySelector('.track-list-section');
  const playerBar = document.querySelector('.player-bar');

  if (isKaraokeMode) {
    karaokeView.style.display = 'none';
    mixerPanel.classList.remove('open');
    if (sidebar) sidebar.style.display = '';
    if (mainHeader) mainHeader.style.display = '';
    if (mainBanner) mainBanner.style.display = '';
    if (trackListSection) trackListSection.style.display = '';
    if (playerBar) playerBar.style.display = '';
  } else {
    karaokeView.style.display = 'flex';
    if (sidebar) sidebar.style.display = 'none';
    if (mainHeader) mainHeader.style.display = 'none';
    if (mainBanner) mainBanner.style.display = 'none';
    if (trackListSection) trackListSection.style.display = 'none';
    if (playerBar) playerBar.style.display = 'none';
    resizeCanvas();
  }
}

// --- LRC Parser ---

function parseLrc(lrcText) {
  const lines = lrcText.split('\n');
  const timeRegEx = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

  lines.forEach(line => {
    const match = timeRegEx.exec(line);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const msStr = match[3].length === 2 ? match[3] + '0' : match[3];
      const ms = parseInt(msStr, 10);
      const time = min * 60 + sec + ms / 1000;
      const text = line.replace(timeRegEx, '').trim();
      if (text) lyrics.push({ time, text });
    }
  });
}

// --- WebGL Visualizer ---

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initWebGL() {
  if (!gl) return;
  const vertexShader = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

  shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);

  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(shaderProgram));
    return;
  }

  quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  positionLocation = gl.getAttribLocation(shaderProgram, 'a_position');

  uniforms.u_time = gl.getUniformLocation(shaderProgram, 'u_time');
  uniforms.u_resolution = gl.getUniformLocation(shaderProgram, 'u_resolution');
  uniforms.u_masterIntensity = gl.getUniformLocation(shaderProgram, 'u_masterIntensity');
  uniforms.u_drums = gl.getUniformLocation(shaderProgram, 'u_drums');
  uniforms.u_bass = gl.getUniformLocation(shaderProgram, 'u_bass');
  uniforms.u_other = gl.getUniformLocation(shaderProgram, 'u_other');
  uniforms.u_vocals = gl.getUniformLocation(shaderProgram, 'u_vocals');
  uniforms.u_drumsPeak = gl.getUniformLocation(shaderProgram, 'u_drumsPeak');
  uniforms.u_bassPeak = gl.getUniformLocation(shaderProgram, 'u_bassPeak');
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = Math.round(width * dpr * 0.5);
  canvas.height = Math.round(height * dpr * 0.5);
  if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
}

function drawVisualizer() {
  if (karaokeView.style.display === 'none' || !gl || !shaderProgram) return;

  if (visualizerStartTime === 0) visualizerStartTime = performance.now();
  const time = (performance.now() - visualizerStartTime) / 1000;

  gl.useProgram(shaderProgram);
  gl.uniform1f(uniforms.u_time, time);
  gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);

  const stems = ['drums', 'bass', 'other', 'vocals'];
  const features = stems.map(s => getAnalysedFeatures(s));

  const avgRMS = (features[0].rms + features[1].rms + features[2].rms + features[3].rms) / 4;

  gl.uniform1f(uniforms.u_masterIntensity, avgRMS);
  gl.uniform4f(uniforms.u_drums, features[0].rms, features[0].low, features[0].mid, features[0].high);
  gl.uniform4f(uniforms.u_bass, features[1].rms, features[1].low, features[1].mid, features[1].high);
  gl.uniform4f(uniforms.u_other, features[2].rms, features[2].low, features[2].mid, features[2].high);
  gl.uniform4f(uniforms.u_vocals, features[3].rms, features[3].low, features[3].mid, features[3].high);
  gl.uniform1f(uniforms.u_drumsPeak, features[0].peak ? features[0].peakValue : 0);
  gl.uniform1f(uniforms.u_bassPeak, features[1].peak ? features[1].peakValue : 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  initWebGL();
  resizeCanvas();
});
