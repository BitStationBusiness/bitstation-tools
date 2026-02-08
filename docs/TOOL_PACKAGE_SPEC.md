# Tool Package Specification v2

Esta especificación define el contrato estándar para tools en BitStation, permitiendo que frontends y backends se distribuyan y actualicen independientemente de BitStationApp.

---

## Estructura de Archivos

```
tools/<tool_id>/
├── tool.json              # Metadatos básicos (catálogo)
├── manifest.json          # Manifest detallado con hashes
├── cover.png              # Portada (solo color, gris se aplica en app)
├── frontend/              # [OPCIONAL] Frontend web
│   ├── index.html         # Entry point
│   ├── bridge.js          # ToolBridge dual-path
│   └── ...                # CSS, assets, etc.
├── runner/                # Backend ejecutable
│   ├── run.ps1            # Windows entrypoint
│   └── setup.ps1          # Instalación de dependencias
├── src/                   # Código fuente del backend
│   └── main.py
└── requirements.txt       # Dependencias Python
```

---

## tool.json (Metadatos para Catálogo)

```json
{
  "tool_id": "hello-demo",
  "name": "Hello Demo",
  "version": "1.0.0",
  "category": "demo",
  "platforms": ["windows", "android"],
  "entrypoint_windows": "runner/run.ps1",
  "needs_models": false,
  "supports_gpu_persistence": false,
  "io_schema": { ... }
}
```

---

## manifest.json (Manifest con Hashes y Frontend)

```json
{
  "manifest_version": "1.0",
  "tool_id": "hello-demo",
  "tool_version": "1.0.0",
  "api_contract": "toolbridge/1",
  "frontend": {
    "type": "web",
    "entry": "index.html",
    "archive": "frontend.zip",
    "sha256": "<sha256-del-zip>"
  },
  "capabilities": [],
  "files": [ ... ],
  "delete_policy": "safe",
  "ignore_globs": [ ... ]
}
```

---

## Frontend Dual-Path

El frontend debe soportar dos modos de operación:

### Modo Shell (Windows/Android)

Cuando se ejecuta dentro de BitStationApp (WebView), el frontend se comunica a través de `BitStationBridge`:

```javascript
// bridge.js
const useBridge = typeof window.BitStationBridge !== 'undefined';
```

### Modo Web (Browser)

Cuando se ejecuta directamente en un navegador, el frontend hace llamadas HTTP directas a HQ.

### Detección Automática

```javascript
async function submitJob(params) {
  if (useBridge) {
    // Modo Shell: usar Bridge
    return await bridgeCall('submit_job', params);
  } else {
    // Modo Web: HTTP directo a HQ
    return await fetch('/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
  }
}
```

---

## Bridge API Mínima (toolbridge/1)

El Shell expone estas funciones vía JavaScript channel:

| Método | Parámetros | Retorno | Descripción |
|--------|------------|---------|-------------|
| `handshake` | `{}` | `{ shell_version, api_contract, platform }` | Verificar conexión y compatibilidad |
| `pick_files` | `{ extensions?: string[], multiple?: boolean }` | `string[]` | Abrir selector de archivos nativo |
| `submit_job` | `{ tool_id, params, files? }` | `{ job_id }` | Enviar job a workers |
| `job_status` | `{ job_id }` | `{ status, progress?, output?, error? }` | Consultar estado del job |
| `cancel_job` | `{ job_id }` | `{ ok }` | Cancelar job en curso |
| `open_result` | `{ path }` | `{ ok }` | Abrir archivo resultado (galería, etc.) |

### Protocolo de Comunicación

```javascript
// Frontend → Bridge
function bridgeCall(action, params) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now().toString();
    window._bridgeCallbacks = window._bridgeCallbacks || {};
    window._bridgeCallbacks[requestId] = { resolve, reject };
    
    window.BitStationBridge.postMessage(JSON.stringify({
      request_id: requestId,
      action: action,
      params: params
    }));
  });
}

// Bridge → Frontend (callback)
window.onBridgeResponse = function(responseJson) {
  const response = JSON.parse(responseJson);
  const callback = window._bridgeCallbacks[response.request_id];
  if (callback) {
    if (response.error) {
      callback.reject(new Error(response.error));
    } else {
      callback.resolve(response.result);
    }
    delete window._bridgeCallbacks[response.request_id];
  }
};
```

---

## Compatibilidad de Versiones

El campo `api_contract` indica la versión del Bridge que el frontend requiere:

- `toolbridge/1`: API mínima (handshake, pick_files, submit_job, etc.)
- Futuras versiones mantendrán backward compatibility

**Regla del Shell:**
Si el frontend requiere un `api_contract` no soportado, el Shell debe:
1. Mostrar mensaje de error
2. Sugerir actualizar BitStationApp

---

## Assets

### cover.png
- Tamaño recomendado: 512x288 (16:9)
- Siempre en **color** (el gris se aplica por filtro en la app)
- Formato: PNG con transparencia opcional

---

## Publicación

Cada release debe incluir:
1. `tool.json` actualizado con nueva versión
2. `manifest.json` con hashes SHA256 de todos los archivos
3. `frontend.zip` (si aplica) con el frontend comprimido
4. `cover.png` actualizado si hay cambios visuales

GitHub Release Assets:
```
v1.0.0/
├── tool.json
├── manifest.json
├── frontend.zip
├── cover.png
└── checksums.sha256
```
