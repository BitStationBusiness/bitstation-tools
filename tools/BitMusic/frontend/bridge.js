// ToolBridge - toolbridge/1 protocol for BitMusic
(function () {
  'use strict';

  function isShellMode() {
    return (
      typeof window.BitStationBridge !== 'undefined' ||
      (typeof window.chrome !== 'undefined' && typeof window.chrome.webview !== 'undefined')
    );
  }

  let msgId = 0;
  function nextId() { return 'req_' + (++msgId) + '_' + Date.now(); }

  const pending = {};

  function sendViaBridge(action, params) {
    return new Promise((resolve, reject) => {
      const requestId = nextId();
      pending[requestId] = { resolve, reject };
      const msg = JSON.stringify({ request_id: requestId, action, params: params || {} });
      if (window.BitStationBridge && window.BitStationBridge.postMessage) {
        window.BitStationBridge.postMessage(msg);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(msg);
      } else {
        delete pending[requestId];
        reject(new Error('No bridge available'));
      }
      setTimeout(() => {
        if (pending[requestId]) { delete pending[requestId]; reject(new Error('Bridge timeout')); }
      }, 120000);
    });
  }

  window.onBridgeResponse = function (data) {
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      const cb = pending[obj.request_id];
      if (!cb) return;
      delete pending[obj.request_id];
      if (obj.error) cb.reject(new Error(obj.error));
      else cb.resolve(obj.result || obj);
    } catch (e) { console.error('[Bridge] parse error:', e); }
  };

  window.ToolBridge = {
    isShellMode,
    async call(action, params) {
      if (isShellMode()) return sendViaBridge(action, params || {});
      throw new Error(action + ' only in shell mode');
    },
    async handshake() {
      if (isShellMode()) return sendViaBridge('handshake', {});
      return { ok: true, mode: 'standalone', api: 'toolbridge/1' };
    },
    async closeFrontend() {
      return sendViaBridge('close_frontend', {});
    },
    async getFileUrl(path) {
      return sendViaBridge('get_file_url', { path });
    },
  };
})();
