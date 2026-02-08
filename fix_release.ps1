# fix_release.ps1
$ErrorActionPreference = "Stop"

Write-Host "=== Corrigiendo Release v0.5.0 ===" -ForegroundColor Cyan

# 1. Limpiar locks
Write-Host "1. Asegurando git unlocked..."
Stop-Process -Name "git" -Force -ErrorAction SilentlyContinue 2>$null
if (Test-Path .git\index.lock) {
    Remove-Item .git\index.lock -Force -ErrorAction SilentlyContinue
    Write-Host "   Lock eliminado."
}

# 2. Add & Commit (Force)
Write-Host "2. Commiteando cambios de versión..."
git add .
try {
    git commit -m "fix: handle paths with spaces and bump versions (v0.5.0)"
    Write-Host "   Commit creado exitosamente." -ForegroundColor Green
}
catch {
    $status = git status --porcelain
    if ($status) {
        Write-Error "   Falló el commit pero hay cambios pendientes. Intenta correr de nuevo."
        exit 1
    }
    Write-Host "   (Ya estaba commiteado)" -ForegroundColor Yellow
}

# 3. Mover Tag
Write-Host "3. Actualizando tag v0.5.0..."
git tag -d v0.5.0 2>$null
git push origin :refs/tags/v0.5.0 2>$null
git tag v0.5.0
git push origin v0.5.0

Write-Host "4. Subiendo cambios a main..."
git push origin main

Write-Host ""
Write-Host "=== LISTO. AHORA SÍ ===" -ForegroundColor Green
Write-Host "Verifica en Actions que se inicie el workflow."
