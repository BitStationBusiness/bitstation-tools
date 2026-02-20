// BM-Generator frontend logic
(function () {
  'use strict';

  let currentStep = 1;
  let selectedFiles = [];
  let analyzedSongs = [];
  let buildJobId = null;
  let pollTimer = null;

  const panels = [null, document.getElementById('panel1'), document.getElementById('panel2'), document.getElementById('panel3')];
  const dots = [null, document.getElementById('stepDot1'), document.getElementById('stepDot2'), document.getElementById('stepDot3')];
  const lines = [null, document.getElementById('stepLine1'), document.getElementById('stepLine2')];

  document.addEventListener('DOMContentLoaded', async () => {
    try { await ToolBridge.handshake(); } catch (e) { /* ignore */ }
    setupDragDrop();
  });

  // --- Navigation ---

  window.goToStep = function (step) {
    currentStep = step;
    panels.forEach((p, i) => { if (p) p.classList.toggle('active', i === step); });
    dots.forEach((d, i) => {
      if (!d) return;
      d.classList.remove('active', 'done');
      if (i < step) d.classList.add('done');
      else if (i === step) d.classList.add('active');
    });
    lines.forEach((l, i) => {
      if (!l) return;
      l.classList.toggle('done', i < step);
    });
    if (step === 3) renderBuildSummary();
  };

  window.goBack = async function () {
    if (ToolBridge.isShellMode()) {
      try { await ToolBridge.closeFrontend(); return; } catch (e) { /* ignore */ }
    }
    if (window.history.length > 1) window.history.back();
  };

  // --- Step 1: Upload ---

  function setupDragDrop() {
    const zone = document.getElementById('dropZone');
    if (!zone) return;
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      // WebView2 does not expose full file paths via drag-and-drop for security.
      // Show user feedback to use the button instead.
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        const names = Array.from(dt.files).map(f => f.name).join(', ');
        alert('Para agregar archivos, usa el boton "Seleccionar archivos".\n\nArchivos detectados: ' + names);
      }
    });
    // Also make the zone clickable
    zone.addEventListener('click', () => pickAudioFiles());
  }

  window.pickAudioFiles = async function () {
    try {
      const result = await ToolBridge.pickFiles({
        extensions: ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a'],
        multiple: true,
      });
      const files = result.files || [];
      if (files.length > 0) {
        selectedFiles = files;
        renderFileList();
      }
    } catch (e) {
      console.error('[BM] pickFiles error:', e);
    }
  };

  function renderFileList() {
    const list = document.getElementById('fileList');
    list.innerHTML = '';
    selectedFiles.forEach((f, i) => {
      const name = f.split(/[/\\]/).pop();
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = '<span class="name">' + escapeHtml(name) + '</span>' +
        '<button class="remove" onclick="removeFile(' + i + ')">&#x2715;</button>';
      list.appendChild(item);
    });
    document.getElementById('analyzeBtn').disabled = selectedFiles.length === 0;
  }

  window.removeFile = function (idx) {
    selectedFiles.splice(idx, 1);
    renderFileList();
  };

  window.startAnalyze = async function () {
    if (selectedFiles.length === 0) return;
    const btn = document.getElementById('analyzeBtn');
    btn.disabled = true;
    btn.textContent = 'Analizando...';

    try {
      const result = await ToolBridge.submitJob({ action: 'analyze', files: selectedFiles });
      const jobId = result.job_id || result.jobId;
      if (!jobId) throw new Error('No job_id');
      await waitForJob(jobId, (status) => {
        const output = status.output || status.result || {};
        if (output.analyzed_songs) {
          analyzedSongs = output.analyzed_songs;
          renderMetadataForm();
          goToStep(2);
        } else {
          alert('El analisis no devolvio canciones.');
        }
      });
    } catch (e) {
      alert('Error al analizar: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Analizar &rarr;';
    }
  };

  // --- Step 2: Metadata ---

  function renderMetadataForm() {
    if (analyzedSongs.length > 0) {
      const first = analyzedSongs[0];
      document.getElementById('albumArtist').value = first.album_artist || first.artist || '';
      document.getElementById('albumTitle').value = first.album || '';
      document.getElementById('albumYear').value = first.year || '';
      document.getElementById('albumGenre').value = first.genre || '';
    }

    const container = document.getElementById('tracksContainer');
    container.innerHTML = '';
    analyzedSongs.forEach((song, i) => {
      const card = document.createElement('div');
      card.className = 'track-card';
      card.innerHTML =
        '<div class="track-header">Pista ' + (i + 1) + '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>T&iacute;tulo</label><input id="track_title_' + i + '" value="' + escapeAttr(song.title || '') + '"></div>' +
          '<div class="form-group"><label>Artista</label><input id="track_artist_' + i + '" value="' + escapeAttr(song.artist || '') + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>N&uacute;mero</label><input id="track_num_' + i + '" type="number" value="' + (song.track_number || i + 1) + '"></div>' +
          '<div class="form-group"><label>Disco</label><input id="track_disc_' + i + '" type="number" value="' + (song.disc_number || 1) + '"></div>' +
        '</div>';
      container.appendChild(card);
    });
  }

  function gatherAlbumData() {
    const tracks = analyzedSongs.map((song, i) => ({
      ...song,
      title: document.getElementById('track_title_' + i).value,
      artist: document.getElementById('track_artist_' + i).value,
      track_number: parseInt(document.getElementById('track_num_' + i).value) || (i + 1),
      disc_number: parseInt(document.getElementById('track_disc_' + i).value) || 1,
    }));

    const trackCount = tracks.length;
    const maxDisc = Math.max(1, ...tracks.map(t => t.disc_number || 1));
    return {
      album_artist: document.getElementById('albumArtist').value,
      album_name: document.getElementById('albumTitle').value,
      year: document.getElementById('albumYear').value,
      genre: document.getElementById('albumGenre').value,
      release_date: document.getElementById('albumYear').value,
      total_tracks: trackCount,
      total_discs: maxDisc,
      songs: tracks,
    };
  }

  // --- Step 3: Build ---

  function renderBuildSummary() {
    const data = gatherAlbumData();
    const summary = document.getElementById('buildSummary');
    summary.innerHTML =
      '<div><span class="label">Artista:</span> <span class="value">' + escapeHtml(data.album_artist) + '</span></div>' +
      '<div><span class="label">&Aacute;lbum:</span> <span class="value">' + escapeHtml(data.title) + '</span></div>' +
      '<div><span class="label">A&ntilde;o:</span> <span class="value">' + escapeHtml(data.year) + '</span></div>' +
      '<div><span class="label">G&eacute;nero:</span> <span class="value">' + escapeHtml(data.genre) + '</span></div>' +
      '<div><span class="label">Pistas:</span> <span class="value">' + data.tracks.length + '</span></div>' +
      '<div style="margin-top:8px;font-size:12px;color:var(--muted)">Cada pista sera separada en 4 stems: drums, bass, vocals, other (Demucs htdemucs)</div>';
  }

  window.startBuild = async function () {
    const btn = document.getElementById('buildBtn');
    const backBtn = document.getElementById('buildBackBtn');
    btn.disabled = true;
    btn.textContent = 'Construyendo...';
    backBtn.disabled = true;

    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const buildStatus = document.getElementById('buildStatus');
    progressBar.style.display = 'block';
    progressFill.style.width = '10%';
    buildStatus.textContent = 'Iniciando construccion del .bm...';

    try {
      const albumData = gatherAlbumData();
      const result = await ToolBridge.submitJob({ action: 'build', album_data: albumData });
      const jobId = result.job_id || result.jobId;
      if (!jobId) throw new Error('No job_id');

      await waitForJob(jobId, (status) => {
        progressFill.style.width = '100%';
        const output = status.output || status.result || {};
        if (output.bm_file_path) {
          buildStatus.innerHTML = 'Archivo generado: <strong>' + escapeHtml(output.bm_file_path) + '</strong>';
        } else {
          buildStatus.textContent = 'Construccion completada.';
        }
        btn.textContent = 'Completado';
      }, (progress) => {
        const pct = Math.min(10 + progress * 85, 95);
        progressFill.style.width = pct + '%';
      });
    } catch (e) {
      buildStatus.textContent = 'Error: ' + e.message;
      progressFill.style.width = '0%';
      btn.innerHTML = 'Reintentar';
      btn.disabled = false;
    } finally {
      backBtn.disabled = false;
    }
  };

  // --- Polling utility ---

  function waitForJob(jobId, onDone, onProgress) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      pollTimer = setInterval(async () => {
        attempts++;
        if (attempts > 600) {
          clearInterval(pollTimer);
          reject(new Error('Timeout'));
          return;
        }
        try {
          const status = await ToolBridge.jobStatus(jobId);
          const state = (status.status || status.state || '').toLowerCase();
          if (state === 'completed' || state === 'done') {
            clearInterval(pollTimer);
            onDone(status);
            resolve(status);
            return;
          }
          if (state === 'failed' || state === 'error') {
            clearInterval(pollTimer);
            reject(new Error(status.error || 'Job failed'));
            return;
          }
          if (onProgress && status.progress != null) {
            onProgress(status.progress);
          }
        } catch (e) { /* retry */ }
      }, 1500);
    });
  }

  // --- Utilities ---

  function escapeHtml(s) {
    const el = document.createElement('div');
    el.textContent = s || '';
    return el.innerHTML;
  }

  function escapeAttr(s) {
    return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
})();
