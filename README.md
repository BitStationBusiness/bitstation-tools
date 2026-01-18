# BitStation Tools (Monorepo)

Repositorio oficial de herramientas (tools) para el ecosistema BitStation.

## Objetivo
- Un solo repo con múltiples tools.
- Cada tool se distribuye como un ZIP independiente en GitHub Releases.
- Un `catalog.json` global describe qué tools existen, versión, hash e instaladores.

## Estructura
- `tools/<tool_id>/` contiene una tool.
- `build/pack_tools.py` empaqueta tools + genera catálogo.
- `build/validate_tools.py` valida estructura/contratos.

## Protocolo de ejecución (v1)
Ver: `docs/runtime_protocol_v1.md`

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