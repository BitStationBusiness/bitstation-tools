/**
 * BitStation ToolBridge - Dual-Path Implementation
 * 
 * Este módulo detecta automáticamente si está corriendo dentro del Shell
 * (BitStationApp con WebView) o en modo Web (navegador directo).
 * 
 * API Contract: toolbridge/1
 */

(function(global) {
    'use strict';

    // Detectar si existe el bridge nativo
    const hasNativeBridge = typeof global.BitStationBridge !== 'undefined' &&
                            typeof global.BitStationBridge.postMessage === 'function';

    // Callbacks pendientes para respuestas del bridge
    const pendingCallbacks = {};
    let requestCounter = 0;

    /**
     * Genera un ID único para cada request
     */
    function generateRequestId() {
        return `req_${Date.now()}_${++requestCounter}`;
    }

    /**
     * Llama al bridge nativo y espera respuesta
     */
    function callNativeBridge(action, params) {
        return new Promise((resolve, reject) => {
            const requestId = generateRequestId();
            
            // Timeout de 30 segundos
            const timeout = setTimeout(() => {
                delete pendingCallbacks[requestId];
                reject(new Error(`Timeout: ${action}`));
            }, 30000);

            pendingCallbacks[requestId] = {
                resolve: (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                }
            };

            global.BitStationBridge.postMessage(JSON.stringify({
                request_id: requestId,
                action: action,
                params: params || {}
            }));
        });
    }

    /**
     * Callback global para respuestas del bridge nativo
     * El Shell llama a esta función con el resultado
     */
    global.onBridgeResponse = function(responseJson) {
        try {
            const response = JSON.parse(responseJson);
            const callback = pendingCallbacks[response.request_id];
            
            if (callback) {
                delete pendingCallbacks[response.request_id];
                
                if (response.error) {
                    callback.reject(new Error(response.error));
                } else {
                    callback.resolve(response.result);
                }
            }
        } catch (e) {
            console.error('Error parsing bridge response:', e);
        }
    };

    /**
     * Fallback HTTP para modo Web
     */
    async function callHttpFallback(action, params) {
        const baseUrl = global.__BITSTATION_HQ_URL__ || '';
        
        const endpoints = {
            'handshake': { method: 'GET', path: '/api/v1/shell/info' },
            'submit_job': { method: 'POST', path: '/api/v1/jobs' },
            'job_status': { method: 'GET', path: `/api/v1/jobs/${params.job_id}` },
            'cancel_job': { method: 'DELETE', path: `/api/v1/jobs/${params.job_id}` },
        };

        const endpoint = endpoints[action];
        if (!endpoint) {
            throw new Error(`Action not supported in web mode: ${action}`);
        }

        const url = baseUrl + endpoint.path;
        const options = {
            method: endpoint.method,
            headers: { 'Content-Type': 'application/json' }
        };

        if (endpoint.method === 'POST' || endpoint.method === 'PUT') {
            options.body = JSON.stringify(params);
        }

        const response = await fetch(url, options);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return await response.json();
    }

    /**
     * API pública del Bridge
     */
    const Bridge = {
        /**
         * Modo actual: 'shell' o 'web'
         */
        mode: hasNativeBridge ? 'shell' : 'web',

        /**
         * Handshake con el Shell
         * @returns {Promise<{shell_version: string, api_contract: string, platform: string}>}
         */
        async handshake() {
            if (hasNativeBridge) {
                return callNativeBridge('handshake');
            } else {
                // En modo web, retornamos info simulada
                return {
                    shell_version: 'web',
                    api_contract: 'toolbridge/1',
                    platform: 'web'
                };
            }
        },

        /**
         * Seleccionar archivos (solo en modo Shell)
         * @param {Object} options - { extensions?: string[], multiple?: boolean }
         * @returns {Promise<string[]>}
         */
        async pickFiles(options = {}) {
            if (hasNativeBridge) {
                return callNativeBridge('pick_files', options);
            } else {
                throw new Error('pickFiles not available in web mode');
            }
        },

        /**
         * Enviar job al backend
         * @param {Object} params - { tool_id: string, params: object, files?: string[] }
         * @returns {Promise<{job_id: string}>}
         */
        async submitJob(params) {
            if (hasNativeBridge) {
                return callNativeBridge('submit_job', params);
            } else {
                return callHttpFallback('submit_job', params);
            }
        },

        /**
         * Consultar estado de un job
         * @param {string} jobId
         * @returns {Promise<{status: string, progress?: number, output?: object, error?: string}>}
         */
        async jobStatus(jobId) {
            if (hasNativeBridge) {
                return callNativeBridge('job_status', { job_id: jobId });
            } else {
                return callHttpFallback('job_status', { job_id: jobId });
            }
        },

        /**
         * Cancelar un job
         * @param {string} jobId
         * @returns {Promise<{ok: boolean}>}
         */
        async cancelJob(jobId) {
            if (hasNativeBridge) {
                return callNativeBridge('cancel_job', { job_id: jobId });
            } else {
                return callHttpFallback('cancel_job', { job_id: jobId });
            }
        },

        /**
         * Abrir archivo resultado (solo en modo Shell)
         * @param {string} path
         * @returns {Promise<{ok: boolean}>}
         */
        async openResult(path) {
            if (hasNativeBridge) {
                return callNativeBridge('open_result', { path: path });
            } else {
                throw new Error('openResult not available in web mode');
            }
        },

        /**
         * Helper: esperar resultado de un job con polling
         * @param {string} jobId
         * @param {number} timeoutMs - timeout en ms (default: 5 min)
         * @param {number} pollIntervalMs - intervalo de polling (default: 1s)
         * @returns {Promise<object>}
         */
        async waitForResult(jobId, timeoutMs = 300000, pollIntervalMs = 1000) {
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeoutMs) {
                const status = await this.jobStatus(jobId);
                
                if (status.status === 'completed') {
                    return status.output || status;
                }
                
                if (status.status === 'failed' || status.status === 'error') {
                    throw new Error(status.error || 'Job failed');
                }
                
                if (status.status === 'cancelled') {
                    throw new Error('Job cancelled');
                }

                // Esperar antes del siguiente poll
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }

            throw new Error('Timeout waiting for job result');
        }
    };

    // Exportar como global
    global.BitStationBridge = hasNativeBridge ? 
        Object.assign(global.BitStationBridge, Bridge) : 
        Bridge;

})(typeof window !== 'undefined' ? window : this);
