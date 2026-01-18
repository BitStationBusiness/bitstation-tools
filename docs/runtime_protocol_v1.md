# BitStation Tool Runtime Protocol v1

## Objetivo
Estandarizar cómo un Worker ejecuta una tool, sin depender de UI o del lenguaje interno.

## Entrada / Salida
La tool debe aceptar:
- `--input <path>`: JSON de entrada
- `--output <path>`: JSON de salida

## Convención de ejecución
El Worker invoca el entrypoint (Windows):
- `runner/run.ps1 --input <input.json> --output <output.json>`

## Reglas
- Exit code 0 => éxito (output.json válido)
- Exit code != 0 => fallo (output.json puede no existir)
- La tool NO debe escribir modelos pesados dentro del repo.
- Cualquier descarga externa debe validarse por hash (en fases posteriores).