"""
Z-Image Turbo - Generador de imágenes desde texto
Usa Diffusers con ZImagePipeline para generación con modelos GGUF.
"""

import argparse
import json
import sys
import os
from pathlib import Path
from datetime import datetime
import gc

# Modelo por defecto (GGUF)
DEFAULT_MODEL_FILE = os.environ.get("ZIMAGE_MODEL_FILE", "z_image_turbo-Q4_K_M.gguf")

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

def _get_default_model_path() -> Path:
    """Retorna el path del modelo por defecto."""
    env_path = os.environ.get("ZIMAGE_MODEL_PATH")
    if env_path:
        return Path(env_path)
    tool_root = Path(__file__).resolve().parents[1]
    return tool_root / "models" / DEFAULT_MODEL_FILE

def generate_image(prompt: str, width: int, height: int, output_path: Path) -> dict:
    """
    Genera una imagen usando Diffusers con ZImagePipeline.
    """
    try:
        import torch
        from diffusers import ZImagePipeline, ZImageTransformer2DModel, GGUFQuantizationConfig
    except ImportError as e:
        return {"ok": False, "error": f"diffusers o torch no instalado: {e}"}
    
    try:
        model_path = _get_default_model_path()
        if not model_path.exists():
            return {
                "ok": False,
                "error": (
                    "Modelo GGUF no encontrado. Ejecuta setup.ps1 para descargarlo "
                    f"o define ZIMAGE_MODEL_PATH. Path esperado: {model_path}"
                ),
            }

        print(f"  Cargando modelo: {model_path}")
        
        # Determinar el dispositivo y dtype
        if torch.cuda.is_available():
            device = "cuda"
            dtype = torch.bfloat16
            print(f"  Usando GPU: {torch.cuda.get_device_name(0)}")
        else:
            device = "cpu"
            dtype = torch.float32
            print("  ADVERTENCIA: Usando CPU. La generación será muy lenta.")

        # Cargar el transformer desde el archivo GGUF
        print("  Cargando transformer...")
        transformer = ZImageTransformer2DModel.from_single_file(
            str(model_path),
            quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
            torch_dtype=dtype,
        )
        
        # Crear el pipeline sin moverlo a CUDA todavía
        print("  Inicializando pipeline...")
        pipeline = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            transformer=transformer,
            torch_dtype=dtype,
        )
        
        # Estrategia: CPU Offload por defecto para evitar swapping del driver en Windows
        if device == "cuda":
            print("  Habilitando CPU Offload (Balance VRAM/Velocidad)...")
            pipeline.enable_model_cpu_offload()
            # Opcional: enable_sequential_cpu_offload() si fuera aun muy grande, pero Q4 deberia ir bien con model_cpu_offload
        else:
            pipeline.to(device)

        # Generar imagen
        print("  Generando imagen...")
        seed = int(datetime.now().timestamp()) % (2**32)
        generator = torch.Generator(device).manual_seed(seed)
        
        images = pipeline(
            prompt=prompt,
            num_inference_steps=9,  # 8 forwards reales para modelo Turbo
            guidance_scale=0.0,     # Turbo models don't need guidance
            height=height,
            width=width,
            generator=generator,
        ).images
        
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
        import traceback
        traceback.print_exc()
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
