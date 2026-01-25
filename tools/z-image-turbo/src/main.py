"""
Z-Image Turbo - Generador de imágenes desde texto
Usa stable-diffusion-cpp-python para generación local eficiente.
"""

import argparse
import json
import sys
import os
from pathlib import Path
from datetime import datetime

# Mapeo de tamaños
SIZE_MAP = {
    "S": (512, 512),    # Small - Rápido
    "M": (768, 768),    # Medium - Balance
    "B": (1024, 1024),  # Big - Alta calidad
}

def fail(msg: str, out_path: Path, code: int = 2) -> None:
    """Escribe error en output y termina."""
    error_output = {"ok": False, "error": msg}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(error_output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(error_output, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)

def get_downloads_folder() -> Path:
    """Obtiene la carpeta de Descargas del usuario."""
    # En Windows, usar la variable de entorno o el path conocido
    downloads = os.environ.get("USERPROFILE", "")
    if downloads:
        downloads_path = Path(downloads) / "Downloads"
        if downloads_path.exists():
            return downloads_path
    
    # Fallback
    return Path.home() / "Downloads"

def generate_image(prompt: str, width: int, height: int, output_path: Path) -> dict:
    """
    Genera una imagen usando stable-diffusion-cpp-python.
    """
    try:
        from stable_diffusion_cpp import StableDiffusion
    except ImportError as e:
        return {"ok": False, "error": f"stable-diffusion-cpp-python no instalado: {e}"}
    
    try:
        # Inicializar el modelo
        # El modelo se descargará automáticamente si no existe
        sd = StableDiffusion(
            model_path="",  # Usará el modelo por defecto
            wtype="default",  # Tipo de peso automático
        )
        
        # Generar imagen
        images = sd.txt_to_img(
            prompt=prompt,
            width=width,
            height=height,
            sample_steps=4,  # Turbo = menos pasos
            cfg_scale=1.0,   # Para modelos turbo/schnell
        )
        
        if not images:
            return {"ok": False, "error": "No se generó ninguna imagen"}
        
        # Guardar la primera imagen
        image = images[0]
        image.save(str(output_path), format="PNG")
        
        return {
            "ok": True,
            "image_path": str(output_path),
            "width": width,
            "height": height
        }
        
    except Exception as e:
        return {"ok": False, "error": f"Error al generar imagen: {str(e)}"}

def main() -> int:
    ap = argparse.ArgumentParser(description="Z-Image Turbo - Generador de imágenes")
    ap.add_argument("--input", required=True, help="Path a input.json")
    ap.add_argument("--output", required=True, help="Path a output.json")
    args = ap.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)

    # Validar input existe
    if not in_path.exists():
        fail(f"Input no encontrado: {in_path}", out_path)

    # Leer input JSON
    try:
        data = json.loads(in_path.read_text(encoding="utf-8-sig"))
    except Exception as e:
        fail(f"JSON inválido: {e}", out_path)

    if not isinstance(data, dict):
        fail("Input debe ser un objeto JSON", out_path)

    # Validar campo requerido: prompt
    if "prompt" not in data:
        fail("Campo requerido faltante: 'prompt'", out_path)

    prompt = data["prompt"]
    if not isinstance(prompt, str) or not prompt.strip():
        fail("El campo 'prompt' debe ser un string no vacío", out_path)

    # Obtener tamaño (default: M)
    size = data.get("size", "M").upper()
    if size not in SIZE_MAP:
        fail(f"Tamaño inválido: '{size}'. Valores válidos: S, M, B", out_path)

    width, height = SIZE_MAP[size]

    # Generar nombre único para la imagen
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_prompt = "".join(c if c.isalnum() or c in " -_" else "" for c in prompt[:30])
    safe_prompt = safe_prompt.strip().replace(" ", "_")
    filename = f"zimg_{timestamp}_{safe_prompt}.png"

    # Guardar en carpeta de Descargas
    downloads = get_downloads_folder()
    image_output_path = downloads / filename

    print(f"Generando imagen...")
    print(f"  Prompt: {prompt}")
    print(f"  Tamaño: {size} ({width}x{height})")
    print(f"  Output: {image_output_path}")

    # Generar imagen
    result = generate_image(prompt, width, height, image_output_path)

    # Escribir output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    if result["ok"]:
        print(f"Imagen generada: {result['image_path']}")
        return 0
    else:
        print(f"Error: {result['error']}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
