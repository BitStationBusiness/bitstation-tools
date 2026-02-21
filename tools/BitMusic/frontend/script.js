'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const STEMS = ['drums', 'bass', 'other', 'vocals'];
const FFT_SIZE = 1024;
const SMOOTHING = 0.3;
const PEAK_THRESHOLD = 0.6;
const PEAK_DECAY_RATE = 0.95;

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

// Audio
let ctx = null;
let masterGain = null;
const gains     = { drums: null, bass: null, other: null, vocals: null };
const analysers = { drums: null, bass: null, other: null, vocals: null };
const sources   = { drums: null, bass: null, other: null, vocals: null };
let   buffers   = { drums: null, bass: null, other: null, vocals: null };
const analyserData = { drums: null, bass: null, other: null, vocals: null };
const stemAnalysis = {};
STEMS.forEach(s => (stemAnalysis[s] = { rms:0, low:0, mid:0, high:0, peakDecay:0, peakValue:0, lowEnd:0, midEnd:0 }));

// Library
let library = [];
let currentAlbumIdx = -1;
let currentAlbum = null;
let currentTrackIdx = 0;

// Playback
let isPlaying = false;
let startOffset = 0;
let startTime = 0;
let duration = 0;
let animId = null;

// Gapless preload
let preloadedBufs = null;
let preloadedKey = null;

// Playlist / queue
let playlist = [];
let playlistPos = 0;

// Modes
let shuffleOn = false;
let repeatMode = 'none'; // 'none' | 'all' | 'one'

// Lyrics
let lyrics = [];
let lastLyricIdx = -2;

// Volume
let currentVolume = 0.7;

// Directory
let dirHandle = null;
let dirName = '';
let autoRefreshTimer = null;

// Search
let searchActive = false;

// Persistence
let likedSet = new Set(JSON.parse(localStorage.getItem('bm-liked') || '[]'));

// WebGL
let gl = null, shaderProg = null, quadBuf = null, posLoc = -1;
const uLoc = {};
let vizStartTime = 0;
let karaokeActive = false;

// ═══════════════════════════════════════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const q = sel => document.querySelector(sel);

// ═══════════════════════════════════════════════════════════════════════════
// IndexedDB (persist directory handle across sessions)
// ═══════════════════════════════════════════════════════════════════════════

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('BitMusicDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

async function dbPut(key, value) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = res;
      tx.onerror = e => rej(e.target.error);
    });
  } catch (e) { /* ignore */ }
}

async function dbGet(key) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Audio Engine
// ═══════════════════════════════════════════════════════════════════════════

async function initAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);
    masterGain.gain.value = currentVolume;

    const binSize = ctx.sampleRate / FFT_SIZE;
    const lowEnd = Math.floor(250 / binSize);
    const midEnd = Math.floor(2000 / binSize);

    STEMS.forEach(s => {
      gains[s] = ctx.createGain();
      gains[s].gain.value = parseFloat($(`vol-${s}`)?.value ?? 0.8);
      gains[s].connect(masterGain);

      analysers[s] = ctx.createAnalyser();
      analysers[s].fftSize = FFT_SIZE;
      analysers[s].smoothingTimeConstant = 0.4;
      analyserData[s] = new Uint8Array(analysers[s].frequencyBinCount);

      stemAnalysis[s].lowEnd = lowEnd;
      stemAnalysis[s].midEnd = midEnd;
    });
  }
  if (ctx.state === 'suspended') await ctx.resume();
}

function getAnalysedFeatures(stem) {
  const analyser = analysers[stem];
  const data = analyserData[stem];
  const st = stemAnalysis[stem];
  if (!analyser || !data) return { rms:0, low:0, mid:0, high:0, peak:false, peakValue:0 };

  analyser.getByteFrequencyData(data);
  let sum = 0, ls = 0, ms = 0, hs = 0, lc = 0, mc = 0, hc = 0;
  const len = data.length;
  for (let i = 0; i < len; i++) {
    const v = data[i] / 255;
    sum += v * v;
    if (i < st.lowEnd)      { ls += v; lc++; }
    else if (i < st.midEnd) { ms += v; mc++; }
    else                    { hs += v; hc++; }
  }
  const rms  = Math.sqrt(sum / len);
  const low  = lc > 0 ? ls / lc : 0;
  const mid  = mc > 0 ? ms / mc : 0;
  const high = hc > 0 ? hs / hc : 0;

  st.rms  = st.rms  * (1 - SMOOTHING) + rms  * SMOOTHING;
  st.low  = st.low  * (1 - SMOOTHING) + low  * SMOOTHING;
  st.mid  = st.mid  * (1 - SMOOTHING) + mid  * SMOOTHING;
  st.high = st.high * (1 - SMOOTHING) + high * SMOOTHING;

  st.peakDecay *= PEAK_DECAY_RATE;
  const peak = rms > st.peakDecay && rms > PEAK_THRESHOLD;
  if (peak) { st.peakDecay = rms; st.peakValue = rms; }

  return { rms: st.rms, low: st.low, mid: st.mid, high: st.high, peak, peakValue: st.peakValue };
}

// ═══════════════════════════════════════════════════════════════════════════
// Directory & Library Loading
// ═══════════════════════════════════════════════════════════════════════════

async function pickDirectory() {
  if ('showDirectoryPicker' in window) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      dirHandle = handle;
      dirName = handle.name;
      localStorage.setItem('bm-dirname', handle.name);
      await dbPut('dir-handle', handle);
      await scanDirectoryHandle(handle);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('showDirectoryPicker failed, using fallback');
    }
  }
  $('dir-input').click();
}

async function tryRestoreDirectory() {
  if ('showDirectoryPicker' in window) {
    const handle = await dbGet('dir-handle');
    if (!handle) return;
    try {
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') {
        dirHandle = handle;
        dirName = handle.name;
        setDirStatus(`📂 ${dirName}`);
        await scanDirectoryHandle(handle);
        return;
      }
      showRestoreBanner(handle);
    } catch (e) { /* handle expired */ }
    return;
  }
  const savedName = localStorage.getItem('bm-dirname');
  if (savedName) showRestoreBanner(null, savedName);
}

function showRestoreBanner(handle, name) {
  const banner = $('restore-banner');
  if (!banner) return;
  const displayName = handle?.name || name || 'directorio anterior';
  $('restore-banner-text').textContent = `Recargar: ${displayName}`;
  banner.style.display = 'flex';

  $('btn-restore-yes').onclick = async () => {
    banner.style.display = 'none';
    if (handle) {
      const perm = await handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        dirHandle = handle;
        dirName = handle.name;
        await scanDirectoryHandle(handle);
      }
    } else {
      $('dir-input').click();
    }
  };
  $('btn-restore-no').onclick = () => { banner.style.display = 'none'; };
}

async function scanDirectoryHandle(handle) {
  const files = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.bm')) {
        files.push(await entry.getFile());
      }
    }
  } catch (err) {
    setDirStatus('⚠️ Error al leer directorio');
    return;
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  await processFiles(files);
}

async function handleDirInputChange(e) {
  const files = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.bm'));
  if (!files.length) return;
  const relPath = e.target.files[0].webkitRelativePath;
  dirName = relPath ? relPath.split('/')[0] : 'Carpeta local';
  localStorage.setItem('bm-dirname', dirName);
  files.sort((a, b) => a.name.localeCompare(b.name));
  await processFiles(files);
}

async function processFiles(files) {
  if (!files.length) {
    setDirStatus(`📂 ${dirName} · Sin archivos .bm`);
    library = [];
    renderSidebarAlbums();
    showEmptyState();
    return;
  }
  const count = files.length;
  setDirStatus(`⏳ Cargando ${count} álbum${count > 1 ? 'es' : ''}...`);
  $('track-list').innerHTML = `<li class="loading-state"><i class="ph ph-spinner loading-spin"></i><span>Cargando biblioteca...</span></li>`;

  const results = await Promise.allSettled(files.map(parseBmFile));
  library = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .sort((a, b) => a.title.localeCompare(b.title));

  setDirStatus(`📂 ${dirName} · ${library.length} álbum${library.length !== 1 ? 'es' : ''}`);
  renderSidebarAlbums();

  if (library.length > 0) {
    selectAlbum(0);
    startAutoRefresh();
  } else {
    showEmptyState('No se encontraron archivos .bm válidos');
  }
}

async function parseBmFile(file) {
  const zip = await JSZip.loadAsync(file);
  const mf = zip.file('bm.json');
  if (!mf) throw new Error(`${file.name}: missing bm.json`);
  const meta = JSON.parse(await mf.async('string'));

  let coverUrl = null;
  if (meta.cover) {
    const cf = zip.file(meta.cover);
    if (cf) coverUrl = URL.createObjectURL(await cf.async('blob'));
  }

  return {
    title:    meta.title       || file.name.replace(/\.bm$/i, ''),
    artist:   meta.album_artist || meta.artist || 'Artista desconocido',
    year:     meta.year   || '',
    genre:    meta.genre  || '',
    tracks:   meta.tracks || [],
    coverUrl,
    zipRef:   zip,
    fileName: file.name,
  };
}

async function refreshDirectory() {
  if (!dirHandle) { pickDirectory(); return; }
  try {
    let perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      perm = await dirHandle.requestPermission({ mode: 'read' });
    }
    if (perm === 'granted') await scanDirectoryHandle(dirHandle);
    else setDirStatus('⚠️ Permiso denegado');
  } catch (e) { console.error('Refresh error:', e); }
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    if (!dirHandle || document.hidden) return;
    try {
      const perm = await dirHandle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') return;
      let count = 0;
      for await (const e of dirHandle.values()) {
        if (e.kind === 'file' && e.name.toLowerCase().endsWith('.bm')) count++;
      }
      if (count !== library.length) await scanDirectoryHandle(dirHandle);
    } catch (e) { /* ignore */ }
  }, 30000);
}

// ═══════════════════════════════════════════════════════════════════════════
// Library UI
// ═══════════════════════════════════════════════════════════════════════════

function setDirStatus(msg) {
  const el = $('dir-status');
  if (el) el.textContent = msg;
}

function showEmptyState(msg) {
  $('track-list').innerHTML = `
    <li class="empty-state-tracks">
      <i class="ph ph-folder-open"></i>
      <p>${msg || 'Selecciona un directorio con archivos .bm'}</p>
    </li>`;
  updateBannerEmpty();
}

function updateBannerEmpty() {
  $('banner-title').innerHTML = 'Bit<span class="neon-text">Music</span>';
  $('banner-subtitle').textContent = 'Selecciona un directorio .bm para comenzar';
  $('banner-art-bg').style.backgroundImage = '';
  $('btn-play-all').style.display = 'none';
}

function renderSidebarAlbums() {
  const list = $('albums-list');
  if (!list) return;

  if (!library.length) {
    list.innerHTML = `<div class="empty-state-sidebar"><i class="ph ph-music-notes-simple"></i><span>Sin álbumes</span></div>`;
    return;
  }

  list.innerHTML = library.map((album, i) => `
    <div class="album-item ${i === currentAlbumIdx ? 'active' : ''}" data-idx="${i}">
      <img class="album-thumb" src="${album.coverUrl || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 fill=%22%23111%22%3E%3Crect width=%22100%22 height=%22100%22/%3E%3C/svg%3E'}" alt="">
      <div class="album-item-info">
        <div class="album-item-title">${album.title}</div>
        <div class="album-item-sub">${album.tracks.length} pista${album.tracks.length !== 1 ? 's' : ''}</div>
      </div>
      ${i === currentAlbumIdx && isPlaying ? '<i class="ph-fill ph-equalizer album-playing-icon"></i>' : ''}
    </div>
  `).join('');

  list.querySelectorAll('.album-item').forEach(el => {
    el.addEventListener('click', () => selectAlbum(parseInt(el.dataset.idx)));
  });
}

function selectAlbum(idx) {
  currentAlbumIdx = idx;
  currentAlbum = library[idx];
  searchActive = false;
  const si = $('search-input');
  if (si) si.value = '';
  const clr = $('btn-clear-search');
  if (clr) clr.style.display = 'none';

  // Update banner
  const words = currentAlbum.title.trim().split(/\s+/);
  const lastWord = words.pop();
  const rest = words.join(' ');
  $('banner-title').innerHTML = `${rest ? rest + ' ' : ''}<span class="neon-text">${lastWord}</span>`;
  const subParts = [currentAlbum.artist, currentAlbum.year, currentAlbum.genre].filter(Boolean);
  $('banner-subtitle').textContent = subParts.join(' · ');
  if (currentAlbum.coverUrl) {
    $('banner-art-bg').style.backgroundImage = `url(${currentAlbum.coverUrl})`;
  }
  $('btn-play-all').style.display = 'flex';

  renderSidebarAlbums();
  renderTrackList();
  buildPlaylist(0);
}

function renderTrackList() {
  const list = $('track-list');
  if (!list || !currentAlbum) return;
  const tracks = currentAlbum.tracks;

  $('section-title').textContent = currentAlbum.title;
  $('track-count').textContent = `${tracks.length} pista${tracks.length !== 1 ? 's' : ''}`;

  if (!tracks.length) {
    list.innerHTML = `<li class="empty-state-tracks"><i class="ph ph-music-notes-simple"></i><p>Sin pistas en este álbum</p></li>`;
    return;
  }

  list.innerHTML = tracks.map((track, i) => {
    const ms = track.duration_ms || 0;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    const isActive = (i === currentTrackIdx && isPlaying);
    return `
      <li class="track-item ${isActive ? 'playing' : ''}" data-i="${i}">
        <div class="col-num">
          <span class="track-num">${i + 1}</span>
          <i class="ph-fill ph-play track-play-icon"></i>
        </div>
        <div class="col-title track-title-container">
          <img src="${currentAlbum.coverUrl || ''}" class="track-img" alt="">
          <div class="track-info">
            <div class="track-title">${track.title || 'Sin título'}</div>
            <div class="track-artist">${track.artist || currentAlbum.artist || 'Desconocido'}</div>
          </div>
        </div>
        <div class="col-album">${currentAlbum.title}</div>
        <div class="col-time">${mins}:${secs}</div>
      </li>`;
  }).join('');

  list.querySelectorAll('.track-item').forEach(el => {
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.i);
      buildPlaylist(i);
      playlistPos = 0;
      playTrack(currentAlbumIdx, i, true);
    });
    el.addEventListener('dblclick', () => toggleKaraokeMode(true));
  });
}

function updateTrackHighlight(trackIdx) {
  $('track-list')?.querySelectorAll('.track-item').forEach((el, i) => {
    const active = i === trackIdx;
    el.classList.toggle('playing', active);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Playlist / Queue
// ═══════════════════════════════════════════════════════════════════════════

function buildPlaylist(startTrack = 0) {
  if (!currentAlbum) return;
  playlist = currentAlbum.tracks.map((_, i) => ({ albumIdx: currentAlbumIdx, trackIdx: i }));
  if (shuffleOn && playlist.length > 1) {
    const first = playlist.splice(startTrack, 1)[0];
    for (let i = playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
    }
    playlist.unshift(first);
    playlistPos = 0;
  } else {
    playlistPos = startTrack;
  }
}

function nextQueuePos() {
  if (repeatMode === 'one') return playlistPos;
  const next = playlistPos + 1;
  return next >= playlist.length ? (repeatMode === 'all' ? 0 : -1) : next;
}

function prevQueuePos() {
  const prev = playlistPos - 1;
  return prev < 0 ? (repeatMode === 'all' ? playlist.length - 1 : 0) : prev;
}

function advanceToNext() {
  const nextPos = nextQueuePos();
  if (nextPos < 0) { stopPlayback(); return; }
  playlistPos = nextPos;
  const { albumIdx, trackIdx } = playlist[nextPos];
  currentAlbumIdx = albumIdx;
  currentTrackIdx = trackIdx;
  currentAlbum = library[albumIdx];
  playTrack(albumIdx, trackIdx, true);
}

function goToPrev() {
  const pos = isPlaying ? startOffset + (ctx.currentTime - startTime) : startOffset;
  if (pos > 3) { seek(0); return; }
  const prevPos = prevQueuePos();
  playlistPos = prevPos;
  const { albumIdx, trackIdx } = playlist[prevPos];
  currentAlbumIdx = albumIdx;
  currentTrackIdx = trackIdx;
  currentAlbum = library[albumIdx];
  playTrack(albumIdx, trackIdx, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// Playback Engine
// ═══════════════════════════════════════════════════════════════════════════

async function playTrack(albumIdx, trackIdx, autoPlay = true) {
  stopSources();
  cancelAnimationFrame(animId);

  currentAlbumIdx = albumIdx;
  currentTrackIdx = trackIdx;
  currentAlbum = library[albumIdx];
  const track = currentAlbum.tracks[trackIdx];

  // Update now playing info
  $('np-title').textContent = track.title || 'Sin título';
  $('np-artist').textContent = track.artist || currentAlbum.artist || '-';
  $('np-img').src = currentAlbum.coverUrl || '';

  // Update like button
  const likeKey = `${currentAlbum.title}:${track.title}`;
  const liked = likedSet.has(likeKey);
  const likeBtn = $('btn-like');
  if (likeBtn) {
    likeBtn.querySelector('i').className = liked ? 'ph-fill ph-heart' : 'ph ph-heart';
    likeBtn.style.color = liked ? 'var(--accent-magenta)' : '';
  }

  // Update document title and track highlight
  document.title = `${track.title || 'Sin título'} · BitMusic`;
  updateTrackHighlight(trackIdx);

  await initAudio();

  // Lyrics
  lyrics = [];
  lastLyricIdx = -2;
  if (track.lrc_path) {
    const lf = currentAlbum.zipRef.file(track.lrc_path);
    if (lf) parseLrc(await lf.async('string'));
  }
  updateLyricsDisplay(-1);

  duration = 0;
  const trackKey = `${albumIdx}:${trackIdx}`;

  // Use preloaded buffers if available (gapless playback)
  if (preloadedKey === trackKey && preloadedBufs) {
    buffers = preloadedBufs;
    preloadedBufs = null;
    preloadedKey = null;
    STEMS.forEach(s => { if (buffers[s]) duration = Math.max(duration, buffers[s].duration); });
  } else {
    buffers = { drums: null, bass: null, other: null, vocals: null };
    if (track.stems) {
      await Promise.all(STEMS.map(async s => {
        const path = track.stems[s];
        if (!path) return;
        const f = currentAlbum.zipRef.file(path);
        if (!f) return;
        buffers[s] = await ctx.decodeAudioData(await f.async('arraybuffer'));
        duration = Math.max(duration, buffers[s].duration);
      }));
    }
  }

  $('time-total').textContent = fmtTime(duration);
  startOffset = 0;
  updateMediaSession(track, currentAlbum);
  preloadNextTrack();

  if (autoPlay) startPlayback(0);
}

async function preloadNextTrack() {
  const nextPos = nextQueuePos();
  if (nextPos < 0 || repeatMode === 'one') return;
  const { albumIdx, trackIdx } = playlist[nextPos];
  const key = `${albumIdx}:${trackIdx}`;
  if (preloadedKey === key) return;

  const album = library[albumIdx];
  const track = album?.tracks[trackIdx];
  if (!track?.stems) return;

  await initAudio();
  const nb = {};
  await Promise.all(STEMS.map(async s => {
    const path = track.stems[s];
    if (!path) return;
    const f = album.zipRef.file(path);
    if (!f) return;
    nb[s] = await ctx.decodeAudioData(await f.async('arraybuffer'));
  }));
  preloadedBufs = nb;
  preloadedKey = key;
}

function startPlayback(offset) {
  if (!ctx) return;
  stopSources();
  STEMS.forEach(s => {
    if (!buffers[s]) return;
    sources[s] = ctx.createBufferSource();
    sources[s].buffer = buffers[s];
    sources[s].connect(analysers[s]);
    analysers[s].connect(gains[s]);
    sources[s].start(0, offset);
  });
  isPlaying = true;
  startOffset = offset;
  startTime = ctx.currentTime;
  setPlayIcon(true);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
  renderSidebarAlbums();
  updateTrackHighlight(currentTrackIdx);
  updateLoop();
}

function pausePlayback() {
  if (!isPlaying) return;
  stopSources();
  isPlaying = false;
  startOffset += ctx.currentTime - startTime;
  cancelAnimationFrame(animId);
  setPlayIcon(false);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
  renderSidebarAlbums();
}

function stopPlayback() {
  stopSources();
  isPlaying = false;
  startOffset = 0;
  duration = 0;
  cancelAnimationFrame(animId);
  $('progress-fill').style.width = '0%';
  $('time-current').textContent = '0:00';
  setPlayIcon(false);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
  document.title = 'BitMusic';
  renderSidebarAlbums();
}

function stopSources() {
  STEMS.forEach(s => {
    if (!sources[s]) return;
    try { sources[s].stop(); } catch (e) { /* already stopped */ }
    sources[s].disconnect();
    sources[s] = null;
  });
}

function togglePlay() {
  if (!currentAlbum) return;
  if (isPlaying) pausePlayback();
  else startPlayback(startOffset);
}

async function seek(t) {
  if (!duration) return;
  const wasPlaying = isPlaying;
  if (wasPlaying) pausePlayback();
  startOffset = Math.max(0, Math.min(t, duration));
  updateUI(startOffset);
  if (wasPlaying) { await initAudio(); startPlayback(startOffset); }
  try {
    if (navigator.mediaSession?.setPositionState)
      navigator.mediaSession.setPositionState({ duration, position: startOffset, playbackRate: 1 });
  } catch (e) { /* unsupported */ }
}

function setPlayIcon(playing) {
  const i = $('play-btn')?.querySelector('i');
  if (i) i.className = playing ? 'ph-fill ph-pause-circle' : 'ph-fill ph-play-circle';
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Update Loop
// ═══════════════════════════════════════════════════════════════════════════

function updateLoop() {
  if (!isPlaying) return;
  const pos = startOffset + (ctx.currentTime - startTime);
  if (pos >= duration && duration > 0) { advanceToNext(); return; }
  updateUI(pos);
  drawVisualizer();
  animId = requestAnimationFrame(updateLoop);
}

function updateUI(pos) {
  const pct = duration > 0 ? (pos / duration) * 100 : 0;
  $('progress-fill').style.width = `${pct}%`;
  $('time-current').textContent = fmtTime(pos);

  if (lyrics.length > 0) {
    let ai = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (pos >= lyrics[i].time) ai = i;
      else break;
    }
    updateLyricsDisplay(ai);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Lyrics
// ═══════════════════════════════════════════════════════════════════════════

function parseLrc(text) {
  lyrics = [];
  const re = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
  text.split('\n').forEach(line => {
    const m = re.exec(line);
    if (!m) return;
    const t = +m[1] * 60 + +m[2] + parseInt(m[3].length === 2 ? m[3] + '0' : m[3]) / 1000;
    const txt = line.replace(re, '').trim();
    if (txt) lyrics.push({ time: t, text: txt });
  });
}

function updateLyricsDisplay(idx) {
  if (idx === lastLyricIdx) return;
  const prev  = idx > 0  ? (lyrics[idx - 1]?.text || '') : '';
  const cur   = idx >= 0 ? (lyrics[idx]?.text     || '') : '';
  const next  = lyrics[idx + 1]?.text || '';
  const next2 = lyrics[idx + 2]?.text || '';

  const lP = $('lyrics-prev'), lC = $('lyrics-current');
  const lN = $('lyrics-next'), lN2 = $('lyrics-next2');
  if (lP) lP.textContent = prev;
  if (lC) {
    lC.textContent = cur;
    if (lastLyricIdx >= 0 && idx > lastLyricIdx) {
      lC.classList.add('lyrics-transition');
      setTimeout(() => lC.classList.remove('lyrics-transition'), 300);
    }
  }
  if (lN)  lN.textContent  = next;
  if (lN2) lN2.textContent = next2;
  lastLyricIdx = idx;
}

// ═══════════════════════════════════════════════════════════════════════════
// MediaSession API (background / lock screen playback)
// ═══════════════════════════════════════════════════════════════════════════

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler('play',          () => { if (!isPlaying) startPlayback(startOffset); });
  ms.setActionHandler('pause',         () => { if (isPlaying)  pausePlayback(); });
  ms.setActionHandler('nexttrack',     () => advanceToNext());
  ms.setActionHandler('previoustrack', () => goToPrev());
  ms.setActionHandler('seekto',        d => seek(d.seekTime));
  ms.setActionHandler('seekforward',   d => {
    const cur = isPlaying ? startOffset + ctx.currentTime - startTime : startOffset;
    seek(cur + (d.seekOffset || 10));
  });
  ms.setActionHandler('seekbackward',  d => {
    const cur = isPlaying ? startOffset + ctx.currentTime - startTime : startOffset;
    seek(Math.max(0, cur - (d.seekOffset || 10)));
  });
}

function updateMediaSession(track, album) {
  if (!('mediaSession' in navigator)) return;
  const artwork = album.coverUrl ? [{ src: album.coverUrl }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title:   track.title  || 'Sin título',
    artist:  track.artist || album.artist || 'Artista desconocido',
    album:   album.title  || 'BitMusic',
    artwork,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Volume Control
// ═══════════════════════════════════════════════════════════════════════════

function setupVolumeControl() {
  const bar  = $('volume-bar');
  const fill = $('volume-fill');
  if (!bar || !fill) return;

  const apply = clientX => {
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setVolume(pct);
  };

  bar.addEventListener('mousedown', e => {
    apply(e.clientX);
    const mv = e => apply(e.clientX);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });

  bar.addEventListener('touchstart', e => {
    apply(e.touches[0].clientX);
    const mv = e => apply(e.touches[0].clientX);
    const end = () => { document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', end); };
    document.addEventListener('touchmove', mv, { passive: true });
    document.addEventListener('touchend', end);
  }, { passive: true });
}

function setVolume(pct) {
  currentVolume = Math.max(0, Math.min(1, pct));
  const fill = $('volume-fill');
  if (fill) fill.style.width = `${currentVolume * 100}%`;
  if (masterGain && ctx) masterGain.gain.setTargetAtTime(currentVolume, ctx.currentTime, 0.01);
  const ms = $('vol-master');
  if (ms) ms.value = currentVolume;
  // Update volume icon
  const vi = $('vol-icon');
  if (vi) {
    if (currentVolume === 0) vi.className = 'ph ph-speaker-slash vol-icon';
    else if (currentVolume < 0.4) vi.className = 'ph ph-speaker-low vol-icon';
    else if (currentVolume < 0.7) vi.className = 'ph ph-speaker vol-icon';
    else vi.className = 'ph ph-speaker-high vol-icon';
  }
}

function adjustVol(delta) {
  setVolume(currentVolume + delta);
}

// ═══════════════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════════════

function handleSearch(q) {
  const query = q.toLowerCase().trim();
  searchActive = !!query;
  const clr = $('btn-clear-search');
  if (clr) clr.style.display = q ? 'flex' : 'none';

  if (!query) {
    if (currentAlbum) renderTrackList();
    return;
  }

  const results = [];
  library.forEach((album, ai) => {
    album.tracks.forEach((track, ti) => {
      if (
        track.title?.toLowerCase().includes(query) ||
        (track.artist || album.artist)?.toLowerCase().includes(query) ||
        album.title?.toLowerCase().includes(query)
      ) {
        results.push({ ...track, _ai: ai, _ti: ti, _album: album });
      }
    });
  });

  $('section-title').textContent = 'Búsqueda';
  $('track-count').textContent = `${results.length} resultado${results.length !== 1 ? 's' : ''}`;

  const list = $('track-list');
  if (!results.length) {
    list.innerHTML = `<li class="empty-state-tracks"><i class="ph ph-magnifying-glass"></i><p>Sin resultados para "${q}"</p></li>`;
    return;
  }

  list.innerHTML = results.map((track, i) => {
    const ms = track.duration_ms || 0;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    return `
      <li class="track-item" data-ai="${track._ai}" data-ti="${track._ti}">
        <div class="col-num"><span class="track-num">${i + 1}</span><i class="ph-fill ph-play track-play-icon"></i></div>
        <div class="col-title track-title-container">
          <img src="${track._album.coverUrl || ''}" class="track-img" alt="">
          <div class="track-info">
            <div class="track-title">${track.title || 'Sin título'}</div>
            <div class="track-artist">${track.artist || track._album.artist || ''}</div>
          </div>
        </div>
        <div class="col-album">${track._album.title}</div>
        <div class="col-time">${mins}:${secs}</div>
      </li>`;
  }).join('');

  list.querySelectorAll('.track-item').forEach(el => {
    el.addEventListener('click', () => {
      const ai = parseInt(el.dataset.ai);
      const ti = parseInt(el.dataset.ti);
      selectAlbum(ai);
      buildPlaylist(ti);
      playlistPos = 0;
      playTrack(ai, ti, true);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Karaoke Mode
// ═══════════════════════════════════════════════════════════════════════════

function toggleKaraokeMode(show) {
  karaokeActive = (show !== undefined) ? !!show : !karaokeActive;
  const kv  = $('karaoke-view');
  const sb  = q('.sidebar');
  const mh  = q('.main-header');
  const mb  = $('main-banner');
  const tls = q('.track-list-section');
  const pb  = q('.player-bar');

  if (karaokeActive) {
    kv.style.display = 'flex';
    if (sb)  sb.style.display = 'none';
    if (mh)  mh.style.display = 'none';
    if (mb)  mb.style.display = 'none';
    if (tls) tls.style.display = 'none';
    if (pb)  pb.style.display = 'none';
    resizeCanvas();
  } else {
    kv.style.display = 'none';
    $('mixer-panel')?.classList.remove('open');
    if (sb)  sb.style.display = '';
    if (mh)  mh.style.display = '';
    if (mb)  mb.style.display = '';
    if (tls) tls.style.display = '';
    if (pb)  pb.style.display = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shuffle & Repeat
// ═══════════════════════════════════════════════════════════════════════════

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  $('btn-shuffle')?.classList.toggle('active', shuffleOn);
  buildPlaylist(currentTrackIdx);
}

function toggleRepeat() {
  const modes = ['none', 'all', 'one'];
  repeatMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];
  const btn = $('btn-repeat');
  if (!btn) return;
  btn.classList.toggle('active', repeatMode !== 'none');
  btn.querySelector('i').className = repeatMode === 'one' ? 'ph ph-repeat-once' : 'ph ph-repeat';
  btn.title = { none: 'Repetir', all: 'Repetir todo', one: 'Repetir una' }[repeatMode];
}

// ═══════════════════════════════════════════════════════════════════════════
// Like
// ═══════════════════════════════════════════════════════════════════════════

function toggleLike() {
  if (!currentAlbum) return;
  const track = currentAlbum.tracks[currentTrackIdx];
  const key = `${currentAlbum.title}:${track?.title}`;
  if (likedSet.has(key)) likedSet.delete(key);
  else likedSet.add(key);
  localStorage.setItem('bm-liked', JSON.stringify([...likedSet]));
  const liked = likedSet.has(key);
  const btn = $('btn-like');
  if (btn) {
    btn.querySelector('i').className = liked ? 'ph-fill ph-heart' : 'ph ph-heart';
    btn.style.color = liked ? 'var(--accent-magenta)' : '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function fmtTime(s) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════════════════

function setupEvents() {
  // Directory
  $('btn-pick-dir')?.addEventListener('click', pickDirectory);
  $('btn-refresh-dir')?.addEventListener('click', refreshDirectory);
  $('dir-input')?.addEventListener('change', handleDirInputChange);

  // Back to BitStation
  $('btn-back')?.addEventListener('click', () => {
    try { history.back(); } catch (e) { try { window.close(); } catch (e2) { /* noop */ } }
  });

  // Playback
  $('play-btn')?.addEventListener('click', togglePlay);
  $('btn-next')?.addEventListener('click', advanceToNext);
  $('btn-prev')?.addEventListener('click', goToPrev);

  // Progress bar (mouse + touch)
  const pb = $('progress-bar');
  if (pb) {
    const seekFrom = clientX => {
      if (!duration) return;
      const rect = pb.getBoundingClientRect();
      seek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration);
    };
    pb.addEventListener('mousedown', e => {
      seekFrom(e.clientX);
      const mv = e => seekFrom(e.clientX);
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    pb.addEventListener('touchstart', e => seekFrom(e.touches[0].clientX), { passive: true });
  }

  // Volume
  setupVolumeControl();

  // Shuffle / Repeat / Like
  $('btn-shuffle')?.addEventListener('click', toggleShuffle);
  $('btn-repeat')?.addEventListener('click', toggleRepeat);
  $('btn-like')?.addEventListener('click', toggleLike);

  // Play All
  $('btn-play-all')?.addEventListener('click', () => {
    if (!currentAlbum?.tracks.length) return;
    buildPlaylist(0);
    playlistPos = 0;
    const { albumIdx, trackIdx } = playlist[0];
    playTrack(albumIdx, trackIdx, true);
  });

  // Karaoke
  $('btn-enter-karaoke')?.addEventListener('click', () => toggleKaraokeMode(true));
  $('btn-exit-karaoke')?.addEventListener('click', () => toggleKaraokeMode(false));
  $('btn-toggle-karaoke-mixer')?.addEventListener('click', () => $('mixer-panel')?.classList.toggle('open'));
  $('btn-close-mixer')?.addEventListener('click', () => $('mixer-panel')?.classList.remove('open'));

  // Mixer sliders
  ['master', 'drums', 'bass', 'other', 'vocals'].forEach(key => {
    const sl = $(`vol-${key}`);
    if (!sl) return;
    sl.addEventListener('input', e => {
      const val = parseFloat(e.target.value);
      if (!ctx) return;
      if (key === 'master') {
        setVolume(val);
      } else {
        gains[key]?.gain.setTargetAtTime(val, ctx.currentTime, 0.05);
      }
    });
  });

  // Search
  const si = $('search-input');
  if (si) {
    si.addEventListener('input', e => handleSearch(e.target.value));
    si.addEventListener('keydown', e => { if (e.key === 'Escape') { si.value = ''; handleSearch(''); } });
  }
  $('btn-clear-search')?.addEventListener('click', () => { $('search-input').value = ''; handleSearch(''); });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const pos = isPlaying ? startOffset + (ctx?.currentTime - startTime) : startOffset;
    switch (e.code) {
      case 'Space':     e.preventDefault(); togglePlay();   break;
      case 'ArrowRight': e.shiftKey ? advanceToNext() : seek(pos + 10); break;
      case 'ArrowLeft':  e.shiftKey ? goToPrev()      : seek(Math.max(0, pos - 10)); break;
      case 'ArrowUp':   e.preventDefault(); adjustVol(0.1);  break;
      case 'ArrowDown': e.preventDefault(); adjustVol(-0.1); break;
      case 'KeyK':      toggleKaraokeMode(); break;
      case 'KeyL':      toggleLike();        break;
      case 'KeyS':      toggleShuffle();     break;
    }
  });

  // Resize
  window.addEventListener('resize', resizeCanvas);

  // Auto-refresh when user returns to tab
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && dirHandle) {
      // Silent check for new files
      (async () => {
        try {
          const perm = await dirHandle.queryPermission({ mode: 'read' });
          if (perm !== 'granted') return;
          let count = 0;
          for await (const e of dirHandle.values()) {
            if (e.kind === 'file' && e.name.toLowerCase().endsWith('.bm')) count++;
          }
          if (count !== library.length) await scanDirectoryHandle(dirHandle);
        } catch (e) { /* ignore */ }
      })();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// WebGL Visualizer (HomePod-style animated particle blobs)
// ═══════════════════════════════════════════════════════════════════════════

const VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform float u_time;
uniform vec2  u_resolution;
uniform float u_masterIntensity;
uniform vec4  u_drums;
uniform vec4  u_bass;
uniform vec4  u_other;
uniform vec4  u_vocals;
uniform float u_drumsPeak;
uniform float u_bassPeak;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec2 mod289(vec2 x){return x-floor(x*(1./289.))*289.;}
vec3 permute(vec3 x){return mod289(((x*34.)+1.)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));
  vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz;
  x12.xy-=i1;
  i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
  m=m*m*m*m;
  vec3 x=2.*fract(p*C.www)-1.;
  vec3 h=abs(x)-.5;
  vec3 ox=floor(x+.5);
  vec3 a0=x-ox;
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g;
  g.x=a0.x*x0.x+h.x*x0.y;
  g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.*dot(m,g);
}
float blob(vec2 uv,vec2 c,float r){float d=length(uv-c);return exp(-d*d/(r*r));}
vec2 bpos(float t,float seed,float spd,float rng){return vec2(snoise(vec2(t*spd+seed,seed*2.))*rng,snoise(vec2(seed*3.,t*spd+seed))*rng);}
void main(){
  vec2 uv=v_uv;
  float aspect=u_resolution.x/u_resolution.y;
  vec2 p=uv-.5; p.x*=aspect;
  float t=u_time;
  float r=length(p);
  float total=u_drums.x+u_bass.x+u_other.x+u_vocals.x;
  if(total<.001){fragColor=vec4(0,0,0,1);return;}
  vec3 dc=vec3(.133,.867,.4),bc=vec3(.267,.8,1.),oc=vec3(.667,.333,1.),vc=vec3(1.,.733,.2);
  float ef=smoothstep(.5,.27,r);
  vec3 fc=vec3(0.); float tg=0.;
  if(u_drums.x>.01){
    float i=u_drums.x,bs=.12+i*.08;
    float g=(blob(p,vec2(-.15,-.1)+bpos(t,1.,.3,.12)*(0.5+i),bs*1.2)
            +blob(p,vec2(.18,.15)+bpos(t,1.5,.25,.1)*(0.5+i),bs*.9)*.8
            +blob(p,vec2(-.08,.2)+bpos(t,1.8,.35,.08)*(0.5+i),bs*.7)*.6)*i*(1.+u_drumsPeak*.5);
    fc+=dc*g*1.2; tg+=g;}
  if(u_bass.x>.01){
    float i=u_bass.x,bs=.15+i*.1;
    float g=(blob(p,vec2(0.,-.12)+bpos(t,2.,.15,.15)*(0.4+i),bs*1.4)
            +blob(p,vec2(-.2,.08)+bpos(t,2.3,.12,.12)*(0.4+i),bs)*.9
            +blob(p,vec2(.15,.1)+bpos(t,2.6,.18,.1)*(0.4+i),bs*.85)*.7)*i*(1.+u_bassPeak*.4);
    fc+=bc*g*1.1; tg+=g;}
  if(u_other.x>.01){
    float i=u_other.x,bs=.11+i*.07;
    float g=(blob(p,vec2(.12,-.15)+bpos(t,3.,.28,.11)*(0.5+i),bs*1.1)
            +blob(p,vec2(-.18,-.05)+bpos(t,3.4,.22,.09)*(0.5+i),bs*.9)*.85
            +blob(p,vec2(.05,.18)+bpos(t,3.7,.3,.1)*(0.5+i),bs*.75)*.65)*i;
    fc+=oc*g*1.15; tg+=g;}
  if(u_vocals.x>.01){
    float i=u_vocals.x,bs=.13+i*.08;
    float g=(blob(p,vec2(0.,.05)+bpos(t,4.,.2,.1)*(0.4+i),bs*1.3)
            +blob(p,vec2(-.12,-.18)+bpos(t,4.3,.25,.12)*(0.5+i),bs*.95)*.8
            +blob(p,vec2(.2,0.)+bpos(t,4.6,.18,.08)*(0.5+i),bs*.8)*.65)*i;
    fc+=vc*g*1.2; tg+=g;}
  float mx=max(max(fc.r,fc.g),fc.b);
  if(mx>1.) fc=fc/mx*.95+fc*.05;
  vec3 ac=(dc*u_drums.x+bc*u_bass.x+oc*u_other.x+vc*u_vocals.x)/max(total,.001);
  fc+=ac*tg*.15*.3;
  fc*=(0.7+u_masterIntensity*0.6)*ef;
  fc*=max(1.-pow(r*1.5,2.5)*.2,.5);
  vec3 gr=vec3(dot(fc,vec3(.299,.587,.114)));
  fc=mix(gr,fc,1.3);
  float d=(fract(sin(dot(uv*u_resolution,vec2(12.9898,78.233)))*43758.5453)-.5)/128.;
  fragColor=vec4(clamp(fc+d,0.,1.),1.);
}`;

function compileShader(type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader error:', gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

function initWebGL() {
  const canvas = $('karaoke-canvas');
  if (!canvas) return;
  gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return;

  const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return;

  shaderProg = gl.createProgram();
  gl.attachShader(shaderProg, vs);
  gl.attachShader(shaderProg, fs);
  gl.linkProgram(shaderProg);
  if (!gl.getProgramParameter(shaderProg, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(shaderProg));
    return;
  }

  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  posLoc = gl.getAttribLocation(shaderProg, 'a_position');

  ['u_time','u_resolution','u_masterIntensity','u_drums','u_bass','u_other','u_vocals','u_drumsPeak','u_bassPeak']
    .forEach(u => uLoc[u] = gl.getUniformLocation(shaderProg, u));
}

function resizeCanvas() {
  const canvas = $('karaoke-canvas');
  if (!canvas || !gl) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width  = window.innerWidth  + 'px';
  canvas.style.height = window.innerHeight + 'px';
  canvas.width  = Math.round(window.innerWidth  * dpr * 0.5);
  canvas.height = Math.round(window.innerHeight * dpr * 0.5);
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function drawVisualizer() {
  const kv = $('karaoke-view');
  if (!kv || kv.style.display === 'none' || !gl || !shaderProg) return;
  if (vizStartTime === 0) vizStartTime = performance.now();
  const t = (performance.now() - vizStartTime) / 1000;

  gl.useProgram(shaderProg);
  gl.uniform1f(uLoc.u_time, t);
  gl.uniform2f(uLoc.u_resolution, $('karaoke-canvas').width, $('karaoke-canvas').height);

  const f = STEMS.map(s => getAnalysedFeatures(s)); // drums, bass, other, vocals
  const avgRms = (f[0].rms + f[1].rms + f[2].rms + f[3].rms) / 4;

  gl.uniform1f(uLoc.u_masterIntensity, avgRms);
  gl.uniform4f(uLoc.u_drums,  f[0].rms, f[0].low, f[0].mid, f[0].high);
  gl.uniform4f(uLoc.u_bass,   f[1].rms, f[1].low, f[1].mid, f[1].high);
  gl.uniform4f(uLoc.u_other,  f[2].rms, f[2].low, f[2].mid, f[2].high);
  gl.uniform4f(uLoc.u_vocals, f[3].rms, f[3].low, f[3].mid, f[3].high);
  gl.uniform1f(uLoc.u_drumsPeak, f[0].peak ? f[0].peakValue : 0);
  gl.uniform1f(uLoc.u_bassPeak,  f[1].peak ? f[1].peakValue : 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  setupEvents();
  setupMediaSession();
  initWebGL();
  resizeCanvas();
  showEmptyState();
  await tryRestoreDirectory();
});
