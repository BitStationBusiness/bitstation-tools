// Z-Image Turbo frontend logic
(function () {
  'use strict';

  const chat = document.getElementById('chat');
  const input = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const sizeSelect = document.getElementById('sizeSelect');
  const logPanel = document.getElementById('logPanel');
  const logToggle = document.getElementById('logToggle');
  const suggestions = document.getElementById('suggestions');

  const zoomOverlay = document.getElementById('zoomOverlay');
  const zoomImg = document.getElementById('zoomImg');

  let generating = false;
  let currentJobId = null;
  let pollTimer = null;

  document.addEventListener('DOMContentLoaded', () => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });

    document.querySelectorAll('.suggestion-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.prompt || '';
        input.focus();
      });
    });

    addBotMessage('Listo para crear. Describe una imagen o elige una sugerencia.');
  });

  window.submitPrompt = async function () {
    const prompt = input.value.trim();
    if (!prompt || generating) return;

    const size = sizeSelect.value.split('x');
    const width = parseInt(size[0], 10) || 512;
    const height = parseInt(size[1], 10) || 512;

    addUserMessage(prompt);
    input.value = '';
    suggestions.style.display = 'none';

    generating = true;
    sendBtn.disabled = true;
    const spinnerEl = addSpinner();

    log(`Submitting: "${prompt}" (${width}x${height})`);

    try {
      const result = await ToolBridge.submitJob({
        prompt: prompt,
        width: width,
        height: height,
        steps: 4,
        guidance_scale: 1.0,
      });

      const jobId = result.job_id || result.jobId;
      if (!jobId) throw new Error('No job_id in response');

      currentJobId = jobId;
      log(`Job submitted: ${jobId}`);
      spinnerEl.querySelector('.spinner-text').textContent = 'Generando...';
      startPolling(jobId, spinnerEl);
    } catch (err) {
      removeEl(spinnerEl);
      addErrorMessage('No se pudo enviar el job: ' + err.message);
      log('ERROR: ' + err.message);
      resetState();
    }
  };

  function startPolling(jobId, spinnerEl) {
    let attempts = 0;
    const maxAttempts = 180;

    pollTimer = setInterval(async () => {
      attempts += 1;
      if (attempts > maxAttempts) {
        clearInterval(pollTimer);
        removeEl(spinnerEl);
        addErrorMessage('La generacion excedio el tiempo limite.');
        resetState();
        return;
      }

      try {
        const status = await ToolBridge.jobStatus(jobId);
        const state = (status.status || status.state || '').toLowerCase();

        log(`Poll #${attempts}: ${state}`);

        if (state === 'completed' || state === 'done') {
          clearInterval(pollTimer);
          removeEl(spinnerEl);
          handleResult(status);
          resetState();
          return;
        }

        if (state === 'failed' || state === 'error') {
          clearInterval(pollTimer);
          removeEl(spinnerEl);
          addErrorMessage('Fallo la generacion: ' + (status.error || 'Error desconocido'));
          resetState();
        }
      } catch (err) {
        log('Poll error: ' + err.message);
      }
    }, 1000);
  }

  function handleResult(status) {
    const output = status.output || status.result || {};
    let imageData = output.image_base64 || output.image || output.imageBase64;

    if (!imageData && typeof output === 'string' && output.length > 100) {
      imageData = output;
    }

    if (!imageData) {
      addBotMessage('Finalizo el trabajo, pero no llego imagen.');
      log('No image data in response.');
      return;
    }

    const src = imageData.startsWith('data:')
      ? imageData
      : 'data:image/png;base64,' + imageData;

    addImageMessage(src);
    log('Image received');
  }

  window.cancelJob = async function () {
    if (!currentJobId) return;
    try {
      await ToolBridge.cancelJob(currentJobId);
      log('Job cancelled: ' + currentJobId);
    } catch (e) {
      log('Cancel error: ' + e.message);
    }
    if (pollTimer) clearInterval(pollTimer);

    const spinner = chat.querySelector('.spinner-wrap');
    if (spinner) removeEl(spinner);

    addBotMessage('Generacion cancelada.');
    resetState();
  };

  function resetState() {
    generating = false;
    currentJobId = null;
    sendBtn.disabled = false;
    suggestions.style.display = 'flex';
  }

  function addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = text;
    chat.appendChild(el);
    scrollToBottom();
  }

  function addBotMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg bot';
    el.textContent = text;
    chat.appendChild(el);
    scrollToBottom();
  }

  function addErrorMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg error';
    el.textContent = 'Warning: ' + text;
    chat.appendChild(el);
    scrollToBottom();
  }

  function addImageMessage(src) {
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'msg-image-wrap';
    imgWrap.addEventListener('click', () => openZoom(src));

    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Generated image';
    imgWrap.appendChild(img);
    wrap.appendChild(imgWrap);

    const actions = document.createElement('div');
    actions.className = 'image-actions';

    actions.appendChild(
      buildImageActionButton(
        'share-btn',
        '<svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>',
        'Compartir',
        async () => {
          await shareImage(src);
        },
      ),
    );

    actions.appendChild(
      buildImageActionButton(
        'copy-btn',
        '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
        'Copiar',
        async () => {
          await copyImage(src);
        },
      ),
    );

    actions.appendChild(
      buildImageActionButton(
        'download-btn',
        '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
        'Descargar',
        async () => {
          await downloadImage(src);
        },
      ),
    );

    wrap.appendChild(actions);
    chat.appendChild(wrap);
    scrollToBottom();
  }

  function buildImageActionButton(className, iconSvg, label, onClick) {
    const button = document.createElement('button');
    button.className = className;
    button.innerHTML = iconSvg + ' ' + label;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await onClick();
      } catch (err) {
        log('Action error: ' + err.message);
      }
    });
    return button;
  }

  function addSpinner() {
    const el = document.createElement('div');
    el.className = 'spinner-wrap';
    el.innerHTML = [
      '<div class="neon-spinner"></div>',
      '<span class="spinner-text">Enviando...</span>',
      '<button class="cancel-btn" onclick="cancelJob()">Cancelar</button>',
    ].join('');
    chat.appendChild(el);
    scrollToBottom();
    return el;
  }

  async function copyImage(src) {
    if (ToolBridge.isShellMode()) {
      try {
        await ToolBridge.copyImage(src);
        showToast('Imagen copiada al portapapeles');
        return;
      } catch (err) {
        log('Native copy failed: ' + err.message);
      }
    }

    try {
      const blob = await fetch(src).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      showToast('Imagen copiada al portapapeles');
    } catch (err) {
      showToast('No se pudo copiar la imagen');
    }
  }

  async function downloadImage(src) {
    const fileName = buildFileName(src);

    if (ToolBridge.isShellMode()) {
      try {
        await ToolBridge.downloadImage(src, fileName);
        showToast('Imagen guardada correctamente');
        return;
      } catch (err) {
        log('Native download failed: ' + err.message);
      }
    }

    try {
      const blob = await fetch(src).then((r) => r.blob());
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      showToast('Descarga iniciada');
    } catch (err) {
      showToast('No se pudo descargar la imagen');
    }
  }

  async function shareImage(src) {
    if (ToolBridge.isShellMode()) {
      try {
        await ToolBridge.shareImage(src);
        return;
      } catch (err) {
        log('Native share failed: ' + err.message);
      }
    }

    try {
      if (navigator.share && navigator.canShare) {
        const blob = await fetch(src).then((r) => r.blob());
        const file = new File([blob], buildFileName(src), { type: blob.type || 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: 'Z-Image Turbo',
            text: 'Imagen generada con Z-Image Turbo',
            files: [file],
          });
          return;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    }

    await copyImage(src);
  }

  function buildFileName(src) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = src.startsWith('data:image/jpeg')
      ? 'jpg'
      : src.startsWith('data:image/webp')
      ? 'webp'
      : src.startsWith('data:image/gif')
      ? 'gif'
      : 'png';
    return `z-image-turbo-${timestamp}.${ext}`;
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '80px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 20px',
      background: 'rgba(0,229,255,0.15)',
      border: '1px solid rgba(0,229,255,0.3)',
      borderRadius: '8px',
      color: '#00e5ff',
      fontSize: '0.8rem',
      fontFamily: 'Inter, sans-serif',
      backdropFilter: 'blur(10px)',
      zIndex: '20000',
    });
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  let zoomScale = 1;
  let zoomX = 0;
  let zoomY = 0;
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };

  function openZoom(src) {
    zoomImg.src = src;
    zoomScale = 1;
    zoomX = 0;
    zoomY = 0;
    applyZoomTransform();
    zoomOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  window.closeZoom = function () {
    zoomOverlay.classList.remove('active');
    document.body.style.overflow = '';
    zoomImg.src = '';
  };

  function applyZoomTransform() {
    zoomImg.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
  }

  zoomOverlay.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      const newScale = Math.max(1, zoomScale + delta);
      if (newScale !== zoomScale) {
        if (newScale === 1) {
          zoomX = 0;
          zoomY = 0;
        }
        zoomScale = newScale;
        applyZoomTransform();
      }
    },
    { passive: false },
  );

  zoomOverlay.addEventListener('click', (e) => {
    if (e.target === zoomOverlay) closeZoom();
  });

  zoomImg.addEventListener('mousedown', (e) => {
    if (zoomScale <= 1) return;
    e.preventDefault();
    isDragging = true;
    dragStart = { x: e.clientX - zoomX, y: e.clientY - zoomY };
    zoomImg.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    zoomX = e.clientX - dragStart.x;
    zoomY = e.clientY - dragStart.y;
    applyZoomTransform();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      zoomImg.style.cursor = '';
    }
  });

  let lastTouchDist = 0;

  zoomImg.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        lastTouchDist = getTouchDistance(e.touches);
      } else if (e.touches.length === 1 && zoomScale > 1) {
        isDragging = true;
        dragStart = { x: e.touches[0].clientX - zoomX, y: e.touches[0].clientY - zoomY };
      }
    },
    { passive: true },
  );

  zoomImg.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const dist = getTouchDistance(e.touches);
        const scale = dist / lastTouchDist;
        const newScale = Math.max(1, zoomScale * scale);
        if (newScale === 1) {
          zoomX = 0;
          zoomY = 0;
        }
        zoomScale = newScale;
        lastTouchDist = dist;
        applyZoomTransform();
      } else if (e.touches.length === 1 && isDragging) {
        zoomX = e.touches[0].clientX - dragStart.x;
        zoomY = e.touches[0].clientY - dragStart.y;
        applyZoomTransform();
      }
    },
    { passive: false },
  );

  zoomImg.addEventListener(
    'touchend',
    () => {
      isDragging = false;
      lastTouchDist = 0;
    },
    { passive: true },
  );

  function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && zoomOverlay.classList.contains('active')) {
      closeZoom();
    }
  });

  window.toggleLogs = function () {
    logPanel.classList.toggle('open');
    logToggle.textContent = logPanel.classList.contains('open') ? '▾ LOGS' : '▸ LOGS';
  };

  function log(msg) {
    const ts = new Date().toLocaleTimeString();
    logPanel.textContent += `[${ts}] ${msg}\n`;
    logPanel.scrollTop = logPanel.scrollHeight;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chat.scrollTop = chat.scrollHeight;
    });
  }

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
})();
