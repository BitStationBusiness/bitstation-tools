param(
  [Parameter(Mandatory=$true)]
  [Alias("input")]
  [string]$InPath,

  [Parameter(Mandatory=$true)]
  [Alias("output")]
  [string]$OutPath
)

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolDir    = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $ToolDir "backend"
$VenvDir    = Join-Path $ToolDir ".venv"
$ReqFile    = Join-Path $BackendDir "requirements.txt"

# Auto-setup if venv missing
if (-not (Test-Path $VenvDir)) {
    $SetupScript = Join-Path $ScriptDir "setup.ps1"
    if (Test-Path $SetupScript) {
        & $SetupScript
    } else {
        Write-Host "Creating virtual environment..."
        python -m venv $VenvDir
        $VenvPip = Join-Path $VenvDir "Scripts\pip.exe"
        & $VenvPip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 --quiet 2>$null
        & $VenvPip install -r $ReqFile --quiet
    }
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$CliScript  = Join-Path $BackendDir "cli.py"

if (-not (Test-Path $VenvPython)) {
    Write-Error "Python not found at $VenvPython"
    exit 1
}

if (-not (Test-Path $CliScript)) {
    Write-Error "CLI script not found at $CliScript"
    exit 1
}

$Env:PYTHONPATH = $BackendDir
& $VenvPython $CliScript --input "$InPath" --output "$OutPath"
exit $LASTEXITCODE
