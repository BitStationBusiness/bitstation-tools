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
    setupWheelScroll();
  });

  function setupWheelScroll() {
    document.addEventListener('wheel', function (e) {
      var content = document.getElementById('content');
      if (!content) return;
      content.scrollTop += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  // Called from Flutter DropTarget when files are dragged onto the WebView
  window.onFilesDropped = function (paths) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    selectedFiles = paths;
    renderFileList();
  };

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
    });
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

  let discCoverCount = 0;

  async function resolveImageUrl(filePath) {
    try {
      const res = await ToolBridge.getFileUrl(filePath);
      if (res && res.ok && res.url) return res.url;
    } catch (_) {}
    return 'file:///' + filePath.replace(/\\/g, '/');
  }

  window.pickAlbumCover = async function () {
    try {
      const result = await ToolBridge.pickFiles({ extensions: ['jpg', 'jpeg', 'png', 'webp'], multiple: false });
      const files = result.files || [];
      if (files.length > 0) {
        document.getElementById('albumCoverPath').value = files[0];
        const url = await resolveImageUrl(files[0]);
        const box = document.getElementById('albumCoverPicker');
        document.getElementById('albumCoverPreview').innerHTML = '<img src="' + url + '" alt="Cover">';
        box.classList.add('has-cover');
      }
    } catch (e) {
      console.error('[BM] pickAlbumCover error:', e);
    }
  };

  window.addDiscCover = async function () {
    discCoverCount++;
    const num = discCoverCount;
    const container = document.getElementById('discCoversContainer');

    const item = document.createElement('div');
    item.className = 'disc-cover-item';
    item.id = 'disc_item_' + num;
    item.innerHTML =
      '<div class="disc-cover-thumb" onclick="pickDiscCover(' + num + ')" id="disc_thumb_' + num + '">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="#555"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>' +
      '</div>' +
      '<input type="hidden" id="disc_cover_' + num + '" data-path="">' +
      '<span class="disc-cover-label">CD ' + num + '</span>' +
      '<button class="disc-cover-remove" onclick="removeDiscCover(' + num + ')">&times;</button>';
    container.appendChild(item);

    try {
      const result = await ToolBridge.pickFiles({ extensions: ['jpg', 'jpeg', 'png', 'webp'], multiple: false });
      const files = result.files || [];
      if (files.length > 0) {
        document.getElementById('disc_cover_' + num).dataset.path = files[0];
        const url = await resolveImageUrl(files[0]);
        const thumb = document.getElementById('disc_thumb_' + num);
        thumb.innerHTML = '<img src="' + url + '" alt="CD' + num + '">';
        thumb.classList.add('has-cover');
      }
    } catch (e) {
      console.error('[BM] addDiscCover error:', e);
    }
  };

  window.pickDiscCover = async function (num) {
    try {
      const result = await ToolBridge.pickFiles({ extensions: ['jpg', 'jpeg', 'png', 'webp'], multiple: false });
      const files = result.files || [];
      if (files.length > 0) {
        document.getElementById('disc_cover_' + num).dataset.path = files[0];
        const url = await resolveImageUrl(files[0]);
        const thumb = document.getElementById('disc_thumb_' + num);
        thumb.innerHTML = '<img src="' + url + '" alt="CD' + num + '">';
        thumb.classList.add('has-cover');
      }
    } catch (e) {
      console.error('[BM] pickDiscCover error:', e);
    }
  };

  window.removeDiscCover = function (num) {
    const item = document.getElementById('disc_item_' + num);
    if (item) item.remove();
  };

  function renderMetadataForm() {
    if (analyzedSongs.length > 0) {
      const first = analyzedSongs[0];
      document.getElementById('albumArtist').value = first.album_artist || first.artist || '';
      document.getElementById('albumTitle').value = first.album || '';
      document.getElementById('albumYear').value = first.year || '';
      document.getElementById('albumGenre').value = first.genre || '';
    }

    // Reset cover state
    document.getElementById('albumCoverPath').value = '';
    document.getElementById('albumCoverPicker').classList.remove('has-cover');
    document.getElementById('albumCoverPreview').innerHTML =
      '<svg viewBox="0 0 24 24" width="40" height="40" fill="#555"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>' +
      '<span>Portada</span>';
    document.getElementById('albumCoverPreview').className = 'album-cover-empty';
    document.getElementById('discCoversContainer').innerHTML = '';
    discCoverCount = 0;

    const container = document.getElementById('tracksContainer');
    container.innerHTML = '';
    analyzedSongs.forEach((song, i) => {
      const card = document.createElement('div');
      card.className = 'track-card';

      const lrcDetected = song.lrc_file || '';
      const lrcLabel = lrcDetected ? lrcDetected.split(/[/\\]/).pop() : 'Sin archivo';

      card.innerHTML =
        '<div class="track-header">Pista ' + (i + 1) + '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>T&iacute;tulo</label><input id="track_title_' + i + '" value="' + escapeAttr(song.title || '') + '"></div>' +
          '<div class="form-group"><label>Artista</label><input id="track_artist_' + i + '" value="' + escapeAttr(song.artist || '') + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label>N&uacute;mero</label><input id="track_num_' + i + '" type="number" value="' + (song.track_number || i + 1) + '"></div>' +
          '<div class="form-group"><label>Disco</label><input id="track_disc_' + i + '" type="number" value="' + (song.disc_number || 1) + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group lrc-group"><label>Lyrics (.lrc)</label>' +
            '<div class="lrc-field">' +
              '<input id="track_lrc_' + i + '" readonly value="' + escapeAttr(lrcLabel) + '" data-path="' + escapeAttr(lrcDetected) + '">' +
              '<button class="btn btn-small" onclick="pickLrc(' + i + ')">Elegir</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      container.appendChild(card);
    });
  }

  window.pickLrc = async function (idx) {
    try {
      const result = await ToolBridge.pickFiles({ extensions: ['lrc'], multiple: false });
      const files = result.files || [];
      if (files.length > 0) {
        const el = document.getElementById('track_lrc_' + idx);
        el.value = files[0].split(/[/\\]/).pop();
        el.dataset.path = files[0];
      }
    } catch (e) {
      console.error('[BM] pickLrc error:', e);
    }
  };

  function gatherAlbumData() {
    const tracks = analyzedSongs.map((song, i) => {
      const lrcEl = document.getElementById('track_lrc_' + i);
      const lrcPath = lrcEl ? (lrcEl.dataset.path || '') : (song.lrc_file || '');
      return {
        ...song,
        title: document.getElementById('track_title_' + i).value,
        artist: document.getElementById('track_artist_' + i).value,
        track_number: parseInt(document.getElementById('track_num_' + i).value) || (i + 1),
        disc_number: parseInt(document.getElementById('track_disc_' + i).value) || 1,
        lrc_file: lrcPath || undefined,
      };
    });

    const trackCount = tracks.length;
    const maxDisc = Math.max(1, ...tracks.map(t => t.disc_number || 1));

    const albumCoverPath = document.getElementById('albumCoverPath').value || '';
    const discCovers = {};
    const dcContainer = document.getElementById('discCoversContainer');
    if (dcContainer) {
      dcContainer.querySelectorAll('input[id^="disc_cover_"]').forEach(input => {
        if (input.dataset.path) {
          const num = input.id.replace('disc_cover_', '');
          discCovers[num] = input.dataset.path;
        }
      });
    }

    return {
      album_artist: document.getElementById('albumArtist').value,
      album_name: document.getElementById('albumTitle').value,
      year: document.getElementById('albumYear').value,
      genre: document.getElementById('albumGenre').value,
      release_date: document.getElementById('albumYear').value,
      total_tracks: trackCount,
      total_discs: maxDisc,
      cover_image_path: albumCoverPath || undefined,
      disc_covers: Object.keys(discCovers).length > 0 ? discCovers : undefined,
      songs: tracks,
    };
  }

  // --- Step 3: Build ---

  async function renderBuildSummary() {
    const data = gatherAlbumData();
    const summary = document.getElementById('buildSummary');
    let coverHtml = '<span class="no-cover">Sin portada</span>';
    if (data.cover_image_path) {
      const url = await resolveImageUrl(data.cover_image_path);
      coverHtml = '<img src="' + url + '" class="summary-cover">';
    }
    const dcCount = data.disc_covers ? Object.keys(data.disc_covers).length : 0;

    summary.innerHTML =
      '<div class="summary-header">' + coverHtml +
      '<div class="summary-meta">' +
      '<div><span class="label">Artista:</span> <span class="value">' + escapeHtml(data.album_artist) + '</span></div>' +
      '<div><span class="label">&Aacute;lbum:</span> <span class="value">' + escapeHtml(data.album_name) + '</span></div>' +
      '<div><span class="label">A&ntilde;o:</span> <span class="value">' + escapeHtml(data.year) + '</span></div>' +
      '<div><span class="label">G&eacute;nero:</span> <span class="value">' + escapeHtml(data.genre) + '</span></div>' +
      '<div><span class="label">Pistas:</span> <span class="value">' + data.songs.length + '</span></div>' +
      '<div><span class="label">Discos:</span> <span class="value">' + data.total_discs + '</span></div>' +
      (dcCount > 0 ? '<div><span class="label">Portadas de disco:</span> <span class="value">' + dcCount + '</span></div>' : '') +
      '</div></div>' +
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
