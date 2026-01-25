<# 
.SYNOPSIS
    Setup automatizado para z-image-turbo
.DESCRIPTION
    Crea entorno virtual e instala todas las dependencias automáticamente.
    Este script se ejecuta una sola vez o cuando se necesite reinstalar.
#>

param(
    [switch]$Force  # Fuerza reinstalación completa
)

$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $PSScriptRoot
$venvPath = Join-Path $toolRoot ".venv"
$requirementsPath = Join-Path $toolRoot "requirements.txt"
$lockPath = Join-Path $toolRoot "requirements.lock.txt"

Write-Host "=== Z-Image Turbo Setup ===" -ForegroundColor Cyan
Write-Host "Tool root: $toolRoot"

# Verificar Python
$pythonCmd = $env:BITSTATION_PYTHON
if ([string]::IsNullOrWhiteSpace($pythonCmd)) { $pythonCmd = "python" }

try {
    $pyVersion = & $pythonCmd --version 2>&1
    Write-Host "Python encontrado: $pyVersion" -ForegroundColor Green
} catch {
    Write-Error "Python no encontrado. Instala Python 3.10+ y agrega al PATH."
    exit 1
}

# Crear o recrear entorno virtual
if ($Force -and (Test-Path $venvPath)) {
    Write-Host "Eliminando entorno virtual existente..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $venvPath
}

if (!(Test-Path $venvPath)) {
    Write-Host "Creando entorno virtual en: $venvPath" -ForegroundColor Cyan
    & $pythonCmd -m venv $venvPath
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Error al crear entorno virtual"
        exit 2
    }
}

# Activar entorno virtual
$venvPython = Join-Path $venvPath "Scripts\python.exe"
$venvPip = Join-Path $venvPath "Scripts\pip.exe"

if (!(Test-Path $venvPython)) {
    Write-Error "Python del entorno virtual no encontrado: $venvPython"
    exit 3
}

Write-Host "Entorno virtual listo" -ForegroundColor Green

# Actualizar pip
Write-Host "Actualizando pip..." -ForegroundColor Cyan
& $venvPython -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Warning "No se pudo actualizar pip, continuando..."
}

# Instalar dependencias
if (Test-Path $requirementsPath) {
    Write-Host "Instalando dependencias desde requirements.txt..." -ForegroundColor Cyan
    & $venvPip install -r $requirementsPath
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Error al instalar dependencias"
        exit 4
    }
    
    # Generar lock file
    Write-Host "Generando requirements.lock.txt..." -ForegroundColor Cyan
    & $venvPip freeze | Out-File -Encoding utf8 $lockPath
    
    Write-Host "Dependencias instaladas correctamente" -ForegroundColor Green
} else {
    Write-Warning "requirements.txt no encontrado en: $requirementsPath"
}

Write-Host ""
Write-Host "=== Setup completado ===" -ForegroundColor Green
Write-Host "Entorno virtual: $venvPath"
Write-Host ""
Write-Host "Para ejecutar manualmente:"
Write-Host "  $venvPython src\main.py --input <input.json> --output <output.json>"
