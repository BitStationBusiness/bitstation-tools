// Z-Image Turbo frontend logic
(function () {
  'use strict';

  const chat = document.getElementById('chat');
  const emptyState = document.getElementById('emptyState');
  const input = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const sendIcon = document.getElementById('sendIcon');
  const stopIcon = document.getElementById('stopIcon');
  const chips = Array.from(document.querySelectorAll('.chip'));

  const zoomOverlay = document.getElementById('zoomOverlay');
  const zoomImg = document.getElementById('zoomImg');

  const settingsOverlay = document.getElementById('settingsOverlay');
  const presetBtns = Array.from(document.querySelectorAll('.preset-btn'));
  const customResDiv = document.getElementById('customResolution');
  const customWidthInput = document.getElementById('customWidth');
  const customHeightInput = document.getElementById('customHeight');
  const customResPreview = document.getElementById('customResPreview');
  const stepsSlider = document.getElementById('stepsSlider');
  const stepsValue = document.getElementById('stepsValue');
  const guidanceSlider = document.getElementById('guidanceSlider');
  const guidanceInput = document.getElementById('guidanceInput');
  const guidanceValue = document.getElementById('guidanceValue');

  let generating = false;
  let currentJobId = null;
  let pollTimer = null;
  let lastPrompt = '';

  // Chat state for persistence
  let chatMessages = [];

  // --- Settings state ---
  const STORAGE_KEY = 'zimage-settings';
  const SIZE_MAP = {
    S: { width: 512, height: 512 },
    M: { width: 768, height: 768 },
    B: { width: 1024, height: 1024 },
  };
  const DEFAULTS = {
    preset: 'M',
    customWidth: 768,
    customHeight: 768,
    steps: 6,
    guidance: 1.0,
  };

  let settings = loadSettings();

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return {
          preset: ['S', 'M', 'B', 'C'].includes(s.preset) ? s.preset : DEFAULTS.preset,
          customWidth: roundTo64(clamp(parseInt(s.customWidth) || DEFAULTS.customWidth, 256, 2048)),
          customHeight: roundTo64(clamp(parseInt(s.customHeight) || DEFAULTS.customHeight, 256, 2048)),
          steps: clamp(parseInt(s.steps) || DEFAULTS.steps, 1, 15),
          guidance: clampF(parseFloat(s.guidance), 0, 10) || DEFAULTS.guidance,
        };
      }
    } catch (e) { /* ignore */ }
    return { ...DEFAULTS };
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function getResolution() {
    if (settings.preset === 'C') return { width: settings.customWidth, height: settings.customHeight };
    return SIZE_MAP[settings.preset] || SIZE_MAP.M;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function clampF(v, min, max) { return isNaN(v) ? null : Math.max(min, Math.min(max, v)); }
  function roundTo64(v) { return Math.round(v / 64) * 64 || 256; }

  // --- Settings UI ---

  window.openSettings = function () { syncSettingsUI(); settingsOverlay.classList.add('active'); };
  window.closeSettings = function () { settingsOverlay.classList.remove('active'); };
  window.closeSettingsOnBackdrop = function (e) { if (e.target === settingsOverlay) closeSettings(); };

  function syncSettingsUI() {
    presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === settings.preset));
    customResDiv.style.display = settings.preset === 'C' ? 'block' : 'none';
    customWidthInput.value = settings.customWidth;
    customHeightInput.value = settings.customHeight;
    updateCustomPreview();
    stepsSlider.value = settings.steps;
    stepsValue.textContent = settings.steps;
    guidanceSlider.value = Math.round(settings.guidance * 10);
    guidanceInput.value = settings.guidance.toFixed(1);
    guidanceValue.textContent = settings.guidance.toFixed(1);
  }

  window.selectPreset = function (preset) {
    settings.preset = preset;
    presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
    customResDiv.style.display = preset === 'C' ? 'block' : 'none';
    saveSettings();
  };

  window.onCustomResChange = function () {
    let w = parseInt(customWidthInput.value) || 768;
    let h = parseInt(customHeightInput.value) || 768;
    settings.customWidth = roundTo64(clamp(w, 256, 2048));
    settings.customHeight = roundTo64(clamp(h, 256, 2048));
    updateCustomPreview();
    saveSettings();
  };

  function updateCustomPreview() {
    if (customResPreview) customResPreview.textContent = `Resultado: ${settings.customWidth} × ${settings.customHeight}`;
  }

  window.onStepsChange = function (val) { settings.steps = clamp(parseInt(val) || 6, 1, 15); stepsValue.textContent = settings.steps; saveSettings(); };
  window.onGuidanceSlider = function (val) {
    const g = clamp(parseInt(val) || 0, 0, 50) / 10;
    settings.guidance = parseFloat(g.toFixed(1));
    guidanceInput.value = settings.guidance.toFixed(1);
    guidanceValue.textContent = settings.guidance.toFixed(1);
    saveSettings();
  };
  window.onGuidanceInput = function (val) {
    let g = parseFloat(val);
    if (isNaN(g)) return;
    if (g < 0) g = 0;
    if (g > 10) { guidanceInput.value = '10.0'; g = 10; }
    settings.guidance = parseFloat(g.toFixed(1));
    guidanceSlider.value = Math.min(Math.round(settings.guidance * 10), 50);
    guidanceValue.textContent = settings.guidance.toFixed(1);
    saveSettings();
  };
  window.resetSettings = function () { settings = { ...DEFAULTS }; saveSettings(); syncSettingsUI(); };

  window.clearChatHistory = async function () {
    if (!confirm('¿Borrar todo el historial del chat?')) return;
    chatMessages = [];
    chat.innerHTML = '';
    lastHandledJobSrc = null;
    await saveChatState();
    updateEmptyState();
    closeSettings();
  };

  // --- Send button state ---

  function updateSendBtnState() {
    const hasText = input.value.trim().length > 0;
    if (generating) {
      sendBtn.className = 'send-btn stop';
      sendBtn.disabled = false;
      sendIcon.style.display = 'none';
      stopIcon.style.display = 'block';
    } else if (hasText) {
      sendBtn.className = 'send-btn active';
      sendBtn.disabled = false;
      sendIcon.style.display = 'block';
      stopIcon.style.display = 'none';
    } else {
      sendBtn.className = 'send-btn';
      sendBtn.disabled = false;
      sendIcon.style.display = 'block';
      stopIcon.style.display = 'none';
    }
  }

  window.onSendClick = function () {
    if (generating) {
      cancelJob();
    } else {
      submitPrompt();
    }
  };

  // --- Init ---

  document.addEventListener('DOMContentLoaded', () => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); }
    });
    input.addEventListener('input', updateSendBtnState);

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        input.value = decodeHtml(chip.dataset.prompt || '');
        input.focus();
        updateSendBtnState();
      });
    });

    initBridgeInfo();
    updateSendBtnState();
  });

  async function initBridgeInfo() {
    try { await ToolBridge.handshake(); } catch (e) { /* ignore */ }
    await restoreChatHistory();
    await checkPendingResult();
  }

  function decodeHtml(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  function updateEmptyState() {
    if (!emptyState) return;
    emptyState.style.display = chat.childElementCount === 0 ? 'flex' : 'none';
  }

  // --- Chat persistence ---

  async function saveChatState() {
    try {
      await ToolBridge.call('save_chat_history', { data: JSON.stringify(chatMessages) });
    } catch (e) { console.warn('[CHAT] save failed:', e); }
  }

  async function restoreChatHistory() {
    try {
      const res = await ToolBridge.call('load_chat_history', {});
      const raw = res && res.history;
      if (!raw) return;
      const msgs = JSON.parse(raw);
      if (!Array.isArray(msgs)) return;
      chatMessages = msgs;
      msgs.forEach(m => {
        if (m.type === 'user') renderUserMsg(m.content);
        else if (m.type === 'image') renderImageMsg(m.src);
        else if (m.type === 'bot') renderBotMsg(m.content);
        else if (m.type === 'error') renderErrorMsg(m.content);
      });
      updateEmptyState();
      scrollToBottom();
    } catch (e) { console.warn('[CHAT] restore failed:', e); }
  }

  async function checkPendingResult() {
    try {
      const res = await ToolBridge.call('get_pending_result', {});
      if (res && res.has_result) {
        // Job completed while user was away — show result only if not already in chat
        const lastImg = chatMessages.filter(m => m.type === 'image').pop();
        const output = (res.result.output || res.result.result || {});
        const newSrc = output.file_url || output.image_url || output.image_base64 || '';
        if (lastImg && lastImg.src === newSrc) return; // already in chat
        handleResult(res.result);
      } else if (res && res.active_job) {
        // Job still running — resume visual state and polling
        generating = true;
        currentJobId = res.active_job;
        updateSendBtnState();
        const spinnerEl = addSpinner('Generando...');
        startPolling(res.active_job, spinnerEl);
      }
    } catch (e) { /* ignore */ }
  }

  // --- Job submission ---

  window.submitPrompt = async function () {
    const prompt = input.value.trim();
    if (!prompt || generating) return;

    const res = getResolution();
    lastPrompt = prompt;

    addUserMessage(prompt);
    input.value = '';
    generating = true;
    updateSendBtnState();

    const spinnerEl = addSpinner();

    try {
      const result = await ToolBridge.submitJob({
        prompt, width: res.width, height: res.height,
        steps: settings.steps, guidance_scale: settings.guidance,
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
    pollTimer = setInterval(async () => {
      attempts += 1;
      if (attempts > 180) {
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
          addErrorMessage('Fallo: ' + (status.error || 'Error desconocido'));
          resetState();
        }
      } catch (e) { /* ignore */ }
    }, 1000);
  }

  let lastHandledJobSrc = null;

  function handleResult(status) {
    const output = status.output || status.result || {};
    let imageData = output.file_url || output.image_url || output.image_base64 || output.imageBase64 || output.image;
    if (!imageData && typeof output === 'string' && output.length > 100) imageData = output;
    if (!imageData) { addErrorMessage('Termino el job pero no llego imagen.'); return; }
    const src = imageData.startsWith('data:') || imageData.startsWith('http') ? imageData : 'data:image/png;base64,' + imageData;
    // Guard against duplicate results from concurrent polls
    if (src === lastHandledJobSrc) return;
    lastHandledJobSrc = src;
    addImageMessage(src);
  }

  window.cancelJob = async function () {
    if (currentJobId) {
      try { await ToolBridge.cancelJob(currentJobId); } catch (e) { /* ignore */ }
    }
    if (pollTimer) clearInterval(pollTimer);
    const spinner = chat.querySelector('.spinner-wrap');
    if (spinner) removeEl(spinner);
    input.value = lastPrompt;
    updateSendBtnState();
    resetState();
  };

  function resetState() {
    generating = false;
    currentJobId = null;
    lastPrompt = '';
    updateSendBtnState();
  }

  // --- Chat messages (rendering + state tracking) ---

  function addUserMessage(text) {
    chatMessages.push({ type: 'user', content: text, ts: Date.now() });
    renderUserMsg(text);
    saveChatState();
  }

  function addBotMessage(text) {
    chatMessages.push({ type: 'bot', content: text, ts: Date.now() });
    renderBotMsg(text);
    saveChatState();
  }

  function addErrorMessage(text) {
    chatMessages.push({ type: 'error', content: text, ts: Date.now() });
    renderErrorMsg(text);
    saveChatState();
  }

  function addImageMessage(src) {
    chatMessages.push({ type: 'image', src, ts: Date.now() });
    renderImageMsg(src);
    saveChatState();
  }

  function renderUserMsg(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = text;
    chat.appendChild(el);
    updateEmptyState();
    scrollToBottom();
  }

  function renderBotMsg(text) {
    const el = document.createElement('div');
    el.className = 'msg bot';
    el.style.padding = '12px 14px';
    el.textContent = text;
    chat.appendChild(el);
    updateEmptyState();
    scrollToBottom();
  }

  function renderErrorMsg(text) {
    const el = document.createElement('div');
    el.className = 'msg error';
    el.textContent = text;
    chat.appendChild(el);
    updateEmptyState();
    scrollToBottom();
  }

  function renderImageMsg(src) {
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
    actions.appendChild(buildImageActionButton(
      '<svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>',
      'Compartir', () => shareImage(src)));
    actions.appendChild(buildImageActionButton(
      '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
      'Copiar', () => copyImage(src)));
    actions.appendChild(buildImageActionButton(
      '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
      'Descargar', () => downloadImage(src)));

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
      try { await onClick(); } catch (e) { /* ignore */ }
    });
    return button;
  }

  function addSpinner(text) {
    const el = document.createElement('div');
    el.className = 'spinner-wrap';
    el.innerHTML = [
      '<div class="loading-dots"><span></span><span></span><span></span></div>',
      '<span class="spinner-text">' + (text || 'Enviando...') + '</span>',
    ].join('');
    chat.appendChild(el);
    updateEmptyState();
    scrollToBottom();
    return el;
  }

  // --- Image actions ---

  async function copyImage(src) {
    if (ToolBridge.isShellMode()) {
      try { await ToolBridge.copyImage(src); toast('Imagen copiada'); return; } catch (e) { /* ignore */ }
    }
    try {
      const blob = await fetch(src).then(r => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      toast('Imagen copiada');
    } catch (e) { toast('No se pudo copiar'); }
  }

  async function downloadImage(src) {
    const fileName = buildFileName(src);
    if (ToolBridge.isShellMode()) {
      try { await ToolBridge.downloadImage(src, fileName); toast('Imagen guardada'); return; } catch (e) { /* ignore */ }
    }
    try {
      const blob = await fetch(src).then(r => r.blob());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Descarga iniciada');
    } catch (e) { toast('No se pudo descargar'); }
  }

  async function shareImage(src) {
    if (ToolBridge.isShellMode()) {
      try { await ToolBridge.shareImage(src); return; } catch (e) { /* ignore */ }
    }
    try {
      if (navigator.share && navigator.canShare) {
        const blob = await fetch(src).then(r => r.blob());
        const file = new File([blob], buildFileName(src), { type: blob.type || 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title: 'Z-Image', text: 'Imagen generada con Z-Image', files: [file] });
          return;
        }
      }
    } catch (err) { if (err && err.name === 'AbortError') return; }
    await copyImage(src);
  }

  function buildFileName(src) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = src.startsWith('data:image/jpeg') ? 'jpg' : src.startsWith('data:image/webp') ? 'webp' : 'png';
    return `z-image-${ts}.${ext}`;
  }

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: '90px', transform: 'translateX(-50%)',
      background: 'rgba(21,22,28,0.95)', border: '1px solid rgba(255,255,255,0.22)',
      borderRadius: '999px', color: '#f1f3f7', fontSize: '13px', padding: '8px 14px', zIndex: '99999',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 250); }, 1400);
  }

  // --- Navigation / Zoom ---

  window.goBack = async function () {
    if (ToolBridge.isShellMode()) { try { await ToolBridge.closeFrontend(); return; } catch (e) { /* ignore */ } }
    if (window.history.length > 1) window.history.back();
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

  zoomOverlay.addEventListener('click', (e) => { if (e.target === zoomOverlay) closeZoom(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (settingsOverlay.classList.contains('active')) closeSettings();
      else if (zoomOverlay.classList.contains('active')) closeZoom();
    }
  });

  // WebView2 scroll fix: intercept ALL wheel events and forward to chat
  document.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chat.scrollTop += e.deltaY;
  }, { passive: false, capture: true });

  // Ensure chat is focusable and auto-focuses for keyboard/scroll events
  chat.setAttribute('tabindex', '0');
  chat.focus();
  chat.addEventListener('mouseenter', () => chat.focus());

  function scrollToBottom() { requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; }); }
  function removeEl(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
})();
