# BM-Generator Vendor Directory

This directory holds offline dependencies for air-gapped / no-internet installations.

## Structure

```
vendor/
  wheels/        # Python wheel files (.whl) for pip --no-index --find-links
  models/        # Demucs model weights (.th files)
  torch_cache/   # PyTorch hub cache (auto-managed by setup.ps1)
```

## How to populate wheels/ (for release pipeline)

On a machine WITH internet, from the tool root:

```powershell
pip download -r requirements.txt -d vendor/wheels
pip download torch torchaudio --index-url https://download.pytorch.org/whl/cu121 -d vendor/wheels
pip download demucs -d vendor/wheels
```

## How to populate models/ (htdemucs weights)

1. Run demucs once on a machine with internet to cache the model:
   ```
   demucs -n htdemucs some_audio.wav
   ```
2. The model weights will be at:
   ```
   %USERPROFILE%\.cache\torch\hub\checkpoints\htdemucs-*.th
   ```
   or under TORCH_HOME if set.
3. Copy all `.th` files to `vendor/models/`.

setup.ps1 will automatically copy them to `vendor/torch_cache/hub/checkpoints/`
so demucs finds them without internet.

## Notes

- `wheels/` and `models/` are in .gitignore (too large for git).
- They are packaged into the release ZIP by the CI/CD pipeline.
- If `vendor/wheels` exists, setup.ps1 uses offline mode automatically.
