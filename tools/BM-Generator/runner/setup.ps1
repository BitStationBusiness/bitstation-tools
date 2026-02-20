$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolDir   = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $ToolDir "backend"
$VenvDir    = Join-Path $ToolDir ".venv"
$ReqFile    = Join-Path $BackendDir "requirements.txt"

Write-Host "[BM-Generator] Setup starting..."

if (-not (Test-Path $VenvDir)) {
    Write-Host "[BM-Generator] Creating virtual environment..."
    python -m venv $VenvDir
}

$VenvPip    = Join-Path $VenvDir "Scripts\pip.exe"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPip)) {
    Write-Error "pip not found in venv: $VenvPip"
    exit 1
}

Write-Host "[BM-Generator] Installing PyTorch with CUDA..."
& $VenvPip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 --quiet 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[BM-Generator] CUDA torch failed, installing CPU version..."
    & $VenvPip install torch torchvision torchaudio --quiet
}

Write-Host "[BM-Generator] Installing dependencies..."
& $VenvPip install -r $ReqFile --quiet

# Verify demucs is accessible
$DemucsExe = Join-Path $VenvDir "Scripts\demucs.exe"
if (-not (Test-Path $DemucsExe)) {
    Write-Host "[BM-Generator] WARNING: demucs executable not found at $DemucsExe"
    Write-Host "[BM-Generator] Trying pip install demucs explicitly..."
    & $VenvPip install demucs --quiet
}

Write-Host "[BM-Generator] Setup complete."
