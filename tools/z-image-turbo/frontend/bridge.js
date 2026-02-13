// ToolBridge - contrato toolbridge/1 de BitStationApp
// Protocolo: { request_id, action, params } -> { request_id, result, error? }
(function () {
  'use strict';

  const HQ_BASE = 'https://gateway.bitstation.cc';

  function isShellMode() {
    return (
      typeof window.BitStationBridge !== 'undefined' ||
      (typeof window.chrome !== 'undefined' &&
        typeof window.chrome.webview !== 'undefined')
    );
  }

  let msgId = 0;
  function nextId() {
    msgId += 1;
    return 'req_' + msgId + '_' + Date.now();
  }

  const pending = {};

  function sendViaBridge(action, params) {
    return new Promise((resolve, reject) => {
      const requestId = nextId();
      pending[requestId] = { resolve, reject };

      const msg = JSON.stringify({
        request_id: requestId,
        action,
        params: params || {},
      });

      if (window.BitStationBridge && window.BitStationBridge.postMessage) {
        window.BitStationBridge.postMessage(msg);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(msg);
      } else {
        delete pending[requestId];
        reject(new Error('No bridge available'));
      }

      setTimeout(() => {
        if (pending[requestId]) {
          delete pending[requestId];
          reject(new Error('Bridge timeout'));
        }
      }, 120000);
    });
  }

  window.onBridgeResponse = function (data) {
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      const cb = pending[obj.request_id];
      if (!cb) return;

      delete pending[obj.request_id];
      if (obj.error) {
        cb.reject(new Error(obj.error));
      } else {
        cb.resolve(obj.result || obj);
      }
    } catch (e) {
      console.error('[Bridge] Response parse error:', e);
    }
  };

  async function sendViaHttp(endpoint, method, body) {
    const opts = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };

    if (body) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(HQ_BASE + endpoint, opts);
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + ': ' + (await res.text()));
    }
    return res.json();
  }

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
        return sendViaBridge('submit_job', { params: input });
      }
      return sendViaHttp('/jobs', 'POST', {
        tool_id: 'z-image-turbo',
        tool_version: '0.5.9',
        input,
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

    async copyImage(dataUrl) {
      if (!isShellMode()) {
        throw new Error('copyImage is only available in shell mode');
      }
      return sendViaBridge('copy_image', { data_url: dataUrl });
    },

    async downloadImage(dataUrl, fileName) {
      if (!isShellMode()) {
        throw new Error('downloadImage is only available in shell mode');
      }
      return sendViaBridge('download_image', {
        data_url: dataUrl,
        file_name: fileName,
      });
    },

    async shareImage(dataUrl) {
      if (!isShellMode()) {
        throw new Error('shareImage is only available in shell mode');
      }
      return sendViaBridge('share_image', {
        data_url: dataUrl,
        text: 'Imagen generada con Z-Image Turbo',
      });
    },

    async closeFrontend() {
      if (!isShellMode()) {
        throw new Error('closeFrontend is only available in shell mode');
      }
      return sendViaBridge('close_frontend', {});
    },
  };
})();
