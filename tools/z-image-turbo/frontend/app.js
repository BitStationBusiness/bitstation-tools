// Z-Image Turbo — Frontend App
(function() {
  'use strict';

  const messagesEl = document.getElementById('messages');
  const emptyState = document.getElementById('empty-state');
  const promptInput = document.getElementById('prompt-input');
  const sendBtn = document.getElementById('send-btn');
  const bridgeStatusEl = document.getElementById('bridge-status');
  const logContent = document.getElementById('log-content');

  let selectedSize = 'M';
  let isGenerating = false;
  let currentJobId = null;
  let cancelRequested = false;
  let lastPrompt = '';

  // Size selector
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isGenerating) return;
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSize = btn.dataset.size;
    });
  });

  // Enter to send
  promptInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      generate();
    }
  });

  // Log utility
  function log(msg, cls) {
    const line = document.createElement('div');
    line.className = 'log-line' + (cls ? ' ' + cls : '');
    line.textContent = new Date().toLocaleTimeString() + ' ' + msg;
    logContent.appendChild(line);
    logContent.scrollTop = logContent.scrollHeight;
  }

  window.toggleLog = function() {
    document.getElementById('log-panel').classList.toggle('collapsed');
  };

  window.useSuggestion = function(btn) {
    promptInput.value = btn.textContent;
    promptInput.focus();
  };

  // Add message to chat
  function addMessage(content, type, extra) {
    emptyState.style.display = 'none';
    const msg = document.createElement('div');
    msg.className = 'msg ' + type;
    msg.innerHTML = content;
    if (extra) msg.innerHTML += extra;
    messagesEl.appendChild(msg);
    const chatArea = document.getElementById('chat-area');
    chatArea.scrollTop = chatArea.scrollHeight;
    return msg;
  }

  // Init bridge with retries (WebView2 may inject BitStationBridge after page load)
  async function initBridge() {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Wait for bridge injection (800ms delay in WebView2)
        if (attempt === 1) await sleep(1000);

        const result = await window.ToolBridge.handshake();
        const mode = window.ToolBridge.isShellMode() ? 'Shell' : 'HTTP';
        bridgeStatusEl.textContent = mode;
        bridgeStatusEl.className = 'status online';
        log('Bridge connected: ' + mode + ' (attempt ' + attempt + ') | ' + JSON.stringify(result), 'ok');
        return; // Success
      } catch (e) {
        log('Bridge attempt ' + attempt + '/' + maxRetries + ': ' + e.message, attempt < maxRetries ? '' : 'error');
        if (attempt < maxRetries) {
          await sleep(1000 * attempt);
        }
      }
    }
    bridgeStatusEl.textContent = 'offline';
    bridgeStatusEl.className = 'status offline';
    log('Bridge failed after ' + maxRetries + ' attempts', 'error');
  }

  // Cancel current job
  window.cancelGeneration = async function() {
    if (!isGenerating) return;
    cancelRequested = true;

    if (currentJobId) {
      try {
        await window.ToolBridge.cancelJob(currentJobId);
        log('Job cancelled: ' + currentJobId, 'ok');
      } catch (e) {
        log('Cancel error: ' + e.message, 'error');
      }
    }

    // Restore last prompt for editing
    promptInput.value = lastPrompt;
    promptInput.focus();
  };

  // Generate image
  window.generate = async function() {
    const prompt = promptInput.value.trim();
    if (!prompt || isGenerating) return;

    isGenerating = true;
    cancelRequested = false;
    currentJobId = null;
    lastPrompt = prompt;
    sendBtn.disabled = true;
    promptInput.value = '';

    // Show cancel button in input area
    updateInputUI(true);

    // User message
    const sizeLabel = { S: '512px', M: '768px', B: '1024px' }[selectedSize] || selectedSize;
    addMessage(
      escapeHtml(prompt),
      'user',
      '<span class="size-badge">' + sizeLabel + '</span>'
    );

    // Generating indicator with cancel
    const genMsg = addMessage(
      '<div class="generating">' +
        '<div class="spinner"></div>' +
        '<span>Submitting job...</span>' +
      '</div>',
      'system'
    );

    log('Submitting job: prompt="' + prompt.substring(0, 50) + '..." size=' + selectedSize);

    try {
      const result = await window.ToolBridge.submitJob({
        prompt: prompt,
        size: selectedSize,
      });

      if (cancelRequested) {
        showCancelled(genMsg);
        return;
      }

      log('Submit result: ' + JSON.stringify(result).substring(0, 200));

      const jobId = result.job_id || result.jobId;
      if (jobId) {
        currentJobId = jobId;
        genMsg.querySelector('.generating span').textContent = 'Generating... (job: ' + jobId.substring(0, 8) + ')';
        log('Polling job: ' + jobId);
        await pollJob(jobId, genMsg);
      } else if (result.ok === false) {
        showError(genMsg, result.error || 'Job creation failed');
      } else {
        // Direct result
        showResult(genMsg, result);
      }
    } catch (e) {
      if (cancelRequested) {
        showCancelled(genMsg);
      } else {
        log('Error: ' + e.message, 'error');
        showError(genMsg, e.message);
      }
    } finally {
      isGenerating = false;
      sendBtn.disabled = false;
      currentJobId = null;
      cancelRequested = false;
      updateInputUI(false);
    }
  };

  // Poll job status
  async function pollJob(jobId, msgEl) {
    const maxAttempts = 180;
    const interval = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      if (cancelRequested) {
        showCancelled(msgEl);
        return;
      }

      await sleep(interval);

      if (cancelRequested) {
        showCancelled(msgEl);
        return;
      }

      try {
        const status = await window.ToolBridge.jobStatus(jobId);
        const state = (status.status || status.state || '').toUpperCase();

        log('Poll #' + (i + 1) + ': ' + state);

        // Update message
        const stateText = state.charAt(0) + state.slice(1).toLowerCase();
        const spinner = msgEl.querySelector('.generating');
        if (spinner) {
          spinner.querySelector('span').textContent = stateText + '... (job: ' + jobId.substring(0, 8) + ')';
        }

        if (state === 'DONE' || state === 'COMPLETED') {
          const output = status.result?.output || status.output || status.result || status;
          showResult(msgEl, output);
          return;
        }

        if (state === 'FAILED' || state === 'ERROR') {
          const err = status.error || status.result?.error || 'Job failed';
          showError(msgEl, err);
          return;
        }
      } catch (e) {
        log('Poll error: ' + e.message, 'error');
        if (e.message.includes('404') || e.message.includes('not found')) {
          showError(msgEl, 'Job not found');
          return;
        }
      }
    }

    showError(msgEl, 'Timeout: generation took too long');
  }

  // Show result
  function showResult(msgEl, output) {
    let html = '';
    const imageUrl = output.file_url || output.image_url || output.url;
    const imageBase64 = output.image_base64;
    const imagePath = output.image_path;
    const width = output.width || '';
    const height = output.height || '';

    if (imageUrl) {
      html = '<img class="result-image" src="' + escapeHtml(imageUrl) + '" alt="Generated image">';
    } else if (imageBase64) {
      html = '<img class="result-image" src="data:image/png;base64,' + imageBase64 + '" alt="Generated image">';
    } else if (imagePath) {
      html = '<p>Image saved: ' + escapeHtml(imagePath) + '</p>';
    } else {
      html = '<p>Result: ' + escapeHtml(JSON.stringify(output).substring(0, 300)) + '</p>';
    }

    if (width && height) html += '<div class="meta">' + width + '×' + height + 'px</div>';

    msgEl.className = 'msg system';
    msgEl.innerHTML = html;
    log('Image generated!', 'ok');
  }

  function showError(msgEl, error) {
    msgEl.className = 'msg error';
    msgEl.innerHTML = '⚠ ' + escapeHtml(error);
    log('Error: ' + error, 'error');
  }

  function showCancelled(msgEl) {
    msgEl.className = 'msg error';
    msgEl.innerHTML = '⏹ Cancelled';
    log('Generation cancelled by user', 'ok');
  }

  // Toggle between send button and cancel button
  function updateInputUI(generating) {
    const cancelBtn = document.getElementById('cancel-btn');
    if (generating) {
      sendBtn.style.display = 'none';
      cancelBtn.style.display = 'flex';
    } else {
      sendBtn.style.display = 'flex';
      cancelBtn.style.display = 'none';
    }
  }

  // Utilities
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Init
  initBridge();
})();
