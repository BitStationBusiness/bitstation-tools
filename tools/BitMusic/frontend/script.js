// --- Variables ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
let ctx = null;

let masterGain;
let gains = { vocals: null, drums: null, bass: null, other: null };
let analysers = { vocals: null, drums: null, bass: null, other: null };
let sources = { vocals: null, drums: null, bass: null, other: null };
let buffers = { vocals: null, drums: null, bass: null, other: null };

let currentAlbum = null;
let currentTrackIndex = 0;
let lyrics = [];
let isPlaying = false;
let startOffset = 0;
let startTime = 0;
let animationFrameId = null;
let duration = 0;

// DOM Elements
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
const btnKaraokeToggle = document.getElementById('btn-karaoke-toggle');
const mixerPanel = document.getElementById('mixer-panel');
const btnCloseMixer = document.getElementById('btn-close-mixer');

const karaokeView = document.getElementById('karaoke-view');
const mainBanner = document.getElementById('main-banner');
const lyricsList = document.getElementById('lyrics-list');
const canvas = document.getElementById('karaoke-canvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

// WebGL Variables
let shaderProgram = null;
let quadBuffer = null;
let positionLocation = -1;
let uniforms = {};
let visualizerStartTime = 0;

// WebGL Shader Sources (Ported from Bit-Karaoke)
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

// ============================================
// Smooth Noise
// ============================================

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

// ============================================
// Soft Blob / Metaball
// ============================================

float softBlob(vec2 uv, vec2 center, float radius) {
  float d = length(uv - center);
  // Suave falloff exponencial tipo HomePod
  return exp(-d * d / (radius * radius));
}

// ============================================
// Animated Blob Position
// ============================================

vec2 blobPosition(float time, float seed, float speed, float range) {
  float x = snoise(vec2(time * speed + seed, seed * 2.0)) * range;
  float y = snoise(vec2(seed * 3.0, time * speed + seed)) * range;
  return vec2(x, y);
}

// ============================================
// Main
// ============================================

void main() {
  vec2 uv = v_uv;
  float aspect = u_resolution.x / u_resolution.y;
  
  // Centrar y corregir aspecto
  vec2 p = uv - 0.5;
  p.x *= aspect;
  
  float t = u_time;
  float radius = length(p);
  
  // Calcular intensidad total
  float totalIntensity = u_drums.x + u_bass.x + u_other.x + u_vocals.x;
  
  // Sin audio = negro puro
  if (totalIntensity < 0.001) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  
  // ============================================
  // Colores HomePod Style (vibrantes pero suaves)
  // ============================================
  vec3 drumsColor = vec3(0.13, 0.87, 0.4);     // Verde #22dd66
  vec3 bassColor = vec3(0.27, 0.8, 1.0);       // Azul #44ccff
  vec3 otherColor = vec3(0.67, 0.33, 1.0);     // Morado #aa55ff
  vec3 vocalsColor = vec3(1.0, 0.73, 0.2);     // Naranja #ffbb33
  
  // ============================================
  // Radio del área visible (círculo)
  // ============================================
  float circleRadius = 0.42;
  float edgeFade = smoothstep(circleRadius + 0.08, circleRadius - 0.15, radius);
  
  // ============================================
  // Acumular color de todos los blobs
  // ============================================
  vec3 finalColor = vec3(0.0);
  float totalGlow = 0.0;
  
  // DRUMS - Verde: 3 blobs
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
  
  // BASS - Azul: 3 blobs (más grandes, movimiento lento)
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
  
  // OTHER - Morado: 3 blobs (medianos)
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
  
  // VOCALS - Naranja: 3 blobs (fluidos)
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
  
  // ============================================
  // Mezcla suave de colores (estilo HomePod)
  // ============================================
  
  // Normalizar para evitar oversaturation pero mantener brillo
  float maxComponent = max(max(finalColor.r, finalColor.g), finalColor.b);
  if (maxComponent > 1.0) {
    finalColor = finalColor / maxComponent * 0.95 + finalColor * 0.05;
  }
  
  // ============================================
  // Glow ambiente suave
  // ============================================
  float ambientGlow = totalGlow * 0.15;
  vec3 ambientColor = (drumsColor * u_drums.x + bassColor * u_bass.x + 
                       otherColor * u_other.x + vocalsColor * u_vocals.x) / 
                       max(totalIntensity, 0.001);
  finalColor += ambientColor * ambientGlow * 0.3;
  
  // ============================================
  // Intensidad master
  // ============================================
  float masterBoost = 0.7 + u_masterIntensity * 0.6;
  finalColor *= masterBoost;
  
  // ============================================
  // Aplicar máscara circular y viñeta
  // ============================================
  finalColor *= edgeFade;
  
  float innerGlow = 1.0 - pow(radius * 1.5, 2.5) * 0.2;
  finalColor *= max(innerGlow, 0.5);
  
  // ============================================
  // Saturación extra para colores más vivos
  // ============================================
  vec3 gray = vec3(dot(finalColor, vec3(0.299, 0.587, 0.114)));
  finalColor = mix(gray, finalColor, 1.3); // Boost saturación
  
  // ============================================
  // Anti-banding (dithering)
  // ============================================
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

// --- Initialization ---

async function initAudio() {
    if (!ctx) {
        ctx = new AudioContext();
        masterGain = ctx.createGain();
        masterGain.connect(ctx.destination);
        masterGain.gain.value = sliders.master.value;

        ['vocals', 'drums', 'bass', 'other'].forEach(stem => {
            gains[stem] = ctx.createGain();
            gains[stem].connect(masterGain);
            gains[stem].gain.value = sliders[stem].value;

            analysers[stem] = ctx.createAnalyser();
            analysers[stem].fftSize = 256;
        });
    }
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }
}

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
        const clickX = e.clientX - rect.left;
        const widthPercent = Math.max(0, Math.min(1, clickX / rect.width));
        seek(widthPercent * duration);
    });

    const btnEnterKaraoke = document.getElementById('btn-enter-karaoke');
    const btnExitKaraoke = document.getElementById('btn-exit-karaoke');
    const btnToggleMixer = document.getElementById('btn-toggle-karaoke-mixer');

    if (btnEnterKaraoke) {
        btnEnterKaraoke.addEventListener('click', toggleKaraokeMode);
    }
    if (btnExitKaraoke) {
        btnExitKaraoke.addEventListener('click', toggleKaraokeMode);
    }
    if (btnToggleMixer) {
        btnToggleMixer.addEventListener('click', () => {
            mixerPanel.classList.toggle('open');
        });
    }

    const btnCloseMixer = document.getElementById('btn-close-mixer');
    if (btnCloseMixer) {
        btnCloseMixer.addEventListener('click', () => {
            mixerPanel.classList.remove('open');
        });
    }

    // Mixer sliders
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
}

// --- JSZip BM Parsing ---

async function handleBmUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const zip = await JSZip.loadAsync(file);

        // Read manifest
        const manifestFile = zip.file('bm.json');
        if (!manifestFile) throw new Error('Invalid .bm file: missing bm.json');
        const manifestStr = await manifestFile.async('string');
        const manifest = JSON.parse(manifestStr);

        // Extract Cover
        let coverUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='%23111'%3E%3Crect width='100' height='100'/%3E%3C/svg%3E";
        if (manifest.cover && zip.file(manifest.cover)) {
            const coverBlob = await zip.file(manifest.cover).async('blob');
            coverUrl = URL.createObjectURL(coverBlob);
        }

        currentAlbum = {
            ...manifest,
            coverUrl,
            zipRef: zip
        };

        renderTrackList();
        if (currentAlbum.tracks.length > 0) {
            playTrack(0, false); // select but dont play yet
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

        const durMatch = (track.duration_ms / 1000) || 0;
        const mins = Math.floor(durMatch / 60);
        const secs = Math.floor(durMatch % 60).toString().padStart(2, '0');

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

        li.addEventListener('click', () => {
            playTrack(index, true);
        });

        trackListEl.appendChild(li);
    });
}

// --- Playback Logic ---

async function playTrack(index, autoPlay = true) {
    stopPlayback();

    currentTrackIndex = index;
    const track = currentAlbum.tracks[index];

    // UI Update
    document.querySelectorAll('.track-item').forEach(el => el.classList.remove('playing'));
    const row = trackListEl.querySelector(`[data-index="${index}"]`);
    if (row) row.classList.add('playing');

    npTitle.textContent = track.title || 'Unknown';
    npArtist.textContent = track.artist || currentAlbum.album_artist || '-';
    npImg.src = currentAlbum.coverUrl;

    await initAudio();

    // Load LRC
    lyricsList.innerHTML = '';
    lyrics = [];
    if (track.lrc_path && currentAlbum.zipRef.file(track.lrc_path)) {
        const lrcText = await currentAlbum.zipRef.file(track.lrc_path).async('string');
        parseLrc(lrcText);
    }

    // Load Stems
    if (!track.stems) {
        console.warn('Track missing stems');
        return;
    }

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

    // Add loading text
    npTitle.textContent = `Loading ${track.title}...`;

    await Promise.all(loadPromises);

    // Update total time UI
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60).toString().padStart(2, '0');
    timeTotal.textContent = `${mins}:${secs}`;
    npTitle.textContent = track.title || 'Unknown';

    if (autoPlay) {
        startPlayback(0);
    }
}

function startPlayback(offset) {
    if (!ctx) return;

    stopSources(); // stop any current ones just in case

    ['vocals', 'drums', 'bass', 'other'].forEach(stem => {
        if (buffers[stem]) {
            sources[stem] = ctx.createBufferSource();
            sources[stem].buffer = buffers[stem];

            // connect to analyser first, then to gain
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
    if (!currentAlbum || !buffers.vocals) return; // not loaded

    if (isPlaying) {
        pausePlayback();
    } else {
        startPlayback(startOffset);
    }
}

async function seek(time) {
    if (!currentAlbum) return;
    const wasPlaying = isPlaying;

    if (wasPlaying) {
        pausePlayback();
    }

    startOffset = Math.max(0, Math.min(time, duration));

    if (wasPlaying) {
        await initAudio();
        startPlayback(startOffset);
    } else {
        // Just update UI
        updateUI(startOffset);
    }
}

// --- Update Loop ---

function updateLoop() {
    if (!isPlaying) return;

    const currentPos = startOffset + (ctx.currentTime - startTime);

    if (currentPos >= duration && duration > 0) {
        // Track ended
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
    // Basic Bar
    const percent = (currentPos / duration) * 100;
    progressFill.style.width = `${percent}%`;

    const mins = Math.floor(currentPos / 60);
    const secs = Math.floor(currentPos % 60).toString().padStart(2, '0');
    timeCurrent.textContent = `${mins}:${secs}`;

    // Lyrics
    if (lyrics.length > 0) {
        let activeIdx = -1;
        for (let i = 0; i < lyrics.length; i++) {
            if (currentPos >= lyrics[i].time) {
                activeIdx = i;
            } else {
                break;
            }
        }

        if (activeIdx !== -1) {
            const lis = lyricsList.querySelectorAll('li');
            lis.forEach((li, idx) => {
                if (idx === activeIdx) {
                    if (!li.classList.contains('active')) {
                        li.classList.add('active');
                        li.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                } else {
                    li.classList.remove('active');
                }
            });
        }
    }
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
        // Show everything else
        if (sidebar) sidebar.style.display = '';
        if (mainHeader) mainHeader.style.display = '';
        if (mainBanner) mainBanner.style.display = '';
        if (trackListSection) trackListSection.style.display = '';
        if (playerBar) playerBar.style.display = '';
    } else {
        karaokeView.style.display = 'flex';
        // Hide everything else
        if (sidebar) sidebar.style.display = 'none';
        if (mainHeader) mainHeader.style.display = 'none';
        if (mainBanner) mainBanner.style.display = 'none';
        if (trackListSection) trackListSection.style.display = 'none';
        if (playerBar) playerBar.style.display = 'none';
        resizeCanvas();
    }
}

// --- Lyrics Parser ---

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

            if (text) {
                lyrics.push({ time, text });
                const li = document.createElement('li');
                li.textContent = text;
                lyricsList.appendChild(li);
            }
        }
    });
}

// --- Canvas Visualizer (WebGL) ---

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
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.width = width * (window.devicePixelRatio || 1);
    canvas.height = height * (window.devicePixelRatio || 1);

    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
}

function getRMS(stemName) {
    if (!analysers[stemName]) return 0;
    const data = new Uint8Array(analysers[stemName].frequencyBinCount);
    analysers[stemName].getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        let val = (data[i] - 128) / 128.0;
        sum += val * val;
    }
    const rms = Math.sqrt(sum / data.length);
    return rms * 10.0; // amplify for visualization
}

function drawVisualizer() {
    if (karaokeView.style.display === 'none' || !gl || !shaderProgram) return;

    if (visualizerStartTime === 0) visualizerStartTime = performance.now();
    const time = (performance.now() - visualizerStartTime) / 1000;

    gl.useProgram(shaderProgram);

    gl.uniform1f(uniforms.u_time, time);
    gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);

    // Master Intensity Approximation (average of all stems)
    const stems = ['drums', 'bass', 'other', 'vocals'];
    const rmsValues = stems.map(stem => getRMS(stem));
    const avgRMS = rmsValues.reduce((a, b) => a + b, 0) / 4;

    gl.uniform1f(uniforms.u_masterIntensity, avgRMS);
    gl.uniform4f(uniforms.u_drums, rmsValues[0], 0, 0, 0);
    gl.uniform4f(uniforms.u_bass, rmsValues[1], 0, 0, 0);
    gl.uniform4f(uniforms.u_other, rmsValues[2], 0, 0, 0);
    gl.uniform4f(uniforms.u_vocals, rmsValues[3], 0, 0, 0);

    // Mock peak values for now to save computation
    gl.uniform1f(uniforms.u_drumsPeak, rmsValues[0] > 0.8 ? 1.0 : 0.0);
    gl.uniform1f(uniforms.u_bassPeak, rmsValues[1] > 0.8 ? 1.0 : 0.0);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}


// Init
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    initWebGL();
    resizeCanvas();
});
