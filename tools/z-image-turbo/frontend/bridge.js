// ToolBridge — dual-path: Shell (BitStationBridge) or HTTP fallback
(function() {
  'use strict';

  const HQ_BASE = 'https://gateway.bitstation.cc';

  function isShellMode() {
    return typeof window.BitStationBridge !== 'undefined' ||
           (typeof window.chrome !== 'undefined' && typeof window.chrome.webview !== 'undefined');
  }

  // Generate unique message IDs
  let _msgId = 0;
  function nextId() { return 'msg_' + (++_msgId) + '_' + Date.now(); }

  // Pending bridge responses
  const _pending = {};

  // Send via native bridge (Shell mode)
  function sendViaBridge(type, payload) {
    return new Promise((resolve, reject) => {
      const id = nextId();
      _pending[id] = { resolve, reject, ts: Date.now() };

      const msg = JSON.stringify({ id, type, ...payload });

      // Try BitStationBridge first, then chrome.webview
      if (window.BitStationBridge && window.BitStationBridge.postMessage) {
        window.BitStationBridge.postMessage(msg);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(msg);
      } else {
        delete _pending[id];
        reject(new Error('No bridge available'));
      }

      // Timeout after 120s (image generation can be slow)
      setTimeout(() => {
        if (_pending[id]) {
          delete _pending[id];
          reject(new Error('Bridge timeout'));
        }
      }, 120000);
    });
  }

  // Handle bridge responses
  window.onBridgeResponse = function(data) {
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      const cb = _pending[obj.id];
      if (cb) {
        delete _pending[obj.id];
        if (obj.error) cb.reject(new Error(obj.error));
        else cb.resolve(obj);
      }
    } catch (e) {
      console.error('[Bridge] Response parse error:', e);
    }
  };

  // Send via HTTP fallback (WebApp mode)
  async function sendViaHttp(endpoint, method, body) {
    const opts = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(HQ_BASE + endpoint, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // Public API
  window.ToolBridge = {
    isShellMode,

    async handshake() {
      if (isShellMode()) {
        return sendViaBridge('handshake', { api: 'toolbridge/1', tool: 'z-image-turbo' });
      }
      return { ok: true, mode: 'http', api: 'toolbridge/1' };
    },

    async submitJob(input) {
      if (isShellMode()) {
        return sendViaBridge('submit_job', {
          tool_id: 'z-image-turbo',
          input: input,
        });
      }
      // HTTP fallback — POST /jobs
      return sendViaHttp('/jobs', 'POST', {
        tool_id: 'z-image-turbo',
        tool_version: '0.5.4',
        input: input,
      });
    },

    async jobStatus(jobId) {
      if (isShellMode()) {
        return sendViaBridge('job_status', { job_id: jobId });
      }
      return sendViaHttp('/jobs/' + jobId, 'GET');
    },

    async cancelJob(jobId) {
      if (isShellMode()) {
        return sendViaBridge('cancel_job', { job_id: jobId });
      }
      return sendViaHttp('/jobs/' + jobId, 'DELETE');
    },
  };
})();
