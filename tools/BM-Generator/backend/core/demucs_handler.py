import logging
import torch
import torchaudio
import torchaudio.functional as F
import numpy as np
from pathlib import Path
from demucs_infer import pretrained, apply, audio

# Configure logging
logger = logging.getLogger(__name__)

DEMUCS_MODEL = "htdemucs"
DEMUCS_STEMS = ["drums", "bass", "other", "vocals"]

def check_cuda_availability():
    """Checks if CUDA is available and returns GPU info."""
    try:
        if torch.cuda.is_available() and torch.cuda.device_count() > 0:
            gpu_name = torch.cuda.get_device_name(0)
            return True, gpu_name
        return False, None
    except ImportError:
        return False, None


def load_demucs_model(device_str: str = "cuda"):
    """
    Loads the Demucs model and returns it.
    """
    try:
        if device_str == "cuda" and torch.cuda.is_available() and torch.cuda.device_count() > 0:
            device = torch.device("cuda:0")
            torch.cuda.set_device(0)
            gpu_name = torch.cuda.get_device_name(0)
            logger.info(f"✅ Loading model on GPU: {gpu_name}")
        else:
            device = torch.device("cpu")
            logger.info("⚠️ Loading model on CPU")

        model = pretrained.get_model(DEMUCS_MODEL)
        model.to(device)
        model.eval()
        return model, device
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        raise e

def separate_audio(input_path: Path, output_path: Path, model, device, job_id: str = "task", progress_callback=None):
    """
    Separates audio using a pre-loaded model.
    """
    try:
        if progress_callback:
            progress_callback(job_id, 20, "Loading audio...")

        # Load audio file
        waveform = None
        sr = None
        
        # Try loading with torchaudio
        try:
            waveform, sr = torchaudio.load(str(input_path))
        except Exception as e1:
            logger.warning(f"torchaudio failed: {e1}")
            # Fallback to pydub
            try:
                from pydub import AudioSegment
                audio_segment = AudioSegment.from_file(str(input_path))
                audio_segment = audio_segment.set_frame_rate(44100)
                samples = np.array(audio_segment.get_array_of_samples())
                
                if audio_segment.sample_width == 1:
                    samples = samples.astype(np.float32) / 128.0 - 1.0
                elif audio_segment.sample_width == 2:
                    samples = samples.astype(np.float32) / 32768.0
                elif audio_segment.sample_width == 4:
                    samples = samples.astype(np.float32) / 2147483648.0
                
                if audio_segment.channels == 2:
                    samples = samples.reshape(-1, 2).T
                else:
                    samples = samples.reshape(1, -1)
                
                waveform = torch.from_numpy(samples)
                sr = audio_segment.frame_rate
            except Exception as e2:
                raise Exception(f"Failed to load audio: {e2}")

        if waveform is None:
             raise Exception("Failed to load audio file.")

        # Ensure correct dimensions
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)
        if waveform.shape[0] == 1:
            waveform = waveform.repeat(2, 1)

        # Resample if needed
        target_sr = model.samplerate
        if sr != target_sr:
            if progress_callback:
                progress_callback(job_id, 25, f"Resampling {sr}Hz -> {target_sr}Hz...")
            waveform = F.resample(waveform, sr, target_sr)
            sr = target_sr

        # Normalize
        ref = waveform.mean(0)
        waveform = (waveform - ref.mean()) / (ref.std() + 1e-8)
        wav = waveform.unsqueeze(0).to(device)

        if progress_callback:
            progress_callback(job_id, 30, f"Separating audio...")

        # Run separation
        with torch.no_grad():
            sources = apply.apply_model(
                model,
                wav,
                device=device,
                progress=False,
            )

        if progress_callback:
            progress_callback(job_id, 80, "Saving stems...")

        # Save stems
        source_names = model.sources
        samplerate = model.samplerate
        
        output_path.mkdir(parents=True, exist_ok=True)
        stem_paths = {}

        for i, stem_name in enumerate(source_names):
            if stem_name in DEMUCS_STEMS:
                stem_audio = sources[0, i]
                # Denormalize
                stem_audio = stem_audio * ref.std() + ref.mean()
                
                stem_file = output_path / f"{stem_name}.wav"
                audio.save_audio(
                    stem_audio.cpu(),
                    str(stem_file),
                    samplerate=samplerate,
                )
                stem_paths[stem_name] = str(stem_file)

        if progress_callback:
            progress_callback(job_id, 100, "Separation complete!")
            
        return stem_paths

    except Exception as e:
        logger.error(f"Demucs separation error: {e}")
        raise e

def run_demucs_separation(input_path: Path, output_path: Path, job_id: str, progress_callback=None):
    """
    Legacy wrapper for one-off separation (loads and unloads model).
    """
    use_cuda = torch.cuda.is_available() and torch.cuda.device_count() > 0
    model, device = load_demucs_model(device_str="cuda" if use_cuda else "cpu")
    return separate_audio(input_path, output_path, model, device, job_id, progress_callback)

