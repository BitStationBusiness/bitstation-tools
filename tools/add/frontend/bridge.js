/**
 * BitStation ToolBridge - Dual-path communication layer
 *
 * Path 1 (Shell/App): window.BitStationBridge.postMessage(json)
 * Path 2 (WebApp):    HTTP fallback to HQ API
 *
 * Contract: toolbridge/1
 */
(function () {
  'use strict';

  const HQ_BASE = 'https://gateway.bitstation.cc';
  let _requestId = 0;
  const _pending = new Map(); // requestId -> { resolve, reject, timeout }

  /** True if running inside BitStationApp shell */
  function isShellMode() {
    return typeof window.BitStationBridge !== 'undefined' &&
           typeof window.BitStationBridge.postMessage === 'function';
  }

  /** Generate unique request ID */
  function nextId() {
    return `req_${++_requestId}_${Date.now()}`;
  }

  /** Send request via Shell bridge */
  function sendViaBridge(action, params) {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const timeoutMs = 30000;

      const timer = setTimeout(() => {
        _pending.delete(id);
        reject(new Error(`Bridge timeout: ${action} (${timeoutMs}ms)`));
      }, timeoutMs);

      _pending.set(id, { resolve, reject, timeout: timer });

      const message = JSON.stringify({
        request_id: id,
        action: action,
        params: params || {}
      });

      window.BitStationBridge.postMessage(message);
    });
  }

  /** Send request via HTTP fallback */
  async function sendViaHttp(action, params) {
    const url = `${HQ_BASE}/bridge/${action}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {})
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    return resp.json();
  }

  /** Handle bridge response from Shell (called by BitStationApp) */
  window.onBridgeResponse = function (data) {
    const response = typeof data === 'string' ? JSON.parse(data) : data;
    const entry = _pending.get(response.request_id);
    if (!entry) return;

    _pending.delete(response.request_id);
    clearTimeout(entry.timeout);

    if (response.error) {
      entry.reject(new Error(response.error));
    } else {
      entry.resolve(response.result || {});
    }
  };

  /** Public API */
  window.ToolBridge = {
    /** Check which mode is active */
    get mode() {
      return isShellMode() ? 'shell' : 'http';
    },

    /** Handshake - verify connection */
    async handshake() {
      if (isShellMode()) {
        return sendViaBridge('handshake');
      }
      return sendViaHttp('handshake');
    },

    /** Submit a job */
    async submitJob(params) {
      if (isShellMode()) {
        return sendViaBridge('submit_job', { params });
      }
      return sendViaHttp('submit_job', params);
    },

    /** Query job status */
    async jobStatus(jobId) {
      if (isShellMode()) {
        return sendViaBridge('job_status', { job_id: jobId });
      }
      return sendViaHttp('job_status', { job_id: jobId });
    },

    /** Pick files (shell only) */
    async pickFiles(options) {
      if (isShellMode()) {
        return sendViaBridge('pick_files', options || {});
      }
      throw new Error('pickFiles only available in Shell mode');
    },

    /** Generic send */
    async send(action, params) {
      if (isShellMode()) {
        return sendViaBridge(action, params);
      }
      return sendViaHttp(action, params);
    }
  };
})();
