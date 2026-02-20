$ErrorActionPreference = "Stop"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolDir    = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $ToolDir "backend"
$VenvDir    = Join-Path $ToolDir ".venv"
$ReqFile    = Join-Path $BackendDir "requirements.txt"

Write-Host "[BM-Generator] Setup starting..."

if (-not (Test-Path $VenvDir)) {
    Write-Host "[BM-Generator] Creating virtual environment..."
    python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create venv"
        exit 1
    }
}

$VenvPip    = Join-Path $VenvDir "Scripts\pip.exe"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPip)) {
    Write-Error "pip not found in venv: $VenvPip"
    exit 1
}

# Install core deps first (mutagen, pydantic)
Write-Host "[BM-Generator] Installing core dependencies..."
& $VenvPip install mutagen pydantic pydub --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "[BM-Generator] WARNING: core deps install had issues, retrying..."
    & $VenvPip install mutagen pydantic pydub
}

# Install PyTorch (needed for demucs)
Write-Host "[BM-Generator] Installing PyTorch with CUDA..."
& $VenvPip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 --quiet 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[BM-Generator] CUDA torch failed, installing CPU version..."
    & $VenvPip install torch torchvision torchaudio --quiet
}

# Install demucs
Write-Host "[BM-Generator] Installing demucs..."
& $VenvPip install demucs --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "[BM-Generator] Retrying demucs install..."
    & $VenvPip install demucs
}

# Install remaining requirements
if (Test-Path $ReqFile) {
    Write-Host "[BM-Generator] Installing requirements.txt..."
    & $VenvPip install -r $ReqFile --quiet
}

# Verify key packages
Write-Host "[BM-Generator] Verifying installations..."
& $VenvPython -c "import mutagen; print('mutagen OK')"
if ($LASTEXITCODE -ne 0) {
    Write-Error "mutagen verification failed"
    exit 1
}

& $VenvPython -c "import pydantic; print('pydantic OK')"
if ($LASTEXITCODE -ne 0) {
    Write-Error "pydantic verification failed"
    exit 1
}

$DemucsExe = Join-Path $VenvDir "Scripts\demucs.exe"
if (Test-Path $DemucsExe) {
    Write-Host "[BM-Generator] demucs executable found: OK"
} else {
    Write-Host "[BM-Generator] WARNING: demucs.exe not found, stem separation may fail"
}

Write-Host "[BM-Generator] Setup complete."
exit 0
