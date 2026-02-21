import logging
import os
import subprocess
import shutil
import hashlib
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Callable

logger = logging.getLogger(__name__)

DEMUCS_MODEL = "htdemucs"
DEMUCS_STEMS = ["drums", "bass", "other", "vocals"]

_cached_model: Any = None


def check_cuda_availability() -> tuple:
    try:
        import torch
        if torch.cuda.is_available() and torch.cuda.device_count() > 0:
            return True, torch.cuda.get_device_name(0)
        return False, None
    except ImportError:
        return False, None


def preload_model(device: str = "auto"):
    """Pre-load the demucs model for in-process separation."""
    global _cached_model
    try:
        import torch
        from demucs.pretrained import get_model
        _cached_model = get_model(DEMUCS_MODEL)
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda":
            _cached_model = _cached_model.cuda()
            logger.info(f"[DEMUCS] Model loaded on GPU: {torch.cuda.get_device_name(0)}")
        else:
            logger.info("[DEMUCS] Model loaded on CPU")
    except Exception as e:
        _cached_model = None
        logger.warning(f"[DEMUCS] Model preload failed: {e}")


def _ensure_torch_home():
    if os.environ.get("TORCH_HOME"):
        return
    tool_root = Path(__file__).resolve().parents[2]
    cache_dir = tool_root / "vendor" / "torch_cache"
    if cache_dir.exists():
        os.environ["TORCH_HOME"] = str(cache_dir)
        logger.info(f"Set TORCH_HOME={cache_dir}")


def _load_audio(input_path: Path, target_sr: Optional[int] = None):
    """
    Load audio using soundfile (avoids torchcodec dependency in newer torchaudio).
    Falls back to torchaudio with explicit soundfile backend if direct sf fails.
    """
    import torch

    try:
        import soundfile as sf
        data, sr = sf.read(str(input_path), dtype="float32")
        if data.ndim == 1:
            wav = torch.from_numpy(data).unsqueeze(0)
        else:
            wav = torch.from_numpy(data.T.copy())

        if target_sr and sr != target_sr:
            import julius
            wav = julius.resample_frac(wav, sr, target_sr)
            sr = target_sr
        return wav, sr
    except Exception as sf_err:
        logger.warning(f"soundfile load failed ({sf_err}), trying torchaudio with soundfile backend...")
        import torchaudio
        try:
            wav, sr = torchaudio.load(str(input_path), backend="soundfile")
        except TypeError:
            wav, sr = torchaudio.load(str(input_path))
        if target_sr and sr != target_sr:
            wav = torchaudio.functional.resample(wav, sr, target_sr)
            sr = target_sr
        return wav, sr


def _save_audio(path: Path, wav, sr: int):
    """
    Save audio tensor as WAV using soundfile (avoids torchcodec dependency).
    Falls back to torchaudio with explicit soundfile backend if direct sf fails.
    """
    try:
        import soundfile as sf
        wav_np = wav.cpu().numpy()
        if wav_np.ndim == 2:
            wav_np = wav_np.T
        sf.write(str(path), wav_np, sr, subtype="PCM_16")
    except Exception as sf_err:
        logger.warning(f"soundfile save failed ({sf_err}), trying torchaudio with soundfile backend...")
        import torchaudio
        try:
            torchaudio.save(str(path), wav, sr, backend="soundfile")
        except TypeError:
            torchaudio.save(str(path), wav, sr)


def run_demucs_inprocess(
    input_path: Path,
    output_dir: Path,
    device: str = "cuda",
) -> Path:
    """
    Separate stems using the in-process demucs Python API.
    Uses soundfile for I/O to avoid torchcodec dependency.
    """
    global _cached_model
    _ensure_torch_home()

    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    if _cached_model is None:
        _cached_model = get_model(DEMUCS_MODEL)
        if device == "cuda" and torch.cuda.is_available():
            _cached_model = _cached_model.cuda()

    model = _cached_model
    model_device = next(model.parameters()).device

    wav, sr = _load_audio(input_path, target_sr=model.samplerate)

    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()

    with torch.no_grad():
        sources = apply_model(model, wav[None].to(model_device))

    sources = sources * ref.std() + ref.mean()

    stem_dir = output_dir / DEMUCS_MODEL / input_path.stem
    stem_dir.mkdir(parents=True, exist_ok=True)

    for idx, name in enumerate(model.sources):
        stem_wav = sources[0, idx].cpu()
        _save_audio(stem_dir / f"{name}.wav", stem_wav, model.samplerate)
        logger.info(f"  Saved {name}.wav")

    return stem_dir


# Python code injected into the CLI subprocess to patch torchaudio.save,
# avoiding the torchcodec ImportError when saving separated stems.
_CLI_WRAPPER = """\
import sys
sys.argv[0] = "demucs"
try:
    import soundfile as _sf
    import torchaudio as _ta
    _orig_save = _ta.save
    def _patched_save(filepath, src, sample_rate, **kw):
        fpath = str(filepath)
        if fpath.lower().endswith((".wav", ".flac")):
            wav_np = src.cpu().numpy()
            if wav_np.ndim == 2:
                wav_np = wav_np.T
            enc = kw.get("encoding", "PCM_S")
            bps = kw.get("bits_per_sample", 16)
            if enc == "PCM_F":
                sub = "FLOAT"
            elif bps == 24:
                sub = "PCM_24"
            elif bps == 32:
                sub = "PCM_32"
            else:
                sub = "PCM_16"
            _sf.write(fpath, wav_np, sample_rate, subtype=sub)
        else:
            _orig_save(filepath, src, sample_rate, **kw)
    _ta.save = _patched_save
except Exception:
    pass
from demucs.separate import main
main()
"""


def run_demucs_cli(
    input_path: Path,
    output_dir: Path,
    device: str = "cuda",
) -> Path:
    """
    Run Demucs via CLI subprocess with torchaudio patched to use soundfile,
    avoiding the torchcodec dependency for saving stems.
    """
    _ensure_torch_home()

    cmd = [
        sys.executable, "-c", _CLI_WRAPPER,
        "-n", DEMUCS_MODEL,
        "-o", str(output_dir),
        "--device", device,
        str(input_path),
    ]

    logger.info(
        f"Running Demucs CLI: {sys.executable} -c [wrapper] "
        f"-n {DEMUCS_MODEL} -o {output_dir} --device {device} {input_path}"
    )

    env = os.environ.copy()
    if env.get("TORCH_HOME"):
        logger.info(f"TORCH_HOME={env['TORCH_HOME']}")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=7200,
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
    """Full pipeline: in-process demucs (preferred) -> CLI fallback -> normalize -> hashes."""
    has_cuda, gpu_name = check_cuda_availability()
    device = "cuda" if has_cuda else "cpu"

    if progress_callback:
        hw = f"GPU: {gpu_name}" if has_cuda else "CPU"
        progress_callback(job_id, 20, f"Separating with Demucs ({hw})...")

    raw_dir = None
    try:
        raw_dir = run_demucs_inprocess(input_path, temp_demucs_out, device=device)
        logger.info("In-process demucs separation succeeded")
    except Exception as e:
        logger.warning(f"In-process demucs failed ({e}), falling back to CLI...")
        try:
            raw_dir = run_demucs_cli(input_path, temp_demucs_out, device=device)
        except Exception as cli_err:
            raise RuntimeError(
                f"Both in-process and CLI demucs failed. "
                f"In-process: {e} | CLI: {cli_err}"
            ) from cli_err

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
