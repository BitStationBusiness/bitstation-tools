<# 
.SYNOPSIS
    Setup automatizado para z-image-turbo
.DESCRIPTION
    Crea entorno virtual, instala dependencias, descarga modelo GGUF.
    Compatible con rutas que contienen espacios.
#>

param(
    [switch]$Force
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
$modelBaseUrl = "https://huggingface.co/jayn7/Z-Image-Turbo-GGUF/resolve/main"
$modelUrl = if ([string]::IsNullOrWhiteSpace($env:ZIMAGE_MODEL_URL)) { "$modelBaseUrl/$modelFile" } else { $env:ZIMAGE_MODEL_URL }

if ($modelUrl -match "\?download=true$") {
    $modelUrl = $modelUrl -replace "\?download=true$", ""
}
if ($modelUrl -match "=true$") {
    $modelUrl = $modelUrl -replace "=true$", ""
}
if ($modelUrl.EndsWith("/")) {
    $modelUrl = "$modelUrl$modelFile"
}
if ($modelUrl -notmatch "\.gguf($|\?)") {
    $modelUrl = "$modelBaseUrl/$modelFile"
}

$modelMinSizeMB = 10
$ggufMagic = [byte[]]@(0x47, 0x47, 0x55, 0x46)

Write-Host "=== Z-Image Turbo Setup ===" -ForegroundColor Cyan
Write-Host "Tool root: $toolRoot"

$pythonCmd = $env:BITSTATION_PYTHON
if ([string]::IsNullOrWhiteSpace($pythonCmd)) { $pythonCmd = "python" }

try {
    $pyVersion = & "$pythonCmd" --version 2>&1
    Write-Host "Python encontrado: $pyVersion" -ForegroundColor Green
}
catch {
    Write-Error "Python no encontrado. Instala Python 3.10+ y agrega al PATH."
    exit 1
}

if ($Force -and (Test-Path $venvPath)) {
    Write-Host "Eliminando entorno virtual existente..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force -LiteralPath $venvPath
}

if (!(Test-Path $venvPath)) {
    Write-Host "Creando entorno virtual en: $venvPath" -ForegroundColor Cyan
    & "$pythonCmd" -m venv "$venvPath"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Error al crear entorno virtual"
        exit 2
    }
}

$venvPython = Join-Path $venvPath "Scripts\python.exe"
$venvPip = Join-Path $venvPath "Scripts\pip.exe"

if (!(Test-Path $venvPython)) {
    Write-Error "Python del entorno virtual no encontrado: $venvPython"
    exit 3
}

Write-Host "Entorno virtual listo" -ForegroundColor Green

Write-Host "Actualizando pip..." -ForegroundColor Cyan
& "$venvPython" -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Warning "No se pudo actualizar pip, continuando..."
}

# GPU detection with timeout to avoid hangs
Write-Host "Verificando hardware de GPU..." -ForegroundColor Cyan
$hasNvidia = $false

try {
    $smiCmd = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
    if ($smiCmd) {
        $smiOutput = & $smiCmd.Source -L 2>&1
        if ($LASTEXITCODE -eq 0 -and $smiOutput) {
            $hasNvidia = $true
            Write-Host "GPU NVIDIA detectada (nvidia-smi)" -ForegroundColor Green
        }
    }
}
catch {
    Write-Warning "nvidia-smi no disponible."
}

if (-not $hasNvidia) {
    try {
        $job = Start-Job -ScriptBlock { Get-CimInstance Win32_VideoController } -ErrorAction SilentlyContinue
        if (Wait-Job $job -Timeout 5) {
            $gpuInfo = Receive-Job $job -ErrorAction SilentlyContinue
            if ($gpuInfo | Where-Object { $_.Name -match "NVIDIA" }) {
                $hasNvidia = $true
                Write-Host "GPU NVIDIA detectada (WMI)" -ForegroundColor Green
            } else {
                Write-Host "GPU NVIDIA no detectada" -ForegroundColor Yellow
            }
        }
        else {
            Write-Warning "Timeout consultando GPU por WMI (5s). Se asumira CPU."
            Stop-Job $job -Force | Out-Null
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue | Out-Null
    }
    catch {
        Write-Warning "No se pudo identificar la GPU. Se asumira CPU."
    }
}

if ($hasNvidia) {
    Write-Host "Instalando PyTorch con soporte CUDA..." -ForegroundColor Cyan
    & "$venvPip" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
}
else {
    Write-Host "Instalando PyTorch (CPU)..." -ForegroundColor Cyan
    & "$venvPip" install torch torchvision torchaudio
}

if ($LASTEXITCODE -ne 0) {
    Write-Warning "Error instalando PyTorch. Se intentara continuar..."
}

if (Test-Path $requirementsPath) {
    Write-Host "Instalando dependencias desde requirements.txt..." -ForegroundColor Cyan
    & "$venvPip" install -r "$requirementsPath"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Error al instalar dependencias"
        exit 4
    }

    Write-Host "Generando requirements.lock.txt..." -ForegroundColor Cyan
    & "$venvPip" freeze | Out-File -Encoding utf8 "$lockPath"

    Write-Host "Dependencias instaladas correctamente" -ForegroundColor Green
}
else {
    Write-Warning "requirements.txt no encontrado en: $requirementsPath"
}

# Model download with GGUF validation and retries
function Test-GGUFFile {
    param([string]$FilePath)
    if (!(Test-Path -LiteralPath $FilePath)) { return $false }
    $file = Get-Item -LiteralPath $FilePath
    if ($file.Length -lt ($modelMinSizeMB * 1MB)) { return $false }
    try {
        $fs = [System.IO.File]::OpenRead($FilePath)
        $header = New-Object byte[] 4
        $read = $fs.Read($header, 0, 4)
        $fs.Close()
        if ($read -ne 4) { return $false }
        for ($i = 0; $i -lt 4; $i++) {
            if ($header[$i] -ne $ggufMagic[$i]) { return $false }
        }
        return $true
    }
    catch {
        return $false
    }
}

$shouldDownload = $false

if (!(Test-Path -LiteralPath $modelPath)) {
    $shouldDownload = $true
    Write-Host "Modelo no encontrado, descargando..." -ForegroundColor Cyan
}
elseif (!(Test-GGUFFile $modelPath)) {
    $shouldDownload = $true
    $badPath = "$modelPath.bad.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Write-Warning "Modelo corrupto o incompleto. Moviendo a: $badPath"
    Move-Item -LiteralPath $modelPath -Destination $badPath -Force -ErrorAction SilentlyContinue
}
else {
    $modelSizeMB = [math]::Round((Get-Item -LiteralPath $modelPath).Length / 1MB, 2)
    Write-Host "Modelo validado correctamente (${modelSizeMB}MB)" -ForegroundColor Green
}

if ($shouldDownload) {
    Write-Host ""
    Write-Host "Descargando modelo GGUF..." -ForegroundColor Cyan
    Write-Host "URL: $modelUrl"
    Write-Host "Destino: $modelPath"

    if (!(Test-Path -LiteralPath $modelsDir)) {
        New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $maxRetries = 3
    $downloadSuccess = $false

    for ($retryCount = 0; $retryCount -lt $maxRetries; $retryCount++) {
        try {
            if ($retryCount -gt 0) {
                Write-Host "Reintento $retryCount de $maxRetries..." -ForegroundColor Yellow
                Start-Sleep -Seconds 3
            }

            $partPath = "$modelPath.part"
            if (Test-Path -LiteralPath $partPath) { Remove-Item -Force -LiteralPath $partPath }

            Write-Host "Descargando..." -ForegroundColor Cyan
            $wc = New-Object System.Net.WebClient
            $wc.Headers.Add("User-Agent", "BitStation/1.0")
            $wc.DownloadFile($modelUrl, $partPath)
            $wc.Dispose()

            Move-Item -LiteralPath $partPath -Destination $modelPath -Force

            if (Test-GGUFFile $modelPath) {
                $downloadedSizeMB = [math]::Round((Get-Item -LiteralPath $modelPath).Length / 1MB, 2)
                Write-Host "Modelo descargado y validado (${downloadedSizeMB}MB)" -ForegroundColor Green
                $downloadSuccess = $true
                break
            }
            else {
                throw "Archivo descargado no es un GGUF valido"
            }
        }
        catch {
            Write-Warning "Error en descarga: $_"
            Remove-Item -LiteralPath $modelPath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath "$modelPath.part" -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not $downloadSuccess) {
        Write-Error "Error al descargar el modelo despues de $maxRetries intentos"
        Write-Host "Puedes descargar manualmente desde:" -ForegroundColor Yellow
        Write-Host "  $modelUrl"
        Write-Host "Y colocarlo en:" -ForegroundColor Yellow
        Write-Host "  $modelPath"
        exit 5
    }
}

Write-Host ""
Write-Host "=== Setup completado ===" -ForegroundColor Green
Write-Host "Entorno virtual: $venvPath"
Write-Host "Modelo: $modelPath"
Write-Host ""
Write-Host "Para ejecutar manualmente:"
Write-Host "  $venvPython src\main.py --input <input.json> --output <output.json>"
