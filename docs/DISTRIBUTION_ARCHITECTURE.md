# Arquitectura de Distribución: HQ como Mirror

## Problema

Para delta update **real**, necesitas URLs individuales por archivo. Un ZIP único no permite "descargar solo lo que cambió" sin extraerlo completo.

## Solución: HQ como Mirror (Recomendada)

### Flujo Completo

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   GitHub    │         │     HQ      │         │   Workers   │
│  Releases   │────────>│   Mirror    │────────>│  (LAN/WAN)  │
└─────────────┘         └─────────────┘         └─────────────┘
     (1x)                  (cache)                   (N workers)
  Internet download      Sirve archivos           Delta update
  Rate limits OK         individuales             Solo descarga
                         Sin rate limits          lo que cambió
```

### Componentes

#### 1. HQ Mirror Server

**Responsabilidades**:
- Descargar releases de GitHub (1 vez)
- Cachear archivos localmente
- Servir GET `/api/v1/tools/{tool_id}/{version}/files/{path}` con:
  - Content-Type correcto
  - Content-Length
  - SHA256 en header (opcional, para verificación adicional)
  - Range support (opcional, para resumir descargas)

**Implementación Ejemplo** (Python/FastAPI):

```python
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
import hashlib

app = FastAPI()

CACHE_DIR = Path("/opt/bitstation/tools_cache")

@app.get("/api/v1/tools/{tool_id}/{version}/files/{file_path:path}")
async def serve_tool_file(tool_id: str, version: str, file_path: str):
    """
    Sirve archivos individuales de tools para delta update.
    """
    # Validar path (evitar directory traversal)
    if ".." in file_path or file_path.startswith("/"):
        raise HTTPException(400, "Invalid path")
    
    # Construir path local
    local_path = CACHE_DIR / tool_id / version / "files" / file_path
    
    if not local_path.exists():
        # Auto-download desde GitHub si no existe
        await download_from_github(tool_id, version, file_path, local_path)
    
    if not local_path.exists():
        raise HTTPException(404, "File not found")
    
    # Calcular SHA256 para verificación
    sha256 = hashlib.sha256(local_path.read_bytes()).hexdigest()
    
    return FileResponse(
        local_path,
        headers={
            "X-File-SHA256": sha256,
            "Cache-Control": "public, max-age=31536000"  # Cache 1 año
        }
    )

async def download_from_github(tool_id, version, file_path, target_path):
    """
    Descarga archivo desde GitHub Release si no está en cache.
    """
    # Descargar ZIP completo desde GitHub
    # Extraer archivo específico
    # Guardar en cache
    pass
```

#### 2. Manifest con URLs de HQ

```json
{
  "manifest_version": "1.0",
  "tool_id": "z-image-turbo",
  "tool_version": "0.5.2",
  "files": [
    {
      "path": "src/main.py",
      "sha256": "787a28e4c56ad5fe96a64662cd3f48c21326b70474da9694831c9e117ee19b24",
      "size": 24356,
      "url": "https://hq.bitstation.local/api/v1/tools/z-image-turbo/0.5.2/files/src/main.py"
    },
    {
      "path": "models/z_image_turbo-Q4_K_M.gguf",
      "sha256": "745ec270db042409fde084d6b5cfccabf214a7fe5a494edf994a391125656afd",
      "size": 4981532736,
      "url": "https://hq.bitstation.local/api/v1/tools/z-image-turbo/0.5.2/files/models/z_image_turbo-Q4_K_M.gguf"
    }
  ],
  "manifest_hash": "c9b10a4d4e8646c9..."
}
```

#### 3. Worker Delta Update

```python
# Worker descarga SOLO lo que cambió
for file_status in to_download:
    file_info = manifest["files"][file_status.path]
    
    # Descarga individual desde HQ (LAN)
    download_file(file_info["url"], staging_path)
    
    # Verificar hash
    if sha256(staging_path) != file_info["sha256"]:
        abort("Hash mismatch")
```

### Ventajas

✅ **Delta update real**: Solo descarga archivos modificados  
✅ **Velocidad LAN**: Workers descargan desde HQ local (~1 Gbps vs ~10 Mbps Internet)  
✅ **Sin rate limits**: GitHub rate limits no afectan workers  
✅ **Cache persistente**: Archivos se descargan 1 vez desde GitHub  
✅ **Verificación por archivo**: Hash SHA256 individual  
✅ **Escalabilidad**: Agregar mirrors secundarios si necesario  

## Opción B: GitHub Raw (Solo para Archivos en Repo)

**Limitación**: GitHub tiene rate limits y no sirve archivos de Release Assets directamente con URLs individuales.

**URLs posibles**:
- GitHub raw: `https://raw.githubusercontent.com/{user}/{repo}/{tag}/tools/{tool_id}/{path}`
  - ✅ Funciona para archivos en repo (scripts, configs)
  - ❌ NO funciona para Release Assets (modelos grandes)

**Conclusión**: No viable para modelos grandes. Solo sirve como fallback para archivos pequeños.

## Opción C: Chunks/Ranges (Alternativa)

Si HQ no puede implementarse inmediatamente, otra opción es:

1. Publicar ZIP completo en GitHub Release
2. Worker descarga con HTTP Range requests (parcial)
3. Extraer solo archivos necesarios

**Limitación**: GitHub no siempre soporta Range requests para Release Assets.

## Recomendación Final

**Implementar HQ como Mirror** es la opción óptima para BitStation:

1. **Fase 1**: HQ básico con cache pasiva
   - Sirve archivos desde cache
   - Auto-descarga desde GitHub si no existe
   
2. **Fase 2**: HQ con pre-cache
   - Al publicar release, HQ descarga automáticamente
   - Workers encuentran archivos siempre disponibles

3. **Fase 3**: HQ con mirrors secundarios
   - Múltiples HQs para redundancia
   - Load balancing entre mirrors

## Implementación en Manifest

El generador de manifiestos ahora soporta configurar la base URL:

```bash
# HQ mirror (default)
python build/generate_manifest.py --base-url "https://hq.bitstation.local/api/v1/tools/"

# Mirror secundario
python build/generate_manifest.py --base-url "https://hq-backup.bitstation.local/api/v1/tools/"

# Variable de entorno
export BITSTATION_FILES_BASE_URL="https://hq.bitstation.local/api/v1/tools/"
python build/generate_manifest.py
```

## Próximos Pasos

1. [ ] Implementar HQ mirror server (FastAPI/Flask)
2. [ ] Endpoint GET `/api/v1/tools/{tool_id}/{version}/files/{path}`
3. [ ] Cache local en HQ (`/opt/bitstation/tools_cache/`)
4. [ ] Auto-download desde GitHub si no existe en cache
5. [ ] Actualizar workers para usar URLs individuales
6. [ ] Monitoreo de cache hits/misses
7. [ ] Purge de versiones antiguas del cache

---

**Estado**: Arquitectura definida, manifests generados con URLs  
**Blocker**: Implementación del HQ mirror server  
**ETA**: 2-3 días para MVP del mirror
