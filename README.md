# BitStation Tools (Monorepo)

Repositorio oficial de herramientas (tools) para el ecosistema BitStation.

## Objetivo
- Un solo repo con múltiples tools.
- Cada tool se distribuye como un ZIP independiente en GitHub Releases.
- Un `catalog.json` global describe qué tools existen, versión, hash e instaladores.
- **Sistema de actualización diferencial** por manifiestos (solo descarga lo que cambió).

## Estructura
- `tools/<tool_id>/` contiene una tool.
- `build/pack_tools.py` empaqueta tools + genera catálogo.
- `build/validate_tools.py` valida estructura/contratos.

## Protocolo de ejecución (v1)
Ver: `docs/runtime_protocol_v1.md`

## Sistema de Actualización Diferencial

El sistema permite actualizaciones eficientes descargando **solo los archivos que cambiaron** entre versiones.

### Características
- ✅ **Ahorro de ancho de banda**: Solo descarga archivos nuevos/modificados (hasta 99% de reducción)
- ✅ **Verificación forense**: SHA256 por archivo + manifest_hash global
- ✅ **Activación atómica**: Todo se valida antes de activar (rollback automático en errores)
- ✅ **Protección de datos**: Nunca toca `venv/`, `cache/`, `user_data/`, `logs/`
- ✅ **Trazabilidad completa**: Reporte detallado de operaciones (CHECKPOINT WORKER-UPDATE-DELTA-1)

### Inicio Rápido

**Build (crear releases)**:
```bash
python build/generate_manifest.py  # Genera manifests con hashes
python build/pack_tools.py          # Empaqueta tools con manifests
```

**Worker (instalar/actualizar)**:
```python
from build.delta_updater import DeltaUpdater
updater = DeltaUpdater(Path("D:/Tools/my-tool"))
stats = updater.update_from_zip(zip_path, manifest)
print(stats.report())  # Muestra: descargados, verificados, eliminados, ahorrados
```

### Documentación
- **Inicio rápido**: `docs/QUICKSTART_DELTA_UPDATE.md`
- **Documentación completa**: `docs/delta_update_system.md`
- **Ejemplo de integración**: `build/worker_updater_example.py`
- **Esquema de manifest**: `catalog/manifest.schema.json`

## Desarrollo rápido
Validar tools:
```bash
python build/validate_tools.py
```

Empaquetar tools (local):

```bash
python build/pack_tools.py
```

## Releases

Crear tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

El workflow `release.yml` publicará:

* `catalog.json`
* `tool_<tool_id>_<version>.zip`