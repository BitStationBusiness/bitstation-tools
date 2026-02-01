# Z-Image Turbo

Generador de imagenes con IA usando Stable Diffusion.

## Preview

![Preview](icon.png)

## Caracteristicas

- Generacion rapida de imagenes con IA
- Soporte para GPU persistence (mantener el modelo cargado)
- Multiples tamanos de imagen (S/M/B)

## GPU Persistence

Esta herramienta soporta "GPU Persistence Mode":

- Activado (rapido): el modelo se mantiene cargado en VRAM
- Desactivado: el modelo se carga bajo demanda y libera VRAM al terminar

## Requisitos

- VRAM minima: 4GB
- Espacio en disco: ~5GB
- GPU compatible con CUDA


## Uso

### Modo Normal (Single Job)

Procesa una sola imagen y termina:

```bash
python main.py --input input.json --output output.json
```

**Formato de `input.json`:**
```json
{
  "prompt": "a beautiful sunset over mountains",
  "size": "M"
}
```

### Modo Flash (Persistente)

Mantiene el modelo cargado en GPU/RAM para procesar múltiples imágenes rápidamente:

```bash
python main.py --persistent
```

El modo Flash usa **JSON-RPC sobre STDIN/STDOUT**:

1. La herramienta carga el modelo y imprime `{"status": "ready"}` en STDOUT
2. Envía trabajos (jobs) como JSON en una línea a STDIN
3. La herramienta procesa el job y devuelve el resultado JSON en STDOUT
4. Repite el paso 2-3 para múltiples imágenes
5. Cierra STDIN para terminar limpiamente

**Ejemplo de uso interactivo:**
```bash
echo '{"prompt": "a cat", "size": "S"}' | python main.py --persistent
```

**Log visible:**
- GPU activada: `"GPU mode enabled, model pinned in VRAM"`
- GPU desactivada: `"GPU mode disabled, unloading model"`
