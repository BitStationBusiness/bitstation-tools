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
const canvasCtx = canvas.getContext('2d');

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

    btnKaraokeToggle.addEventListener('click', () => {
        mixerPanel.classList.toggle('open');
        if (karaokeView.style.display === 'none') {
            karaokeView.style.display = 'flex';
            mainBanner.style.display = 'none';
            document.querySelector('.track-list-section').style.display = 'none';
        } else {
            karaokeView.style.display = 'none';
            mainBanner.style.display = 'flex';
            document.querySelector('.track-list-section').style.display = 'block';
        }
        resizeCanvas();
    });

    btnCloseMixer.addEventListener('click', () => {
        mixerPanel.classList.remove('open');
    });

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

// --- Canvas Visualizer ---

function resizeCanvas() {
    canvas.width = karaokeView.clientWidth * 0.6;
    canvas.height = 150;
}

function drawVisualizer() {
    if (karaokeView.style.display === 'none') return;

    const width = canvas.width;
    const height = canvas.height;

    canvasCtx.clearRect(0, 0, width, height);

    const stems = ['bass', 'drums', 'other', 'vocals'];
    const colors = ['#ff00f0', '#00f0ff', '#a0a0a8', '#ffffff']; // specific colors

    const barWidth = (width / 64) - 2;

    // We intertwine frequency data to make a mixed visualization
    let arrays = {};
    stems.forEach(stem => {
        if (analysers[stem]) {
            arrays[stem] = new Uint8Array(analysers[stem].frequencyBinCount);
            analysers[stem].getByteFrequencyData(arrays[stem]);
        }
    });

    let x = 0;
    for (let i = 0; i < 64; i++) {
        // rotate between stems for each bar to give a composite look
        const stemIdx = i % 4;
        const stem = stems[stemIdx];
        const color = colors[stemIdx];

        let val = 0;
        if (arrays[stem]) {
            val = arrays[stem][Math.floor(i / 4)];
        }

        const barHeight = (val / 255) * height;

        canvasCtx.fillStyle = color;
        canvasCtx.fillRect(x, height - barHeight, barWidth, barHeight);

        x += barWidth + 2;
    }
}


// Init
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    resizeCanvas();
});
