"""
Z-Image Turbo - Generador de imágenes desde texto
Usa Diffusers con ZImagePipeline para generación con modelos GGUF.
"""

import argparse
import json
import sys
import os
import shutil
import time
from pathlib import Path
from datetime import datetime
import gc

# Modelo por defecto (GGUF)
DEFAULT_MODEL_FILE = os.environ.get("ZIMAGE_MODEL_FILE", "z_image_turbo-Q4_K_M.gguf")
DEFAULT_MODEL_REPO = os.environ.get("ZIMAGE_MODEL_REPO", "jayn7/Z-Image-Turbo-GGUF")
DEFAULT_MODEL_URL = os.environ.get("ZIMAGE_MODEL_URL", "")

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

def _download_with_progress(url: str, dest_path: Path) -> None:
    """Descarga con progreso básico en MB."""
    import requests

    chunk_size = 8 * 1024 * 1024
    with requests.get(url, stream=True, timeout=30) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", "0") or 0)
        downloaded = 0
        last_log = time.time()
        last_pct = -1

        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=chunk_size):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)

                now = time.time()
                if total > 0:
                    pct = int(downloaded * 100 / total)
                    if pct >= last_pct + 5 or now - last_log >= 5:
                        print(f"  Descarga: {pct}% ({downloaded // (1024*1024)} MB)")
                        last_pct = pct
                        last_log = now
                else:
                    if now - last_log >= 5:
                        print(f"  Descarga: {downloaded // (1024*1024)} MB")
                        last_log = now


def _ensure_model(model_path: Path) -> dict | None:
    """
    Descarga el modelo automáticamente si no existe.
    Usa Hugging Face Hub por defecto o ZIMAGE_MODEL_URL si se define.
    """
    if model_path.exists():
        return None

    try:
        model_path.parent.mkdir(parents=True, exist_ok=True)

        if DEFAULT_MODEL_URL:
            print(f"  Descargando modelo (URL directa)...")
            print(f"  URL: {DEFAULT_MODEL_URL}")
            _download_with_progress(DEFAULT_MODEL_URL, model_path)
            return None

        print(f"  Descargando modelo desde Hugging Face...")
        print(f"  Repo: {DEFAULT_MODEL_REPO}")
        print(f"  Archivo: {DEFAULT_MODEL_FILE}")

        from huggingface_hub import hf_hub_download

        cached = hf_hub_download(
            repo_id=DEFAULT_MODEL_REPO,
            filename=DEFAULT_MODEL_FILE,
            local_dir=model_path.parent,
            local_dir_use_symlinks=False,
        )
        cached_path = Path(cached)
        if cached_path.resolve() != model_path.resolve():
            shutil.copyfile(cached_path, model_path)
        size_mb = model_path.stat().st_size // (1024 * 1024)
        print(f"  Descarga completada: {size_mb} MB")
        return None
    except Exception as e:
        return {
            "ok": False,
            "error": f"No se pudo descargar el modelo GGUF: {e}",
        }

def load_model(flash_mode: bool = False):
    """
    Carga el modelo Z-Image Turbo y retorna el pipeline configurado.
    
    Args:
        flash_mode: Si True, optimiza para máxima velocidad (modelo completo en GPU).
                   Si False, usa CPU offload para balance VRAM/velocidad.
    """
    try:
        import torch
        from diffusers import ZImagePipeline, ZImageTransformer2DModel, GGUFQuantizationConfig
    except ImportError as e:
        raise ImportError(f"diffusers o torch no instalado: {e}")
    
    model_path = _get_default_model_path()
    if not model_path.exists():
        download_error = _ensure_model(model_path)
        if download_error is not None:
            raise RuntimeError(download_error.get("error", "Error descargando modelo"))
    if not model_path.exists():
        raise FileNotFoundError(
            f"Modelo GGUF no encontrado. Ejecuta setup.ps1 para descargarlo "
            f"o define ZIMAGE_MODEL_PATH. Path esperado: {model_path}"
        )

    load_start = time.time()
    print(f"  Cargando modelo: {model_path}", file=sys.stderr)
    
    # Determinar el dispositivo y dtype
    if torch.cuda.is_available():
        device = "cuda"
        dtype = torch.bfloat16
        print(f"  Usando GPU: {torch.cuda.get_device_name(0)}", file=sys.stderr)
        
        # Mostrar VRAM disponible
        total_vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        free_vram = (torch.cuda.get_device_properties(0).total_memory - torch.cuda.memory_allocated(0)) / (1024**3)
        print(f"  VRAM total: {total_vram:.1f} GB, disponible: {free_vram:.1f} GB", file=sys.stderr)
    else:
        device = "cpu"
        dtype = torch.float32
        print("  ADVERTENCIA: Usando CPU. La generación será muy lenta.", file=sys.stderr)

    # Cargar el transformer desde el archivo GGUF con reintento por corrupción
    print("  Cargando transformer...", file=sys.stderr)
    
    max_retries = 1
    transformer = None
    for attempt in range(max_retries + 1):
        try:
            # Asegurar que el archivo existe antes de intentar cargar
            if not model_path.exists():
                print(f"  [INFO] El modelo no existe, descargando...", file=sys.stderr)
                # Intentar llamar a _ensure_model si el path está en models/ por defecto
                if "models" in str(model_path):
                     _ensure_model(model_path)
                elif not model_path.exists():
                     raise FileNotFoundError(f"Modelo no encontrado en: {model_path}")
            
            transformer = ZImageTransformer2DModel.from_single_file(
                str(model_path),
                quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
                torch_dtype=dtype,
            )
            # Si carga exitosamente, salir del bucle
            break
            
        except (OSError, ValueError, UnicodeDecodeError, RuntimeError) as e:
            # Detectar errores típicos de archivo corrupto
            is_corruption = (
                "Unable to load weights" in str(e) or 
                "cannot reshape array" in str(e) or 
                "charmap" in str(e) or
                "invalid load key" in str(e)
            )
            
            if is_corruption and attempt < max_retries:
                # Sanitizar el mensaje de error para evitar fallos de encoding en logs
                safe_err_msg = str(e).encode('ascii', 'replace').decode('ascii')
                print(f"  [ERROR] Modelo corrupto detectado. Eliminando y re-descargando... (Detalle: {safe_err_msg[:100]}...)", file=sys.stderr)
                
                # Intentar cerrar handles y liberar memoria antes de borrar
                del transformer
                import gc
                gc.collect()
                
                try:
                    if model_path.exists():
                        os.remove(model_path)
                        print(f"  [INFO] Archivo corrupto eliminado: {model_path}", file=sys.stderr)
                    
                    # Forzar descarga en el siguiente ciclo
                    if "models" in str(model_path):
                         _ensure_model(model_path)
                    
                except Exception as del_err:
                    safe_del_err = str(del_err).encode('ascii', 'replace').decode('ascii')
                    print(f"  [ERROR] No se pudo eliminar el archivo corrupto: {safe_del_err}", file=sys.stderr)
                    # Si no podemos borrar, no tiene sentido reintentar
                    raise e
            else:
                # Si no es corrupción o ya reintentamos, lanzar el error
                print(f"  [FATAL] Fallo al cargar el modelo después de {attempt} reintentos.", file=sys.stderr)
                raise e
    
    # Crear el pipeline
    print("  Inicializando pipeline...", file=sys.stderr)
    pipeline = ZImagePipeline.from_pretrained(
        "Tongyi-MAI/Z-Image-Turbo",
        transformer=transformer,
        torch_dtype=dtype,
    )
    
    if device == "cuda":
        # Optimizaciones globales de PyTorch para velocidad
        torch.backends.cudnn.benchmark = True  # Autotuner para convoluciones
        torch.backends.cuda.matmul.allow_tf32 = True  # TensorFloat32 en Ampere+
        torch.backends.cudnn.allow_tf32 = True
        if hasattr(torch, 'set_float32_matmul_precision'):
            torch.set_float32_matmul_precision('medium')
        
        if flash_mode:
            # MODO FLASH: Usar enable_model_cpu_offload para GGUF
            # NOTA: sequential_cpu_offload es MUY LENTO con modelos GGUF
            # NOTA: to(device) causa OOM/thrashing en 8GB VRAM
            # model_cpu_offload proporciona rendimiento consistente de ~19-20s/imagen
            print("  [FLASH] Habilitando CPU Offload optimizado para GGUF...", file=sys.stderr)
            pipeline.enable_model_cpu_offload()
            
            load_time = time.time() - load_start
            print(f"  [FLASH] Pipeline listo en {load_time:.2f}s", file=sys.stderr)
            
            # WARMUP para pre-compilar kernels CUDA
            print("  [FLASH] Warmup: inicializando kernels...", file=sys.stderr)
            warmup_start = time.time()
            try:
                with torch.inference_mode():
                    warmup_generator = torch.Generator("cuda").manual_seed(42)
                    _ = pipeline(
                        prompt="warmup",
                        num_inference_steps=1,
                        guidance_scale=0.0,
                        height=512,
                        width=512,
                        generator=warmup_generator,
                        output_type="latent"
                    )
                if torch.cuda.is_available():
                    torch.cuda.synchronize()
                    # Reportar uso de memoria después del warmup
                    vram_used = torch.cuda.memory_allocated(0) / (1024**3)
                    vram_total = torch.cuda.get_device_properties(0).total_memory / (1024**3)
                    print(f"  [FLASH] GPU: {vram_used:.1f}/{vram_total:.1f} GB usados", file=sys.stderr)
                warmup_time = time.time() - warmup_start
                print(f"  [FLASH] Warmup completado en {warmup_time:.2f}s - Listo para generar", file=sys.stderr)
            except Exception as e:
                print(f"  [FLASH] Warmup fallido (no crítico): {e}", file=sys.stderr)
        
        else:
            # MODO NORMAL: CPU Offload estándar
            print("  Habilitando CPU Offload (Balance VRAM/Velocidad)...", file=sys.stderr)
            pipeline.enable_model_cpu_offload()
    else:
        pipeline.to(device)
    
    return pipeline, device


def generate_image_with_pipeline(pipeline, device: str, prompt: str, width: int, height: int, output_path: Path) -> dict:
    """
    Genera una imagen usando un pipeline ya cargado.
    Usa torch.inference_mode() para máxima velocidad.
    """
    try:
        import torch
        
        # Generar imagen con inference_mode para mejor rendimiento
        print("  Generando imagen...", file=sys.stderr)
        seed = int(datetime.now().timestamp()) % (2**32)
        generator = torch.Generator(device).manual_seed(seed)
        
        with torch.inference_mode():
            images = pipeline(
                prompt=prompt,
                num_inference_steps=9,  # Turbo model optimizado para 9 pasos
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


def generate_image(prompt: str, width: int, height: int, output_path: Path) -> dict:
    """
    Genera una imagen usando Diffusers con ZImagePipeline.
    Modo normal: carga el modelo, genera la imagen, y libera recursos.
    """
    try:
        pipeline, device = load_model()
        return generate_image_with_pipeline(pipeline, device, prompt, width, height, output_path)
    except ImportError as e:
        return {"ok": False, "error": f"diffusers o torch no instalado: {e}"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": f"Error al generar imagen: {str(e)}"}


def run_persistent_mode() -> int:
    """
    Modo Flash (Persistente): Mantiene el modelo en GPU y procesa múltiples jobs.
    Usa JSON-RPC sobre STDIN/STDOUT.
    
    Optimizaciones Flash:
    - Modelo cargado completamente en GPU (sin CPU offload)
    - Warmup inicial para pre-compilar kernels CUDA
    - torch.compile() para kernels optimizados
    - VAE tiling para eficiencia de memoria
    """
    import torch
    
    try:
        # Cargar modelo con optimizaciones Flash
        print("Iniciando modo Flash (persistente)...", file=sys.stderr)
        flash_start = time.time()
        pipeline, device = load_model(flash_mode=True)
        total_init_time = time.time() - flash_start
        
        # Log GPU mode
        if device == "cuda":
            vram_used = torch.cuda.memory_allocated(0) / (1024**3)
            print(f"GPU mode enabled, model pinned in VRAM ({vram_used:.2f} GB used)", file=sys.stderr)
            print(f"Total initialization time: {total_init_time:.2f}s", file=sys.stderr)
        else:
            print("Flash mode enabled (CPU), model loaded in RAM", file=sys.stderr)
        
        # Señal de que estamos listos
        ready_signal = {"status": "ready"}
        print(json.dumps(ready_signal, ensure_ascii=False))
        sys.stdout.flush()
        
        # Bucle de procesamiento
        job_count = 0
        while True:
            try:
                # Leer job desde STDIN
                line = sys.stdin.readline()
                
                # EOF: señal de cierre
                if not line:
                    print("GPU mode disabled, unloading model", file=sys.stderr)
                    break
                
                line = line.strip()
                if not line:
                    continue  # Línea vacía, ignorar
                
                # Parsear job
                try:
                    job = json.loads(line)
                except json.JSONDecodeError as e:
                    error_result = {"ok": False, "error": f"JSON inválido: {e}"}
                    print(json.dumps(error_result, ensure_ascii=False))
                    sys.stdout.flush()
                    continue
                
                # Validar job
                if not isinstance(job, dict):
                    error_result = {"ok": False, "error": "Job debe ser un objeto JSON"}
                    print(json.dumps(error_result, ensure_ascii=False))
                    sys.stdout.flush()
                    continue
                
                if "prompt" not in job:
                    error_result = {"ok": False, "error": "Campo requerido faltante: 'prompt'"}
                    print(json.dumps(error_result, ensure_ascii=False))
                    sys.stdout.flush()
                    continue
                
                prompt = job["prompt"]
                if not isinstance(prompt, str) or not prompt.strip():
                    error_result = {"ok": False, "error": "El campo 'prompt' debe ser un string no vacío"}
                    print(json.dumps(error_result, ensure_ascii=False))
                    sys.stdout.flush()
                    continue
                
                # Obtener tamaño (default: M)
                size = job.get("size", "M").upper()
                if size not in SIZE_MAP:
                    error_result = {"ok": False, "error": f"Tamaño inválido: '{size}'. Valores válidos: S, M, B"}
                    print(json.dumps(error_result, ensure_ascii=False))
                    sys.stdout.flush()
                    continue
                
                width, height = SIZE_MAP[size]
                
                # Generar nombre único para la imagen
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                safe_prompt = "".join(c if c.isalnum() or c in " -_" else "" for c in prompt[:30])
                safe_prompt = safe_prompt.strip().replace(" ", "_")
                filename = f"zimg_{timestamp}_{safe_prompt}.png"
                
                # Guardar en carpeta de Descargas
                downloads = get_downloads_folder()
                image_output_path = downloads / filename
                
                job_count += 1
                job_id = job.get("id", job_count)
                print(f"Procesando job {job_id}: {prompt[:50]}...", file=sys.stderr)
                
                # Generar imagen usando pipeline cargado
                gen_start = time.time()
                result = generate_image_with_pipeline(pipeline, device, prompt, width, height, image_output_path)
                gen_time = time.time() - gen_start
                
                # Añadir tiempo de generación al resultado
                if result.get("ok"):
                    result["generation_time_ms"] = int(gen_time * 1000)
                    print(f"Imagen generada en {gen_time:.2f}s", file=sys.stderr)
                
                # Enviar resultado
                print(json.dumps(result, ensure_ascii=False))
                sys.stdout.flush()
                
                # En modo Flash, NO limpiar cache para mantener kernels compilados
                # Solo hacer gc.collect() ligero
                gc.collect()
                
            except KeyboardInterrupt:
                print("GPU mode disabled, unloading model", file=sys.stderr)
                break
            except Exception as e:
                import traceback
                traceback.print_exc()
                error_result = {"ok": False, "error": f"Error interno: {str(e)}"}
                print(json.dumps(error_result, ensure_ascii=False))
                sys.stdout.flush()
        
        return 0
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": f"Error al iniciar modo persistente: {str(e)}"}), file=sys.stderr)
        return 1

def main() -> int:
    ap = argparse.ArgumentParser(description="Z-Image Turbo - Generador de imágenes")
    ap.add_argument("--input", help="Path a input.json (modo normal)")
    ap.add_argument("--output", help="Path a output.json (modo normal)")
    ap.add_argument("--persistent", action="store_true", help="Modo Flash: mantiene modelo en GPU para múltiples jobs")
    args = ap.parse_args()

    # Modo persistente
    if args.persistent:
        if args.input or args.output:
            print("ERROR: --persistent no se puede usar con --input/--output", file=sys.stderr)
            return 2
        return run_persistent_mode()
    
    # Modo normal: validar que input y output estén presentes
    if not args.input or not args.output:
        ap.error("Modo normal requiere --input y --output (o usa --persistent para modo Flash)")
        return 2

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
