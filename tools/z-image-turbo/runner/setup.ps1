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
$modelsDir = Join-Path $toolRoot "models"

$defaultModelFile = "z_image_turbo-Q4_K_M.gguf"
$modelFile = if ([string]::IsNullOrWhiteSpace($env:ZIMAGE_MODEL_FILE)) { $defaultModelFile } else { $env:ZIMAGE_MODEL_FILE }
$modelPath = if ([string]::IsNullOrWhiteSpace($env:ZIMAGE_MODEL_PATH)) { Join-Path $modelsDir $modelFile } else { $env:ZIMAGE_MODEL_PATH }
$modelUrl = if ([string]::IsNullOrWhiteSpace($env:ZIMAGE_MODEL_URL)) { "https://huggingface.co/jayn7/Z-Image-Turbo-GGUF/resolve/main/$modelFile?download=true" } else { $env:ZIMAGE_MODEL_URL }

Write-Host "=== Z-Image Turbo Setup ===" -ForegroundColor Cyan
Write-Host "Tool root: $toolRoot"

# Verificar Python
$pythonCmd = $env:BITSTATION_PYTHON
if ([string]::IsNullOrWhiteSpace($pythonCmd)) { $pythonCmd = "python" }

try {
    $pyVersion = & $pythonCmd --version 2>&1
    Write-Host "Python encontrado: $pyVersion" -ForegroundColor Green
}
catch {
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

# Instalar PyTorch con CUDA explícitamente primero
Write-Host "Instalando PyTorch con soporte CUDA..." -ForegroundColor Cyan
& $venvPip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Error instalando PyTorch CUDA. Se intentará continuar con requirements.txt..."
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
}
else {
    Write-Warning "requirements.txt no encontrado en: $requirementsPath"
}

# Descargar modelo si no existe
if (!(Test-Path $modelPath)) {
    Write-Host ""
    Write-Host "Descargando modelo GGUF..." -ForegroundColor Cyan
    Write-Host "URL: $modelUrl"
    Write-Host "Destino: $modelPath"

    if (!(Test-Path $modelsDir)) {
        New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath
        Write-Host "Modelo descargado correctamente" -ForegroundColor Green
    }
    catch {
        Write-Error "Error al descargar el modelo: $_"
        Write-Host "Puedes descargar manualmente y definir ZIMAGE_MODEL_PATH" -ForegroundColor Yellow
        exit 5
    }
}
else {
    Write-Host "Modelo ya existe: $modelPath" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Setup completado ===" -ForegroundColor Green
Write-Host "Entorno virtual: $venvPath"
Write-Host "Modelo: $modelPath"
Write-Host ""
Write-Host "Para ejecutar manualmente:"
Write-Host "  $venvPython src\main.py --input <input.json> --output <output.json>"
