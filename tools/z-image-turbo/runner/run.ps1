<#
.SYNOPSIS
    Entrypoint para z-image-turbo
.DESCRIPTION
    Ejecuta la herramienta de generación de imágenes.
    Instala automáticamente las dependencias si no existen.
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

$toolRoot = Split-Path -Parent $PSScriptRoot
$venvPath = Join-Path $toolRoot ".venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"
$setupScript = Join-Path $PSScriptRoot "setup.ps1"
$mainScript = Join-Path $toolRoot "src\main.py"

# Verificar si el entorno virtual existe
if (!(Test-Path $venvPython)) {
    Write-Host "Entorno virtual no encontrado. Ejecutando setup..." -ForegroundColor Yellow
    
    if (!(Test-Path $setupScript)) {
        Write-Error "setup.ps1 no encontrado en: $setupScript"
        exit 3
    }
    
    & $setupScript
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Setup fallido con código: $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

# Verificar main.py
if (!(Test-Path $mainScript)) {
    Write-Error "main.py no encontrado en: $mainScript"
    exit 3
}

# Ejecutar la herramienta
& $venvPython $mainScript --input $InPath --output $OutPath
exit $LASTEXITCODE
