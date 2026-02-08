# Inicio Rápido: Sistema de Actualización Diferencial

Este documento explica cómo usar el sistema de actualización diferencial en 5 minutos.

## Prerrequisitos

- Python 3.11+
- Proyecto BitStation Tools clonado

## Pasos para Build/Release

### 1. Generar Manifiestos

Antes de crear releases, genera los manifiestos para todas las tools:

```bash
python build/generate_manifest.py
```

Esto crea `manifest.json` en cada carpeta de tool con:
- Lista completa de archivos con SHA256
- Manifest hash global para verificación
- Configuración de actualización (ignore_globs, delete_policy)

**Output esperado:**
```
[manifest] Generando manifiestos de release...
[manifest] Generando manifiesto para add v0.1.4...
[manifest]   6 archivos procesados
[manifest]   manifest_hash: ee52f28f...
[manifest]   Escrito: tools/add/manifest.json
[manifest] OK: 2 manifiestos generados
```

### 2. Empaquetar Tools

Crea los ZIPs de distribución (incluyen manifest.json):

```bash
python build/pack_tools.py
```

Esto crea en `dist/`:
- `tool_<tool_id>_<version>.zip` - ZIP completo con manifest incluido
- `catalog.json` - Catálogo con manifest_hash de cada tool

**Output esperado:**
```
[pack] Tool: add v0.1.4 (manifest_hash: 386f2b30...)
[pack] Empaquetando tool_add_0.1.4.zip...
[pack]   SHA256: 7b55b337...
[pack] wrote: dist/catalog.json
```

### 3. Publicar Release (GitHub Actions)

El workflow `.github/workflows/release.yml` automáticamente:
1. Genera manifiestos
2. Empaqueta tools
3. Publica en GitHub Releases al crear un tag

```bash
git tag v0.5.3
git push origin v0.5.3
```

## Uso del Updater (PCWorker)

### Instalación/Actualización de una Tool

```python
from build.delta_updater import DeltaUpdater
import zipfile, json
from pathlib import Path

# Configurar
tool_root = Path("D:/Tools/add")  # Donde se instalará la tool
zip_path = Path("tool_add_0.1.4.zip")  # ZIP descargado

# Extraer manifest del ZIP
with zipfile.ZipFile(zip_path, 'r') as zf:
    manifest = json.loads(zf.read("manifest.json"))

# Actualizar (diferencial)
updater = DeltaUpdater(tool_root)
stats = updater.update_from_zip(zip_path, manifest)

# Ver reporte
print(stats.report())
```

**Output esperado (primera instalación):**
```
[updater] Iniciando actualización diferencial
[updater] Tool: add
[updater] Versión objetivo: 0.1.4
[updater] Versión actual: ninguna
[updater] Calculando diferencias...
[updater]   Archivos a descargar: 6
[updater]   Archivos sin cambios: 0
[updater]   Archivos a eliminar: 0

[updater] FASE 1: Descarga y extracción
[updater]   ✓ 6 archivos extraídos del ZIP

[updater] FASE 2: Verificación de archivos sin cambios
[updater]   ✓ 0 archivos copiados desde versión actual

[updater] FASE 3: Verificación de integridad
[updater]   ✓ 6 archivos verificados correctamente

[updater] FASE 4: Activación atómica
[updater]   ✓ Release activado: v0.1.4

[updater] FASE 5: Limpieza de archivos obsoletos

[updater] ✓ Actualización completada exitosamente
[updater] ✓ manifest_hash verificado: 386f2b30...

═══════════════════════════════════════════════════════
  REPORTE DE ACTUALIZACIÓN DIFERENCIAL
═══════════════════════════════════════════════════════
  📥 Archivos descargados:  6
  ✓  Archivos verificados:  6
  🗑  Archivos eliminados:   0
  ⏭  Archivos sin cambios:  0
  📊 Datos descargados:     12.45 KB
═══════════════════════════════════════════════════════
```

### Actualización v0.1.4 → v0.1.5 (solo 2 archivos cambiaron)

```python
# Actualizar a nueva versión
stats = updater.update_from_zip(new_zip_path, new_manifest)
print(stats.report())
```

**Output esperado:**
```
═══════════════════════════════════════════════════════
  REPORTE DE ACTUALIZACIÓN DIFERENCIAL
═══════════════════════════════════════════════════════
  📥 Archivos descargados:  2
  ✓  Archivos verificados:  6
  🗑  Archivos eliminados:   1
  ⏭  Archivos sin cambios:  4
  📊 Datos descargados:     3.21 KB
═══════════════════════════════════════════════════════
```

**¡Solo descarga lo que cambió!** ✅

## Verificación de Elegibilidad para Red

```python
# Verificar si el worker puede aceptar trabajos de red
eligibility = updater.get_network_eligibility(
    required_version="0.1.4",
    required_hash="386f2b302105da55..."
)

if eligibility == "ELIGIBLE":
    print("✅ Worker puede aceptar trabajos de red")
elif eligibility == "OUTDATED":
    print("⚠️  Worker desactualizado - solo trabajos locales")
else:
    print("❌ No hay instalación")
```

## Flash GPU (Warmup Local)

```python
# Ejecutar warmup GPU (no requiere versión de red)
success = updater.flash_gpu()
if success:
    print("⚡ GPU lista para ejecución local")
```

## Estructura de Archivos (Tool Instalada)

```
D:/Tools/add/
  releases/
    v0.1.4/              # Release activo
      manifest.json
      src/
      runner/
      tool.json
      ...
  current.txt            # Contiene: "v0.1.4"
  venv/                  # ⚠️ NUNCA se toca
  cache/                 # ⚠️ NUNCA se toca
  user_data/             # ⚠️ NUNCA se toca
  logs/                  # ⚠️ NUNCA se toca
```

## Ventajas Clave

### ✅ Eficiencia
- Solo descarga archivos nuevos/modificados
- Verifica por SHA256 (no re-descarga innecesariamente)
- Ahorra ancho de banda y tiempo

### ✅ Seguridad
- Verificación forense de cada archivo
- Activación atómica (todo o nada)
- Protección de datos del usuario

### ✅ Transparencia
- Reporte detallado de operaciones (CHECKPOINT WORKER-UPDATE-DELTA-1)
- Estadísticas claras
- Trazabilidad por manifest_hash

## Próximos Pasos

- Leer documentación completa: `docs/delta_update_system.md`
- Ver ejemplo de integración: `build/worker_updater_example.py`
- Revisar esquema de manifest: `catalog/manifest.schema.json`

## Troubleshooting

### Error: "No such file: manifest.json"

**Causa**: ZIP no contiene manifest.json

**Solución**: Regenerar tools con `python build/generate_manifest.py && python build/pack_tools.py`

### Error: "Verificación fallida"

**Causa**: Archivo corrupto o modificado

**Solución**: El updater hace rollback automático. Verificar integridad del ZIP.

### Elegibilidad = "OUTDATED"

**Causa**: Versión instalada no coincide con la requerida por HQ

**Solución**: Actualizar a la versión requerida usando `update_from_zip()`

---

**¿Preguntas?** Ver documentación completa o revisar ejemplos en `build/worker_updater_example.py`
