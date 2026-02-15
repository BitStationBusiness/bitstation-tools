// Z-Image Turbo frontend logic
(function () {
  'use strict';

  const chat = document.getElementById('chat');
  const emptyState = document.getElementById('emptyState');
  const input = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const workersCount = document.getElementById('workersCount');
  const sizeButtons = Array.from(document.querySelectorAll('.size-btn'));
  const chips = Array.from(document.querySelectorAll('.chip'));

  const zoomOverlay = document.getElementById('zoomOverlay');
  const zoomImg = document.getElementById('zoomImg');

  let selectedSize = 'M';
  let generating = false;
  let currentJobId = null;
  let pollTimer = null;

  const SIZE_MAP = {
    S: { width: 512, height: 512 },
    M: { width: 768, height: 768 },
    B: { width: 1024, height: 1024 },
  };

  document.addEventListener('DOMContentLoaded', () => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });

    sizeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (generating) return;
        selectedSize = btn.dataset.size || 'M';
        updateSizeSelection();
      });
    });

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const prompt = decodeHtml(chip.dataset.prompt || '');
        input.value = prompt;
        input.focus();
      });
    });

    initBridgeInfo();
    updateSizeSelection();
    updateEmptyState();
  });

  async function initBridgeInfo() {
    try {
      await ToolBridge.handshake();
    } catch (_) { }

    if (workersCount) {
      workersCount.textContent = '0';
    }
  }

  function decodeHtml(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  function updateSizeSelection() {
    sizeButtons.forEach((btn) => {
      const isActive = (btn.dataset.size || '') === selectedSize;
      btn.classList.toggle('active', isActive);
    });
  }

  function updateEmptyState() {
    if (!emptyState) return;
    emptyState.style.display = chat.childElementCount === 0 ? 'flex' : 'none';
  }

  window.submitPrompt = async function () {
    const prompt = input.value.trim();
    if (!prompt || generating) return;

    const size = SIZE_MAP[selectedSize] || SIZE_MAP.M;

    addUserMessage(prompt);
    input.value = '';
    generating = true;
    sendBtn.disabled = true;

    const spinnerEl = addSpinner();

    try {
      const result = await ToolBridge.submitJob({
        prompt: prompt,
        width: size.width,
        height: size.height,
        steps: 4,
        guidance_scale: 1.0,
      });

      const jobId = result.job_id || result.jobId;
      if (!jobId) throw new Error('No job_id in response');

      currentJobId = jobId;
      spinnerEl.querySelector('.spinner-text').textContent = 'Generando...';
      startPolling(jobId, spinnerEl);
    } catch (err) {
      removeEl(spinnerEl);
      addErrorMessage('No se pudo enviar: ' + err.message);
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
      } catch (_) { }
    }, 1000);
  }

  function handleResult(status) {
    const output = status.output || status.result || {};
    // Priority: file_url (HQ CDN) > image_url (local server) > image_base64 > imageBase64 > image
    let imageData =
      output.file_url ||
      output.image_url ||
      output.image_base64 ||
      output.imageBase64 ||
      output.image;

    if (!imageData && typeof output === 'string' && output.length > 100) {
      imageData = output;
    }

    if (!imageData) {
      addErrorMessage('Termino el job pero no llego imagen.');
      return;
    }

    // If it's a URL (http/https) or data URL, use directly; otherwise treat as base64
    const src =
      imageData.startsWith('data:') || imageData.startsWith('http')
        ? imageData
        : 'data:image/png;base64,' + imageData;

    addImageMessage(src);
  }

  window.cancelJob = async function () {
    if (!currentJobId) return;

    try {
      await ToolBridge.cancelJob(currentJobId);
    } catch (_) { }

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
  }

  function addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = text;
    chat.appendChild(el);
    updateEmptyState();
    scrollToBottom();
  }

  function addBotMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg bot';
    el.textContent = text;
    chat.appendChild(el);
    updateEmptyState();
    scrollToBottom();
  }

  function addErrorMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg error';
    el.textContent = text;
    chat.appendChild(el);
    updateEmptyState();
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
    img.alt = 'Imagen generada';
    imgWrap.appendChild(img);
    wrap.appendChild(imgWrap);

    const actions = document.createElement('div');
    actions.className = 'image-actions';

    actions.appendChild(
      buildImageActionButton(
        '<svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>',
        'Compartir',
        async () => {
          await shareImage(src);
        },
      ),
    );

    actions.appendChild(
      buildImageActionButton(
        '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
        'Copiar',
        async () => {
          await copyImage(src);
        },
      ),
    );

    actions.appendChild(
      buildImageActionButton(
        '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
        'Descargar',
        async () => {
          await downloadImage(src);
        },
      ),
    );

    wrap.appendChild(actions);
    chat.appendChild(wrap);
    updateEmptyState();
    scrollToBottom();
  }

  function buildImageActionButton(icon, label, onClick) {
    const button = document.createElement('button');
    button.innerHTML = icon + ' ' + label;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await onClick();
      } catch (_) { }
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
    updateEmptyState();
    scrollToBottom();
    return el;
  }

  async function copyImage(src) {
    if (ToolBridge.isShellMode()) {
      try {
        await ToolBridge.copyImage(src);
        toast('Imagen copiada');
        return;
      } catch (_) { }
    }

    try {
      const blob = await fetch(src).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      toast('Imagen copiada');
    } catch (_) {
      toast('No se pudo copiar');
    }
  }

  async function downloadImage(src) {
    const fileName = buildFileName(src);

    if (ToolBridge.isShellMode()) {
      try {
        await ToolBridge.downloadImage(src, fileName);
        toast('Imagen guardada');
        return;
      } catch (_) { }
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
      toast('Descarga iniciada');
    } catch (_) {
      toast('No se pudo descargar');
    }
  }

  async function shareImage(src) {
    if (ToolBridge.isShellMode()) {
      try {
        await ToolBridge.shareImage(src);
        return;
      } catch (_) { }
    }

    try {
      if (navigator.share && navigator.canShare) {
        const blob = await fetch(src).then((r) => r.blob());
        const file = new File([blob], buildFileName(src), { type: blob.type || 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: 'Z-Image',
            text: 'Imagen generada con Z-Image',
            files: [file],
          });
          return;
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
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
    return `z-image-${timestamp}.${ext}`;
  }

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '90px',
      transform: 'translateX(-50%)',
      background: 'rgba(21,22,28,0.95)',
      border: '1px solid rgba(255,255,255,0.22)',
      borderRadius: '999px',
      color: '#f1f3f7',
      fontSize: '13px',
      padding: '8px 14px',
      zIndex: '99999',
    });
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 250);
    }, 1400);
  }

  window.goBack = async function () {
    if (ToolBridge.isShellMode()) {
      try {
        await ToolBridge.closeFrontend();
        return;
      } catch (_) { }
    }

    if (window.history.length > 1) {
      window.history.back();
    }
  };

  function openZoom(src) {
    zoomImg.src = src;
    zoomOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  window.closeZoom = function () {
    zoomOverlay.classList.remove('active');
    document.body.style.overflow = '';
    zoomImg.src = '';
  };

  zoomOverlay.addEventListener('click', (e) => {
    if (e.target === zoomOverlay) {
      closeZoom();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && zoomOverlay.classList.contains('active')) {
      closeZoom();
    }
  });

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chat.scrollTop = chat.scrollHeight;
    });
  }

  function removeEl(el) {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }
})();
