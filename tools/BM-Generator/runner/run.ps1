# Runner for BM-Generator
# This script sets up the environment and runs the backend CLI

param(
  [Parameter(Mandatory=$true)]
  [Alias("input")]
  [string]$InPath,

  [Parameter(Mandatory=$true)]
  [Alias("output")]
  [string]$OutPath
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolDir = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $ToolDir "backend"
$VenvDir = Join-Path $ToolDir ".venv"

# 1. Ensure Python Environment
if (-not (Test-Path $VenvDir)) {
    Write-Host "Creating virtual environment..."
    python -m venv $VenvDir
    
    # Install dependencies on first run
    $VenvPip = Join-Path $VenvDir "Scripts\pip.exe"
    
    # Force install torch with CUDA support first!
    # Using CUDA 12.1 which is generally stable for recent RTX cards
    Write-Host "Installing PyTorch with CUDA support..."
    & $VenvPip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 --quiet

    Write-Host "Installing other dependencies..."
    & $VenvPip install -r (Join-Path $BackendDir "requirements.txt") --quiet
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$CliScript = Join-Path $BackendDir "cli.py"

if (-not (Test-Path $VenvPython)) {
    Write-Error "Virtual environment python not found at $VenvPython"
    exit 1
}

if (-not (Test-Path $CliScript)) {
    Write-Error "CLI script not found at $CliScript"
    exit 1
}

# 2. Run the CLI
$Env:PYTHONPATH = $BackendDir
& $VenvPython $CliScript --input "$InPath" --output "$OutPath"
exit $LASTEXITCODE
