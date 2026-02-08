/**
 * Sumador (Test) - App principal
 * Demuestra bridge dual-path y UI mínima para testing E2E.
 */
(function () {
  'use strict';

  // DOM refs
  const inputA = document.getElementById('inputA');
  const inputB = document.getElementById('inputB');
  const btnSum = document.getElementById('btnSum');
  const resultBox = document.getElementById('resultBox');
  const resultValue = document.getElementById('resultValue');
  const errorBox = document.getElementById('errorBox');
  const bridgeStatus = document.getElementById('bridgeStatus');
  const logEntries = document.getElementById('logEntries');
  const btnClearLogs = document.getElementById('btnClearLogs');

  // --- Logging ---
  function log(msg, level) {
    level = level || 'info';
    const line = document.createElement('div');
    line.className = 'log-line ' + level;
    const ts = new Date().toLocaleTimeString();
    line.textContent = '[' + ts + '] ' + msg;
    logEntries.appendChild(line);
    logEntries.scrollTop = logEntries.scrollHeight;
    console.log('[Sumador][' + level + '] ' + msg);
  }

  btnClearLogs.addEventListener('click', function () {
    logEntries.innerHTML = '';
  });

  // --- Bridge Connection ---
  async function initBridge() {
    bridgeStatus.className = 'status connecting';
    bridgeStatus.textContent = 'Conectando...';
    log('Modo: ' + ToolBridge.mode);

    try {
      const result = await ToolBridge.handshake();
      bridgeStatus.className = 'status connected';
      bridgeStatus.textContent = ToolBridge.mode === 'shell' ? 'Shell' : 'Web';
      log('Handshake OK: ' + JSON.stringify(result), 'ok');
    } catch (e) {
      bridgeStatus.className = 'status disconnected';
      bridgeStatus.textContent = 'Offline';
      log('Handshake falló: ' + e.message, 'warn');
      log('Modo fallback: cálculo local', 'warn');
    }
  }

  // --- Sum Logic ---
  async function doSum() {
    const a = parseFloat(inputA.value);
    const b = parseFloat(inputB.value);

    errorBox.classList.add('hidden');
    resultBox.classList.add('hidden');

    if (isNaN(a) || isNaN(b)) {
      showError('Ingresa números válidos');
      return;
    }

    btnSum.disabled = true;
    btnSum.textContent = 'Calculando...';
    log('Sumando: ' + a + ' + ' + b);

    try {
      let result;

      // Intentar via Bridge primero
      if (ToolBridge.mode === 'shell') {
        try {
          log('Enviando job via Bridge...');
          const resp = await ToolBridge.submitJob({ a: a, b: b });
          log('Job response: ' + JSON.stringify(resp), 'ok');

          if (resp.job_id) {
            log('Job creado: ' + resp.job_id + ' (polling status...)');
            // Poll for result (simplified)
            result = await pollJobResult(resp.job_id, a + b);
          } else if (resp.result !== undefined) {
            result = resp.result;
          } else {
            throw new Error('Unexpected response format');
          }
        } catch (bridgeErr) {
          log('Bridge error: ' + bridgeErr.message + ' → fallback local', 'warn');
          result = a + b;
        }
      } else {
        // HTTP mode or offline: cálculo local como fallback
        log('Cálculo local (sin bridge activo)');
        result = a + b;
      }

      showResult(result);
      log('Resultado: ' + result, 'ok');
    } catch (e) {
      showError('Error: ' + e.message);
      log('Error: ' + e.message, 'error');
    } finally {
      btnSum.disabled = false;
      btnSum.textContent = 'Sumar';
    }
  }

  /** Poll job status (simplified with timeout) */
  async function pollJobResult(jobId, localFallback) {
    const maxWait = 10000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      try {
        const status = await ToolBridge.jobStatus(jobId);
        log('Job status: ' + JSON.stringify(status));

        if (status.status === 'completed' && status.result !== undefined) {
          return status.result;
        }
        if (status.status === 'failed') {
          throw new Error(status.error || 'Job failed');
        }
      } catch (e) {
        log('Poll error: ' + e.message, 'warn');
      }

      await sleep(1000);
    }

    log('Job timeout, usando cálculo local', 'warn');
    return localFallback;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function showResult(value) {
    resultValue.textContent = typeof value === 'number'
      ? (Number.isInteger(value) ? value.toString() : value.toFixed(6))
      : String(value);
    resultBox.classList.remove('hidden');
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    log(msg, 'error');
  }

  // --- Events ---
  btnSum.addEventListener('click', doSum);

  // Enter key submits
  inputA.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { inputB.focus(); }
  });
  inputB.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { doSum(); }
  });

  // --- Init ---
  log('Sumador (Test) v0.2.0 iniciado');
  initBridge();
})();
