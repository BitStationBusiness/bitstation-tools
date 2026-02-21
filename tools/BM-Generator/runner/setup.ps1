<#
.SYNOPSIS
    Setup automatizado para BM-Generator
.DESCRIPTION
    Crea entorno virtual, instala dependencias (offline desde vendor/wheels si existe,
    o fallback a internet), y verifica imports criticos.
    Compatible con rutas con espacios y caracteres especiales en Windows.
#>

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolDir = Split-Path -Parent $ScriptDir
$VenvDir = Join-Path $ToolDir ".venv"
$ReqFile = Join-Path $ToolDir "requirements.txt"
$BackendReq = Join-Path $ToolDir "backend\requirements.txt"
$VendorWheels = Join-Path $ToolDir "vendor\wheels"
$VendorModels = Join-Path $ToolDir "vendor\models"
$TorchCache = Join-Path $ToolDir "vendor\torch_cache"

Write-Host "=== BM-Generator Setup ===" -ForegroundColor Cyan
Write-Host "Tool root : $ToolDir"
Write-Host "Venv      : $VenvDir"

# Determine which requirements file to use (root takes precedence)
if (Test-Path $ReqFile) {
    $RequirementsFile = $ReqFile
}
elseif (Test-Path $BackendReq) {
    $RequirementsFile = $BackendReq
}
else {
    Write-Error "requirements.txt not found at $ReqFile or $BackendReq"
    exit 1
}
Write-Host "Reqs file : $RequirementsFile"

$OfflineMode = Test-Path $VendorWheels
if ($OfflineMode) {
    Write-Host "Offline mode: vendor/wheels detected" -ForegroundColor Green
}
else {
    Write-Host "Online mode: vendor/wheels not found, will install from PyPI" -ForegroundColor Yellow
}

# --- Python detection ---
$PythonCmd = $env:BITSTATION_PYTHON
if ([string]::IsNullOrWhiteSpace($PythonCmd)) { $PythonCmd = "python" }

try {
    $pyVersion = & "$PythonCmd" --version 2>&1
    Write-Host "Python: $pyVersion" -ForegroundColor Green
}
catch {
    Write-Error "Python not found. Install Python 3.10+ and add to PATH."
    exit 1
}

# --- Create venv ---
if ($Force -and (Test-Path $VenvDir)) {
    Write-Host "Removing existing venv (--Force)..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force -LiteralPath $VenvDir
}

if (-not (Test-Path $VenvDir)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    & "$PythonCmd" -m venv "$VenvDir"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create venv"
        exit 1
    }
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Error "Venv python not found at: $VenvPython"
    exit 1
}

Write-Host "Venv ready" -ForegroundColor Green

# --- Upgrade pip ---
Write-Host "Upgrading pip..." -ForegroundColor Cyan
& "$VenvPython" -m pip install --upgrade pip --quiet 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not upgrade pip, continuing..."
}

# --- Install dependencies ---
if ($OfflineMode) {
    Write-Host "Installing dependencies OFFLINE from vendor/wheels..." -ForegroundColor Cyan
    & "$VenvPip" install --no-index --find-links "$VendorWheels" -r "$RequirementsFile" --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Offline install had issues, retrying with verbose..." -ForegroundColor Yellow
        & "$VenvPip" install --no-index --find-links "$VendorWheels" -r "$RequirementsFile"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Offline dependency installation failed. Ensure all wheels are in vendor/wheels/"
            exit 1
        }
    }
}
else {
    # Online: pin numpy <2 first (numpy 2.x has C-extension loading bugs with torch)
    Write-Host "Pinning numpy <2.0..." -ForegroundColor Cyan
    & "$VenvPip" install "numpy>=1.24,<2.0" --quiet

    Write-Host "Installing core dependencies (pydantic, mutagen, pydub, soundfile)..." -ForegroundColor Cyan
    & "$VenvPip" install pydantic mutagen pydub soundfile --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Core deps install had issues, retrying..."
        & "$VenvPip" install pydantic mutagen pydub soundfile
    }

    # GPU detection
    Write-Host "Checking GPU..." -ForegroundColor Cyan
    $hasNvidia = $false
    try {
        $smiCmd = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
        if ($smiCmd) {
            $smiOutput = & $smiCmd.Source -L 2>&1
            if ($LASTEXITCODE -eq 0 -and $smiOutput) {
                $hasNvidia = $true
                Write-Host "NVIDIA GPU detected" -ForegroundColor Green
            }
        }
    }
    catch { }

    if (-not $hasNvidia) {
        try {
            $job = Start-Job -ScriptBlock { Get-CimInstance Win32_VideoController } -ErrorAction SilentlyContinue
            if (Wait-Job $job -Timeout 5) {
                $gpuInfo = Receive-Job $job -ErrorAction SilentlyContinue
                if ($gpuInfo | Where-Object { $_.Name -match "NVIDIA" }) {
                    $hasNvidia = $true
                    Write-Host "NVIDIA GPU detected (WMI)" -ForegroundColor Green
                }
            }
            else {
                Stop-Job $job -Force | Out-Null
            }
            Remove-Job $job -Force -ErrorAction SilentlyContinue | Out-Null
        }
        catch { }
    }

    # Install PyTorch (--extra-index-url keeps PyPI available for numpy/other deps)
    if ($hasNvidia) {
        Write-Host "Installing PyTorch with CUDA..." -ForegroundColor Cyan
        & "$VenvPip" install torch torchaudio --extra-index-url https://download.pytorch.org/whl/cu121 --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "CUDA torch failed, falling back to CPU..." -ForegroundColor Yellow
            & "$VenvPip" install torch torchaudio --quiet
        }
    }
    else {
        Write-Host "Installing PyTorch (CPU)..." -ForegroundColor Cyan
        & "$VenvPip" install torch torchaudio --quiet
    }

    # Install demucs
    Write-Host "Installing demucs..." -ForegroundColor Cyan
    & "$VenvPip" install demucs --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Retrying demucs install..." -ForegroundColor Yellow
        & "$VenvPip" install demucs
    }

    # Re-enforce numpy <2 (demucs may have upgraded it)
    Write-Host "Enforcing numpy <2.0 compatibility..." -ForegroundColor Cyan
    & "$VenvPip" install "numpy>=1.24,<2.0" --quiet

    # Install remaining from requirements.txt
    Write-Host "Installing requirements.txt..." -ForegroundColor Cyan
    & "$VenvPip" install -r "$RequirementsFile" --quiet
}

# --- Set up torch cache for offline model loading ---
if (-not (Test-Path $TorchCache)) {
    New-Item -ItemType Directory -Force -Path $TorchCache | Out-Null
}

# If vendor/models contains demucs weights, copy to torch cache
if (Test-Path $VendorModels) {
    $demucsCheckpoints = Join-Path $TorchCache "hub\checkpoints"
    if (-not (Test-Path $demucsCheckpoints)) {
        New-Item -ItemType Directory -Force -Path $demucsCheckpoints | Out-Null
    }
    $modelFiles = Get-ChildItem -Path $VendorModels -Filter "*.th" -ErrorAction SilentlyContinue
    foreach ($mf in $modelFiles) {
        $dest = Join-Path $demucsCheckpoints $mf.Name
        if (-not (Test-Path $dest)) {
            Write-Host "Copying model: $($mf.Name) -> torch_cache" -ForegroundColor Cyan
            Copy-Item -LiteralPath $mf.FullName -Destination $dest
        }
    }
}

# --- Verify critical imports ---
Write-Host ""
Write-Host "=== Verifying installations ===" -ForegroundColor Cyan

$verifyScript = @"
import sys
errors = []
for mod in ['pydantic', 'mutagen', 'pydub', 'soundfile']:
    try:
        __import__(mod)
        print(f'  {mod}: OK')
    except ImportError as e:
        errors.append(f'{mod}: FAILED ({e})')
        print(f'  {mod}: FAILED')
try:
    import torch
    cuda = 'CUDA' if torch.cuda.is_available() else 'CPU'
    print(f'  torch: OK ({cuda})')
except ImportError:
    errors.append('torch: FAILED')
    print('  torch: FAILED')
try:
    import demucs
    print(f'  demucs: OK')
except ImportError:
    errors.append('demucs: FAILED')
    print('  demucs: FAILED (stem separation will not work)')
if errors:
    print(f'\nWARNING: {len(errors)} package(s) failed verification')
    for e in errors:
        print(f'  - {e}')
    critical = [e for e in errors if 'pydantic' in e or 'mutagen' in e]
    if critical:
        sys.exit(1)
print('\nAll critical packages verified.')
"@

& "$VenvPython" -c $verifyScript
if ($LASTEXITCODE -ne 0) {
    Write-Error "Critical package verification failed. Cannot continue."
    exit 1
}

# Check for demucs executable
$DemucsExe = Join-Path $VenvDir "Scripts\demucs.exe"
if (Test-Path $DemucsExe) {
    Write-Host "  demucs.exe: found" -ForegroundColor Green
}
else {
    Write-Host "  demucs.exe: NOT found (will use python -m demucs as fallback)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== BM-Generator Setup Complete ===" -ForegroundColor Green
Write-Host "Venv   : $VenvDir"
Write-Host "Python : $VenvPython"
Write-Host ""
exit 0
