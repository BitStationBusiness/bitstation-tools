# fix_release_v0.5.1.ps1
$ErrorActionPreference = "Stop"

Write-Host "=== Corrigiendo Release v0.5.1 (Manual) ===" -ForegroundColor Cyan

# 1. Limpiar locks
Write-Host "1. Asegurando git unlocked..."
try {
    Stop-Process -Name "git" -Force -ErrorAction SilentlyContinue 2>$null
    if (Test-Path .git\index.lock) {
        Remove-Item .git\index.lock -Force -ErrorAction SilentlyContinue
        Write-Host "   Lock eliminado."
    }
}
catch {
    Write-Warning "   No se pudo acceder al lock. Por favor cierra VSCode si falla el siguiente paso."
}

# 2. Add & Commit
Write-Host "2. Guardando cambios (v0.5.1)..."
git add .
try {
    git commit -m "chore: bump versions to v0.5.1"
    Write-Host "   Commit creado." -ForegroundColor Green
}
catch {
    $st = git status --porcelain
    if ($st) {
        Write-Error "   Error al crear commit. Archivos bloqueados."
        exit 1
    }
    Write-Host "   (Cambios ya guardados)" -ForegroundColor Yellow
}

# 3. Mover Tag y Push
Write-Host "3. Actualizando tag v0.5.1..."
git tag -d v0.5.1 2>$null
git push origin :refs/tags/v0.5.1 2>$null
git tag v0.5.1
git push origin v0.5.1

Write-Host "4. Subiendo main..."
git push origin main

Write-Host ""
Write-Host "=== RELEASE v0.5.1 ENVIADO ===" -ForegroundColor Green
