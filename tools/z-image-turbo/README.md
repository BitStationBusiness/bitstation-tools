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

```bash
python main.py --input input.json --output output.json
```
