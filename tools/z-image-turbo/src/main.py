"""
Z-Image Turbo - Generador de imágenes desde texto
Usa Diffusers con ZImagePipeline para generación con modelos GGUF.

A7: Robust GGUF model management with 4 pillars:
  1. OS-level cross-process file lock
  2. Atomic download (.part → rename)
  3. Strong GGUF header validation
  4. Separated load/repair (quarantine on corruption)
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

# ─────────────────────────────────────────────────────────────────────
# A7 Pillar 1: OS-level cross-process file lock
# ─────────────────────────────────────────────────────────────────────

class ModelFileLock:
    """
    OS-level file lock using msvcrt (Windows) or fcntl (POSIX).
    Ensures only one process can download/repair the GGUF at a time.
    Other processes wait with a configurable timeout.
    """

    def __init__(self, model_path: Path, timeout: int = 120):
        self._lock_path = model_path.with_suffix(model_path.suffix + ".lock")
        self._timeout = timeout
        self._fd = None
        self._acquired = False

    def acquire_exclusive(self) -> bool:
        """Acquire an exclusive lock. Returns True if acquired, False on timeout."""
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        self._fd = open(self._lock_path, "w")

        deadline = time.time() + self._timeout
        poll_interval = 0.5

        while True:
            try:
                if sys.platform == "win32":
                    import msvcrt
                    msvcrt.locking(self._fd.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self._fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

                self._acquired = True
                _log("MODEL_LOCK_ACQUIRED", f"Lock acquired: {self._lock_path.name}")
                return True

            except (OSError, IOError):
                if time.time() >= deadline:
                    _log("MODEL_LOCK_TIMEOUT",
                         f"Could not acquire lock after {self._timeout}s")
                    self._fd.close()
                    self._fd = None
                    return False

                _log("MODEL_LOCK_WAIT",
                     f"Lock held by another process, waiting {poll_interval}s...")
                time.sleep(poll_interval)
                poll_interval = min(poll_interval * 1.5, 5.0)

    def release(self) -> None:
        """Release the lock and close the file descriptor."""
        if self._fd is None:
            return
        try:
            if self._acquired:
                if sys.platform == "win32":
                    import msvcrt
                    try:
                        msvcrt.locking(self._fd.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                else:
                    import fcntl
                    fcntl.flock(self._fd.fileno(), fcntl.LOCK_UN)
        finally:
            self._fd.close()
            self._fd = None
            self._acquired = False

    def __enter__(self):
        if not self.acquire_exclusive():
            raise TimeoutError(
                f"MODEL_LOCK_TIMEOUT: Could not acquire model lock "
                f"after {self._timeout}s. Another process may be downloading. "
                f"Close z-image-turbo processes and retry."
            )
        return self

    def __exit__(self, *exc):
        self.release()
        return False


def _log(code: str, msg: str) -> None:
    """Structured log for model management events."""
    print(f"  [{code}] {msg}", file=sys.stderr)


def _safe_ascii(msg: object) -> str:
    """Normaliza texto para logs en stderr sin romper encoding."""
    try:
        return str(msg).encode("ascii", "replace").decode("ascii")
    except Exception:
        return "<unprintable>"


def _is_managed_model_path(model_path: Path) -> bool:
    """Indica si el modelo vive en la carpeta local administrada por la tool."""
    return "models" in str(model_path)


# ─────────────────────────────────────────────────────────────────────
# A7 Pillar 3: Strong GGUF validation
# ─────────────────────────────────────────────────────────────────────

_GGUF_MAGIC = b"GGUF"
_GGUF_MIN_SIZE_MB = 10  # Minimum viable GGUF file size in MB


def _validate_gguf(model_path: Path) -> tuple[bool, str]:
    """
    Validate a GGUF file before loading.
    Returns (is_valid, status_code).
    Status codes: OK, NOT_FOUND, TOO_SMALL, BAD_HEADER, READ_ERROR
    """
    if not model_path.exists():
        return False, "NOT_FOUND"

    try:
        file_size = model_path.stat().st_size
    except OSError as e:
        return False, f"READ_ERROR: {_safe_ascii(e)}"

    min_bytes = _GGUF_MIN_SIZE_MB * 1024 * 1024
    if file_size < min_bytes:
        _log("MODEL_VALIDATE_FAIL",
             f"File too small: {file_size} bytes (min {min_bytes})")
        return False, "TOO_SMALL"

    try:
        with open(model_path, "rb") as f:
            magic = f.read(4)
    except (OSError, PermissionError) as e:
        return False, f"READ_ERROR: {_safe_ascii(e)}"

    if magic != _GGUF_MAGIC:
        _log("MODEL_VALIDATE_FAIL",
             f"Bad header: expected {_GGUF_MAGIC!r}, got {magic!r}")
        return False, "BAD_HEADER"

    _log("MODEL_VALIDATE_OK",
         f"GGUF valid: {file_size // (1024*1024)} MB, header OK")
    return True, "OK"


# ─────────────────────────────────────────────────────────────────────
# A7 Pillar 4: Quarantine corrupt models
# ─────────────────────────────────────────────────────────────────────

def _quarantine_model(model_path: Path) -> bool:
    """
    Move a corrupt or invalid GGUF to a .bad.<timestamp> file.
    Returns True if quarantine succeeded (or file was already gone).
    """
    if not model_path.exists():
        return True

    bad_name = f"{model_path.name}.bad.{int(time.time())}"
    bad_path = model_path.with_name(bad_name)

    try:
        os.rename(model_path, bad_path)
        _log("MODEL_QUARANTINE",
             f"Quarantined: {model_path.name} -> {bad_name}")
        return True
    except (PermissionError, OSError) as e:
        # If rename fails, try delete
        try:
            os.remove(model_path)
            _log("MODEL_QUARANTINE",
                 f"Deleted corrupt file (rename failed): {model_path.name}")
            return True
        except Exception:
            _log("MODEL_QUARANTINE",
                 f"FAILED to quarantine {model_path.name}: {_safe_ascii(e)}")
            return False


# ─────────────────────────────────────────────────────────────────────
# A7 Pillar 2: Atomic download (.part → fsync → rename)
# ─────────────────────────────────────────────────────────────────────

def _atomic_download(url: str, dest_path: Path) -> None:
    """
    Download a file atomically:
      1. Write to .part file
      2. flush + fsync
      3. Rename .part → final (atomic on same filesystem)
    Raises on any failure; .part file is cleaned up.
    """
    import requests

    part_path = dest_path.with_suffix(dest_path.suffix + ".part")

    # Clean up stale .part from a previous interrupted download
    if part_path.exists():
        try:
            os.remove(part_path)
        except OSError:
            pass

    chunk_size = 8 * 1024 * 1024
    try:
        with requests.get(url, stream=True, timeout=30) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length", "0") or 0)
            downloaded = 0
            last_log = time.time()
            last_pct = -1

            with open(part_path, "wb") as f:
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
                    elif now - last_log >= 5:
                        print(f"  Descarga: {downloaded // (1024*1024)} MB")
                        last_log = now

                # Flush + fsync before rename
                f.flush()
                os.fsync(f.fileno())

        # Verify download size matches Content-Length
        if total > 0:
            actual = part_path.stat().st_size
            if actual != total:
                raise RuntimeError(
                    f"Download size mismatch: expected {total}, got {actual}"
                )

        # Atomic rename: .part → .gguf
        # On Windows, os.replace handles cross-file replacement atomically
        os.replace(part_path, dest_path)
        _log("MODEL_ATOMIC_REPLACE_OK",
             f"Download complete: {dest_path.name} "
             f"({dest_path.stat().st_size // (1024*1024)} MB)")

    except BaseException:
        # Clean up .part on ANY failure (including KeyboardInterrupt)
        if part_path.exists():
            try:
                os.remove(part_path)
            except OSError:
                pass
        raise


def _ensure_model(model_path: Path) -> dict | None:
    """
    Ensure the GGUF model exists, is valid, and is not corrupt.
    Uses cross-process locking for download coordination.
    Returns None on success, or error dict on failure.
    """
    # Fast path: model already valid
    is_valid, status = _validate_gguf(model_path)
    if is_valid:
        return None

    # Model needs attention — acquire exclusive lock
    lock = ModelFileLock(model_path, timeout=180)

    try:
        with lock:
            # Re-check after acquiring lock (another process may have fixed it)
            is_valid, status = _validate_gguf(model_path)
            if is_valid:
                _log("MODEL_ENSURE", "Model fixed by another process while waiting")
                return None

            # Quarantine existing bad file
            if model_path.exists():
                _log("MODEL_ENSURE",
                     f"Model invalid ({status}), quarantining...")
                _quarantine_model(model_path)

            # Download fresh copy
            model_path.parent.mkdir(parents=True, exist_ok=True)

            if DEFAULT_MODEL_URL:
                _log("MODEL_ENSURE", f"Downloading from URL: {DEFAULT_MODEL_URL}")
                _atomic_download(DEFAULT_MODEL_URL, model_path)
            else:
                _log("MODEL_ENSURE",
                     f"Downloading from HF: {DEFAULT_MODEL_REPO}/{DEFAULT_MODEL_FILE}")
                try:
                    from huggingface_hub import hf_hub_download

                    # HF hub downloads to its own cache — copy atomically
                    cached = hf_hub_download(
                        repo_id=DEFAULT_MODEL_REPO,
                        filename=DEFAULT_MODEL_FILE,
                        local_dir=model_path.parent,
                        local_dir_use_symlinks=False,
                    )
                    cached_path = Path(cached)
                    if cached_path.resolve() != model_path.resolve():
                        # Atomic copy via .part
                        part_path = model_path.with_suffix(
                            model_path.suffix + ".part")
                        shutil.copyfile(cached_path, part_path)
                        os.replace(part_path, model_path)
                except Exception as e:
                    return {
                        "ok": False,
                        "error": f"HF download failed: {_safe_ascii(e)}",
                    }

            # Validate the fresh download
            is_valid, status = _validate_gguf(model_path)
            if not is_valid:
                _quarantine_model(model_path)
                return {
                    "ok": False,
                    "error": f"Downloaded model failed validation: {status}",
                }

            return None

    except TimeoutError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {
            "ok": False,
            "error": f"Error ensuring model: {_safe_ascii(e)}",
        }

# Exit code used when model is corrupt and needs external repair.
# The caller (PCWorker / BitStationApp) should:
#   1. stop this process,
#   2. quarantine the .gguf (rename to .bad.*),
#   3. re-download with _atomic_download,
#   4. restart this process.
EXIT_CODE_MODEL_CORRUPT = 66

_QUARANTINE_PENDING_SUFFIX = ".quarantine_pending"


def _check_quarantine_pending(model_path: Path) -> None:
    """
    If a previous run left a .quarantine_pending marker, process it now.
    This runs at startup BEFORE loading — file handles are guaranteed free.
    """
    marker = model_path.with_suffix(model_path.suffix + _QUARANTINE_PENDING_SUFFIX)
    if not marker.exists():
        return

    _log("MODEL_QUARANTINE_PENDING", "Processing quarantine marker from previous run")
    marker.unlink(missing_ok=True)

    if model_path.exists():
        _quarantine_model(model_path)


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

    # A7: Process any pending quarantine from a previous crashed run
    _check_quarantine_pending(model_path)

    # A7: Validate + ensure model before any load attempt
    ensure_error = _ensure_model(model_path)
    if ensure_error is not None:
        raise RuntimeError(ensure_error.get("error", "Error ensuring model"))
    if not model_path.exists():
        raise FileNotFoundError(
            f"Modelo GGUF no encontrado. Ejecuta setup.ps1 para descargarlo "
            f"o define ZIMAGE_MODEL_PATH. Path esperado: {model_path}"
        )

    load_start = time.time()
    print(f"  Cargando modelo: {model_path}", file=sys.stderr)
    
    # Determinar el dispositivo y dtype
    if torch.cuda.is_available() and torch.cuda.device_count() > 0:
        device = "cuda"
        dtype = torch.bfloat16
        try:
            print(f"  Usando GPU: {torch.cuda.get_device_name(0)}", file=sys.stderr)
            
            # Mostrar VRAM disponible
            total_vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            free_vram = (torch.cuda.get_device_properties(0).total_memory - torch.cuda.memory_allocated(0)) / (1024**3)
            print(f"  VRAM total: {total_vram:.1f} GB, disponible: {free_vram:.1f} GB", file=sys.stderr)
        except Exception as e:
            print(f"  [WARN] Error obteniendo info GPU: {e}", file=sys.stderr)
    else:
        device = "cpu"
        dtype = torch.float32
        print("  ADVERTENCIA: Usando CPU. La generación será muy lenta.", file=sys.stderr)

    # A7: Load transformer — NO in-process recovery on corruption.
    # If corrupt, write marker + exit(66) → caller handles repair cycle.
    print("  Cargando transformer...", file=sys.stderr)
    
    try:
        transformer = ZImageTransformer2DModel.from_single_file(
            str(model_path),
            quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
            torch_dtype=dtype,
            disable_mmap=True,  # Avoid file handle retention on Windows
        )
    except (OSError, ValueError, UnicodeDecodeError, RuntimeError) as e:
        is_corruption = (
            "Unable to load weights" in str(e) or
            "cannot reshape array" in str(e) or
            "charmap" in str(e) or
            "invalid load key" in str(e)
        )

        if is_corruption:
            _log("MODEL_LOAD_CORRUPT",
                 f"Corrupt model detected: {_safe_ascii(str(e)[:200])}")
            _log("MODEL_LOAD_CORRUPT",
                 "Writing quarantine marker and exiting with code "
                 f"{EXIT_CODE_MODEL_CORRUPT}. "
                 "Caller must: stop process → quarantine .gguf → "
                 "re-download → restart.")

            # Write quarantine marker (next run will quarantine before load)
            marker = model_path.with_suffix(
                model_path.suffix + _QUARANTINE_PENDING_SUFFIX)
            try:
                marker.write_text(
                    f"corrupt_at={datetime.now().isoformat()}\n"
                    f"error={_safe_ascii(str(e)[:300])}\n",
                    encoding="utf-8",
                )
            except OSError:
                pass  # Best-effort marker

            # Exit the process — file handles will be released by OS
            raise SystemExit(EXIT_CODE_MODEL_CORRUPT)

        # Non-corruption error → propagate normally
        _log("MODEL_LOAD_FATAL", f"Failed to load model: {_safe_ascii(e)}")
        raise
    
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
                    vram_alloc = torch.cuda.memory_allocated(0) / (1024**3)
                    vram_reserved = torch.cuda.memory_reserved(0) / (1024**3)
                    vram_total = torch.cuda.get_device_properties(0).total_memory / (1024**3)
                    print(f"  [VRAM] After warmup: allocated={vram_alloc:.2f} GB, reserved={vram_reserved:.2f} GB, total={vram_total:.1f} GB", file=sys.stderr)
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


def generate_image_with_pipeline(
    pipeline, device: str, prompt: str, width: int, height: int,
    output_path: Path, steps: int = 9, guidance_scale: float = 0.0,
) -> dict:
    """
    Genera una imagen usando un pipeline ya cargado.
    Usa torch.inference_mode() para máxima velocidad.
    """
    try:
        import torch
        
        print(f"  [INFERENCE] Starting: {width}x{height}, steps={steps}, guidance={guidance_scale}", file=sys.stderr)
        seed = int(datetime.now().timestamp()) % (2**32)
        gen_device = "cuda" if device == "cuda" else "cpu"
        generator = torch.Generator(gen_device).manual_seed(seed)
        
        inf_start = time.time()
        with torch.inference_mode():
            images = pipeline(
                prompt=prompt,
                num_inference_steps=steps,
                guidance_scale=guidance_scale,
                height=height,
                width=width,
                generator=generator,
            ).images
        inf_ms = int((time.time() - inf_start) * 1000)
        print(f"  [INFERENCE] Done in {inf_ms}ms", file=sys.stderr)
        
        if not images:
            return {"ok": False, "error": "No se generó ninguna imagen"}
        
        # Guardar la primera imagen
        image = images[0]
        enc_start = time.time()
        image.save(str(output_path), format="PNG")
        enc_ms = int((time.time() - enc_start) * 1000)
        print(f"  [ENCODE_PNG] Saved in {enc_ms}ms: {output_path.name}", file=sys.stderr)
        
        return {
            "ok": True,
            "image_path": str(output_path),
            "width": width,
            "height": height,
            "inference_ms": inf_ms,
            "encode_ms": enc_ms,
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
            vram_alloc = torch.cuda.memory_allocated(0) / (1024**3)
            vram_reserved = torch.cuda.memory_reserved(0) / (1024**3)
            vram_total = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            print(f"[VRAM] After init: allocated={vram_alloc:.2f} GB, reserved={vram_reserved:.2f} GB, total={vram_total:.1f} GB", file=sys.stderr)
            print(f"[TURBO] GPU mode (CPU-offload). Model loads to GPU on-demand per forward pass.", file=sys.stderr)
            print(f"[TURBO] Ready in {total_init_time:.2f}s", file=sys.stderr)
        else:
            print("[TURBO] CPU Flash mode enabled (Slow)", file=sys.stderr)
        
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
                
                # --- Resolve width / height ---
                # Explicit width/height from job take priority over SIZE_MAP
                raw_w = job.get("width")
                raw_h = job.get("height")
                if raw_w is not None and raw_h is not None:
                    try:
                        width = int(raw_w)
                        height = int(raw_h)
                    except (ValueError, TypeError):
                        width, height = SIZE_MAP["M"]
                else:
                    size = job.get("size", "M").upper()
                    if size not in SIZE_MAP:
                        error_result = {"ok": False, "error": f"Tamaño inválido: '{size}'. Valores válidos: S, M, B"}
                        print(json.dumps(error_result, ensure_ascii=False))
                        sys.stdout.flush()
                        continue
                    width, height = SIZE_MAP[size]
                
                # Resolve steps / guidance_scale
                steps = int(job.get("steps", 9))
                guidance = float(job.get("guidance_scale", 0.0))
                
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
                
                # Forensic logging
                print(f"[JOB_DECODE] id={job_id} raw_payload_keys={list(job.keys())}", file=sys.stderr)
                print(f"[EFFECTIVE_PARAMS] width={width} height={height} steps={steps} guidance={guidance}", file=sys.stderr)
                print(f"Procesando job {job_id}: {prompt[:50]}...", file=sys.stderr)
                
                # Generar imagen usando pipeline cargado
                gen_start = time.time()
                result = generate_image_with_pipeline(
                    pipeline, device, prompt, width, height, image_output_path,
                    steps=steps, guidance_scale=guidance,
                )
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

    # Resolve width / height: explicit values take priority over SIZE_MAP
    raw_w = data.get("width")
    raw_h = data.get("height")
    if raw_w is not None and raw_h is not None:
        try:
            width = int(raw_w)
            height = int(raw_h)
        except (ValueError, TypeError):
            width, height = SIZE_MAP["M"]
    else:
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
