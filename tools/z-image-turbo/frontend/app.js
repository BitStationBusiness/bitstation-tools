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

  // Size selector
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
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

  // Toggle log panel
  window.toggleLog = function() {
    document.getElementById('log-panel').classList.toggle('collapsed');
  };

  // Suggestion click
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

    // Scroll to bottom
    const chatArea = document.getElementById('chat-area');
    chatArea.scrollTop = chatArea.scrollHeight;

    return msg;
  }

  // Init bridge
  async function initBridge() {
    try {
      const result = await window.ToolBridge.handshake();
      const mode = window.ToolBridge.isShellMode() ? 'Shell' : 'HTTP';
      bridgeStatusEl.textContent = mode;
      bridgeStatusEl.className = 'status online';
      log('Bridge connected: ' + mode, 'ok');
    } catch (e) {
      bridgeStatusEl.textContent = 'offline';
      bridgeStatusEl.className = 'status offline';
      log('Bridge error: ' + e.message, 'error');
    }
  }

  // Generate image
  window.generate = async function() {
    const prompt = promptInput.value.trim();
    if (!prompt || isGenerating) return;

    isGenerating = true;
    sendBtn.disabled = true;
    promptInput.value = '';

    // User message
    const sizeLabel = { S: '512px', M: '768px', B: '1024px' }[selectedSize] || selectedSize;
    addMessage(
      escapeHtml(prompt),
      'user',
      '<span class="size-badge">' + sizeLabel + '</span>'
    );

    // Generating indicator
    const genMsg = addMessage(
      '<div class="generating"><div class="spinner"></div><span>Generating image...</span></div>',
      'system'
    );

    log('Submitting job: prompt="' + prompt.substring(0, 50) + '..." size=' + selectedSize);

    try {
      const result = await window.ToolBridge.submitJob({
        prompt: prompt,
        size: selectedSize,
      });

      log('Job submitted: ' + JSON.stringify(result).substring(0, 100));

      // If we got a job_id, poll for result
      const jobId = result.job_id || result.jobId;
      if (jobId) {
        currentJobId = jobId;
        log('Polling job: ' + jobId);
        await pollJob(jobId, genMsg);
      } else if (result.result || result.output) {
        // Direct result (local execution)
        showResult(genMsg, result.result || result.output);
      } else if (result.ok === false) {
        showError(genMsg, result.error || 'Unknown error');
      } else {
        showResult(genMsg, result);
      }
    } catch (e) {
      log('Error: ' + e.message, 'error');
      showError(genMsg, e.message);
    } finally {
      isGenerating = false;
      sendBtn.disabled = false;
      currentJobId = null;
    }
  };

  // Poll job status
  async function pollJob(jobId, msgEl) {
    const maxAttempts = 180; // 15 min max
    const interval = 5000;   // 5s

    for (let i = 0; i < maxAttempts; i++) {
      await sleep(interval);

      try {
        const status = await window.ToolBridge.jobStatus(jobId);
        const state = status.status || status.state || '';

        log('Poll #' + (i + 1) + ': ' + state);

        // Update generating message
        const stateLabel = state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
        msgEl.innerHTML = '<div class="generating"><div class="spinner"></div><span>' +
          stateLabel + '...</span></div>';

        if (state === 'DONE' || state === 'done' || state === 'completed') {
          const output = status.result?.output || status.output || status.result || status;
          showResult(msgEl, output);
          return;
        }

        if (state === 'FAILED' || state === 'failed' || state === 'error') {
          const err = status.error || status.result?.error || 'Job failed';
          showError(msgEl, err);
          return;
        }
      } catch (e) {
        log('Poll error: ' + e.message, 'error');
        // Continue polling unless fatal
        if (e.message.includes('404') || e.message.includes('not found')) {
          showError(msgEl, 'Job not found');
          return;
        }
      }
    }

    showError(msgEl, 'Timeout: image generation took too long');
  }

  // Show image result
  function showResult(msgEl, output) {
    let html = '';

    // Try to find image URL from various response formats
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
      html = '<p>Result: ' + escapeHtml(JSON.stringify(output).substring(0, 200)) + '</p>';
    }

    if (width && height) {
      html += '<div class="meta">' + width + '×' + height + 'px</div>';
    }

    msgEl.className = 'msg system';
    msgEl.innerHTML = html;
    log('Image generated successfully', 'ok');
  }

  // Show error
  function showError(msgEl, error) {
    msgEl.className = 'msg error';
    msgEl.innerHTML = '⚠ ' + escapeHtml(error);
    log('Error: ' + error, 'error');
  }

  // Utilities
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // Init
  initBridge();
})();
