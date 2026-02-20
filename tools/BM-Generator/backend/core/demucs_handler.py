import logging
import os
import subprocess
import shutil
import hashlib
import sys
from pathlib import Path
from typing import Dict, Optional, Callable

logger = logging.getLogger(__name__)

DEMUCS_MODEL = "htdemucs"
DEMUCS_STEMS = ["drums", "bass", "other", "vocals"]


def check_cuda_availability() -> tuple:
    try:
        import torch
        if torch.cuda.is_available() and torch.cuda.device_count() > 0:
            return True, torch.cuda.get_device_name(0)
        return False, None
    except ImportError:
        return False, None


def _get_demucs_command() -> list:
    """
    Return the command list to invoke demucs.
    Tries demucs.exe in the active venv first, then falls back to python -m demucs.
    """
    venv_bin = Path(sys.executable).parent
    for name in ("demucs.exe", "demucs"):
        candidate = venv_bin / name
        if candidate.exists():
            return [str(candidate)]
    return [sys.executable, "-m", "demucs"]


def _ensure_torch_home():
    """
    If TORCH_HOME is not set, point it to a local vendor/torch_cache
    relative to the tool root so demucs doesn't try to download models.
    """
    if os.environ.get("TORCH_HOME"):
        return

    tool_root = Path(__file__).resolve().parents[2]
    cache_dir = tool_root / "vendor" / "torch_cache"
    if cache_dir.exists():
        os.environ["TORCH_HOME"] = str(cache_dir)
        logger.info(f"Set TORCH_HOME={cache_dir}")


def run_demucs_cli(
    input_path: Path,
    output_dir: Path,
    device: str = "cuda",
) -> Path:
    """
    Run Demucs via CLI and return the directory containing the 4 stems.
    Command: demucs -n htdemucs -o "<output_dir>" "<input_path>"
    """
    _ensure_torch_home()

    cmd_base = _get_demucs_command()
    cmd = cmd_base + [
        "-n", DEMUCS_MODEL,
        "-o", str(output_dir),
        "--device", device,
        str(input_path),
    ]

    logger.info(f"Running Demucs CLI: {' '.join(cmd)}")

    env = os.environ.copy()
    if env.get("TORCH_HOME"):
        logger.info(f"TORCH_HOME={env['TORCH_HOME']}")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=3600,
        env=env,
    )

    if result.stdout:
        for line in result.stdout.strip().split("\n"):
            logger.info(f"[demucs stdout] {line}")
    if result.stderr:
        for line in result.stderr.strip().split("\n"):
            logger.info(f"[demucs stderr] {line}")

    if result.returncode != 0:
        stderr = result.stderr or "(no stderr)"
        raise RuntimeError(f"Demucs failed (code {result.returncode}): {stderr[-500:]}")

    # Demucs writes to: <output_dir>/htdemucs/<stem_name>/
    separated_dir = output_dir / DEMUCS_MODEL / input_path.stem
    if not separated_dir.exists():
        parent = output_dir / DEMUCS_MODEL
        candidates = list(parent.iterdir()) if parent.exists() else []
        if len(candidates) == 1:
            separated_dir = candidates[0]
        else:
            raise FileNotFoundError(
                f"Expected Demucs output at {separated_dir}, found: {[str(c) for c in candidates]}"
            )

    return separated_dir


def normalize_stems(
    demucs_output_dir: Path,
    final_stems_dir: Path,
) -> Dict[str, str]:
    """
    Move/rename stems from Demucs output to the final directory,
    ensuring exactly drums.wav, bass.wav, vocals.wav, other.wav exist.
    """
    final_stems_dir.mkdir(parents=True, exist_ok=True)
    stem_paths: Dict[str, str] = {}

    for stem in DEMUCS_STEMS:
        src = demucs_output_dir / f"{stem}.wav"
        dst = final_stems_dir / f"{stem}.wav"
        if not src.exists():
            raise FileNotFoundError(f"Missing stem: {src}")
        shutil.move(str(src), str(dst))
        stem_paths[stem] = str(dst)

    return stem_paths


def compute_stem_hashes(stems_dir: Path) -> Dict[str, str]:
    """SHA-256 hashes for each stem file."""
    hashes = {}
    for stem in DEMUCS_STEMS:
        f = stems_dir / f"{stem}.wav"
        if f.exists():
            h = hashlib.sha256()
            with open(f, "rb") as fh:
                for chunk in iter(lambda: fh.read(65536), b""):
                    h.update(chunk)
            hashes[stem] = h.hexdigest()
    return hashes


def separate_track(
    input_path: Path,
    final_stems_dir: Path,
    temp_demucs_out: Path,
    job_id: str = "task",
    progress_callback: Optional[Callable] = None,
) -> Dict[str, str]:
    """Full pipeline: run Demucs CLI -> normalize stems -> return paths."""
    has_cuda, gpu_name = check_cuda_availability()
    device = "cuda" if has_cuda else "cpu"

    if progress_callback:
        hw = f"GPU: {gpu_name}" if has_cuda else "CPU"
        progress_callback(job_id, 20, f"Separating with Demucs ({hw})...")

    raw_dir = run_demucs_cli(input_path, temp_demucs_out, device=device)

    if progress_callback:
        progress_callback(job_id, 80, "Normalizing stems...")

    stems = normalize_stems(raw_dir, final_stems_dir)

    if progress_callback:
        progress_callback(job_id, 90, "Computing hashes...")

    hashes = compute_stem_hashes(final_stems_dir)
    for stem, h in hashes.items():
        logger.info(f"  {stem}.wav sha256={h[:16]}...")

    if progress_callback:
        progress_callback(job_id, 100, "Separation complete!")

    return stems
