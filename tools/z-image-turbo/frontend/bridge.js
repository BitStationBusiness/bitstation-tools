// ToolBridge — adapta al contrato toolbridge/1 de BitStationApp
// Protocolo: { request_id, action, params } → { request_id, result, error? }
(function() {
  'use strict';

  const HQ_BASE = 'https://gateway.bitstation.cc';

  function isShellMode() {
    return typeof window.BitStationBridge !== 'undefined' ||
           (typeof window.chrome !== 'undefined' && typeof window.chrome.webview !== 'undefined');
  }

  let _msgId = 0;
  function nextId() { return 'req_' + (++_msgId) + '_' + Date.now(); }

  // Pending bridge requests
  const _pending = {};

  // Send via native bridge (Shell mode)
  // Formato: { request_id, action, params }
  function sendViaBridge(action, params) {
    return new Promise((resolve, reject) => {
      const request_id = nextId();
      _pending[request_id] = { resolve, reject, ts: Date.now() };

      const msg = JSON.stringify({ request_id, action, params: params || {} });

      if (window.BitStationBridge && window.BitStationBridge.postMessage) {
        window.BitStationBridge.postMessage(msg);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(msg);
      } else {
        delete _pending[request_id];
        reject(new Error('No bridge available'));
      }

      // Timeout after 120s
      setTimeout(() => {
        if (_pending[request_id]) {
          delete _pending[request_id];
          reject(new Error('Bridge timeout'));
        }
      }, 120000);
    });
  }

  // Handle bridge responses from Dart
  // Formato: { request_id, result, error? }
  window.onBridgeResponse = function(data) {
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      const cb = _pending[obj.request_id];
      if (cb) {
        delete _pending[obj.request_id];
        if (obj.error) {
          cb.reject(new Error(obj.error));
        } else {
          cb.resolve(obj.result || obj);
        }
      }
    } catch (e) {
      console.error('[Bridge] Response parse error:', e);
    }
  };

  // HTTP fallback (WebApp mode)
  async function sendViaHttp(endpoint, method, body) {
    const opts = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(HQ_BASE + endpoint, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()));
    return res.json();
  }

  // Public API
  window.ToolBridge = {
    isShellMode,

    async handshake() {
      if (isShellMode()) {
        return sendViaBridge('handshake', {});
      }
      return { ok: true, mode: 'http', api: 'toolbridge/1' };
    },

    async submitJob(input) {
      if (isShellMode()) {
        // params.params es lo que tool_bridge.dart espera dentro de submit_job
        return sendViaBridge('submit_job', { params: input });
      }
      return sendViaHttp('/jobs', 'POST', {
        tool_id: 'z-image-turbo',
        tool_version: '0.5.5',
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
