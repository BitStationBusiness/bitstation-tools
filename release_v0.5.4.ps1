# Release v0.5.4 - BitStation Tools
# Este script prepara y publica la release v0.5.4 en GitHub
#
# Herramientas incluidas:
# - add v0.1.4
# - BM-Generator v1.0.0
# - z-image-turbo v0.5.4

param(
    [switch]$SkipBuild = $false,
    [switch]$SkipCommit = $false,
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot

Write-Host "=== BitStation Tools - Release v0.5.4 ===" -ForegroundColor Cyan
Write-Host ""

# Paso 1: Limpiar archivos bloqueados
Write-Host "[1/7] Limpiando archivos bloqueados..." -ForegroundColor Yellow
if (Test-Path "$RepoRoot\.git\index.lock") {
    Remove-Item "$RepoRoot\.git\index.lock" -Force -ErrorAction SilentlyContinue
    Write-Host "  ✓ Eliminado .git/index.lock" -ForegroundColor Green
}

if (Test-Path "$RepoRoot\dist\tool_z-image-turbo_0.5.4.zip") {
    try {
        Remove-Item "$RepoRoot\dist\tool_z-image-turbo_0.5.4.zip*" -Force -ErrorAction Stop
        Write-Host "  ✓ Eliminado ZIP antiguo de z-image-turbo" -ForegroundColor Green
    } catch {
        Write-Host "  ⚠ No se puede eliminar ZIP antiguo (en uso), continuando..." -ForegroundColor Yellow
    }
}

# Paso 2: Validar tools
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "[2/7] Validando herramientas..." -ForegroundColor Yellow
    python "$RepoRoot\build\validate_tools.py"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ Validación fallida" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✓ Validación exitosa" -ForegroundColor Green

    # Paso 3: Generar manifiestos
    Write-Host ""
    Write-Host "[3/7] Generando manifiestos..." -ForegroundColor Yellow
    python "$RepoRoot\build\generate_manifest.py"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ Generación de manifiestos fallida" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✓ Manifiestos generados" -ForegroundColor Green

    # Paso 4: Empaquetar tools
    Write-Host ""
    Write-Host "[4/7] Empaquetando herramientas..." -ForegroundColor Yellow
    python "$RepoRoot\build\pack_tools.py"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ Empaquetado fallido" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✓ Herramientas empaquetadas" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[2-4/7] Saltando build (--SkipBuild)" -ForegroundColor Gray
}

# Paso 5: Verificar archivos dist
Write-Host ""
Write-Host "[5/7] Verificando archivos de distribución..." -ForegroundColor Yellow
$requiredFiles = @(
    "dist/catalog.json",
    "dist/tool_add_0.1.4.zip",
    "dist/tool_bm-generator_1.0.0.zip",
    "dist/tool_z-image-turbo_0.5.4.zip"
)

$missingFiles = @()
foreach ($file in $requiredFiles) {
    $fullPath = Join-Path $RepoRoot $file
    if (-not (Test-Path $fullPath)) {
        $missingFiles += $file
        Write-Host "  ✗ Falta: $file" -ForegroundColor Red
    } else {
        $size = (Get-Item $fullPath).Length / 1MB
        Write-Host "  ✓ $file ($([math]::Round($size, 2)) MB)" -ForegroundColor Green
    }
}

if ($missingFiles.Count -gt 0) {
    Write-Host ""
    Write-Host "ADVERTENCIA: Faltan archivos. La release estará incompleta." -ForegroundColor Yellow
    Write-Host "Archivos faltantes:" -ForegroundColor Yellow
    $missingFiles | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host ""
    $continue = Read-Host "¿Continuar de todos modos? (y/N)"
    if ($continue -ne "y") {
        Write-Host "Operación cancelada" -ForegroundColor Red
        exit 1
    }
}

# Paso 6: Commit y tag
if (-not $SkipCommit) {
    Write-Host ""
    Write-Host "[6/7] Creando commit y tag..." -ForegroundColor Yellow
    
    # Stage cambios
    git add .gitignore
    git add .github/workflows/release.yml
    git add README.md
    git add build/*.py
    git add tools/z-image-turbo/tool.json
    git add tools/*/manifest.json
    git add tools/BM-Generator/requirements.lock.txt
    
    # Commit
    $commitMsg = @"
release: v0.5.4 - Add BM-Generator + exclude models from git

Tools incluidas:
- add v0.1.4 (sin cambios)
- BM-Generator v1.0.0 (nueva tool)
- z-image-turbo v0.5.4 (bump version, models excluidos)

Cambios:
- Excluir modelos GGUF de git/releases (descarga desde HuggingFace)
- Agregar BM-Generator (generador de álbumes musicales)
- Actualizar sistema de exclusiones en build scripts
- Generar manifests para actualización diferencial
"@
    
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) {
        Write-Host "  ✗ Commit fallido" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✓ Commit creado" -ForegroundColor Green
    
    # Tag
    git tag -f v0.5.4
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ Tag fallido" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✓ Tag v0.5.4 creado" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[6/7] Saltando commit (--SkipCommit)" -ForegroundColor Gray
}

# Paso 7: Push y release
Write-Host ""
Write-Host "[7/7] Publicando en GitHub..." -ForegroundColor Yellow

if ($DryRun) {
    Write-Host "  [DRY RUN] No se ejecutarán comandos de push" -ForegroundColor Gray
    Write-Host "  Comandos que se ejecutarían:" -ForegroundColor Gray
    Write-Host "    git push origin main" -ForegroundColor Gray
    Write-Host "    git push -f origin v0.5.4" -ForegroundColor Gray
    Write-Host ""
    Write-Host "=== Release preparada (DRY RUN) ===" -ForegroundColor Cyan
    exit 0
}

# Push commits
Write-Host "  Subiendo commits..." -ForegroundColor White
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Push fallido" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Commits subidos" -ForegroundColor Green

# Push tag (force para sobrescribir si existe)
Write-Host "  Subiendo tag v0.5.4..." -ForegroundColor White
git push -f origin v0.5.4
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Push del tag fallido" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Tag subido" -ForegroundColor Green

Write-Host ""
Write-Host "=== Release v0.5.4 publicada exitosamente ===" -ForegroundColor Green
Write-Host ""
Write-Host "El workflow de GitHub Actions empaquetará y publicará automáticamente los assets." -ForegroundColor Cyan
Write-Host "Verifica el progreso en: https://github.com/BitStationBusiness/bitstation-tools/actions" -ForegroundColor Cyan
Write-Host ""
Write-Host "Importante: Elimina manualmente el draft v0.5.3 desde:" -ForegroundColor Yellow
Write-Host "https://github.com/BitStationBusiness/bitstation-tools/releases" -ForegroundColor Yellow
Write-Host ""
