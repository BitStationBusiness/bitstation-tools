<#
.SYNOPSIS
    Entrypoint para BM-Generator
.DESCRIPTION
    Ejecuta la herramienta BM-Generator (Music Album Creator).
    Instala automaticamente las dependencias si no existen.
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

# Auto-setup if venv missing
if (-not (Test-Path $VenvPython)) {
    Write-Host "[BM-Generator] Venv not found, running setup..." -ForegroundColor Yellow
    $SetupScript = Join-Path $ScriptDir "setup.ps1"
    if (Test-Path $SetupScript) {
        & "$SetupScript"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "[BM-Generator] Setup failed with exit code $LASTEXITCODE"
            exit 1
        }
    } else {
        Write-Error "[BM-Generator] setup.ps1 not found at $SetupScript"
        exit 1
    }
}

if (-not (Test-Path $VenvPython)) {
    Write-Error "[BM-Generator] Python not found at $VenvPython after setup"
    exit 1
}

if (-not (Test-Path $CliScript)) {
    Write-Error "[BM-Generator] CLI script not found at $CliScript"
    exit 1
}

# Set TORCH_HOME to local vendor cache so demucs doesn't try to download models
$TorchCache = Join-Path $ToolDir "vendor\torch_cache"
if (Test-Path $TorchCache) {
    $Env:TORCH_HOME = $TorchCache
    Write-Host "[BM-Generator] TORCH_HOME=$TorchCache"
}

# Ensure PYTHONPATH includes backend dir for imports
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
