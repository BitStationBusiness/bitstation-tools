<#
.SYNOPSIS
    Entrypoint para BM-Generator
.DESCRIPTION
    Ejecuta la herramienta BM-Generator (Music Album Creator).
    Instala automaticamente las dependencias si no existen o estan incompletas.
    Compatible con rutas con espacios.
#>

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
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$CliScript  = Join-Path $BackendDir "cli.py"

function Test-VenvPackages {
    if (-not (Test-Path $VenvPython)) { return $false }
    $result = & "$VenvPython" -c "import pydantic; import mutagen; print('OK')" 2>&1
    return ($LASTEXITCODE -eq 0)
}

function Run-Setup {
    Write-Host "[BM-Generator] Running setup..." -ForegroundColor Yellow
    $SetupScript = Join-Path $ScriptDir "setup.ps1"
    if (-not (Test-Path $SetupScript)) {
        Write-Error "[BM-Generator] setup.ps1 not found at $SetupScript"
        exit 1
    }
    & "$SetupScript"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[BM-Generator] Setup failed with exit code $LASTEXITCODE"
        exit 1
    }
}

# Check if venv exists AND has critical packages
if (-not (Test-VenvPackages)) {
    if (-not (Test-Path $VenvPython)) {
        Write-Host "[BM-Generator] Venv not found, running setup..."
    } else {
        Write-Host "[BM-Generator] Venv exists but packages missing, running setup..."
    }
    Run-Setup

    # Verify again after setup
    if (-not (Test-VenvPackages)) {
        Write-Error "[BM-Generator] Setup completed but critical packages still missing"
        exit 1
    }
}

if (-not (Test-Path $CliScript)) {
    Write-Error "[BM-Generator] CLI script not found at $CliScript"
    exit 1
}

# Set TORCH_HOME to local vendor cache so demucs doesn't try to download models
$TorchCache = Join-Path $ToolDir "vendor\torch_cache"
if (Test-Path $TorchCache) {
    $Env:TORCH_HOME = $TorchCache
}

$Env:PYTHONPATH = $BackendDir

Write-Host "[BM-Generator] Running: $VenvPython $CliScript"
Write-Host "[BM-Generator] Input : $InPath"
Write-Host "[BM-Generator] Output: $OutPath"

& "$VenvPython" "$CliScript" --input "$InPath" --output "$OutPath"
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Host "[BM-Generator] CLI exited with code $exitCode" -ForegroundColor Red
}

exit $exitCode
