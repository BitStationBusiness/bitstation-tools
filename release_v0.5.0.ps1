# release_v0.5.0.ps1
$ErrorActionPreference = "Stop"

Write-Host "=== Iniciando Release Manual v0.5.0 ===" -ForegroundColor Cyan

# 1. Intentar limpiar bloqueos
Write-Host "1. Limpiando bloqueos de git..."
try {
    Stop-Process -Name "git" -Force -ErrorAction SilentlyContinue
    if (Test-Path .git\index.lock) {
        Remove-Item .git\index.lock -Force
        Write-Host "   Lock eliminado." -ForegroundColor Green
    }
} catch {
    Write-Warning "   No se pudo limpiar algunos bloqueos, continuando..."
}

# 2. Add & Commit
Write-Host "2. Guardando cambios..."
git add .
try {
    git commit -m "fix: handle paths with spaces in Windows usernames and bump versions"
    Write-Host "   Cambios guardados." -ForegroundColor Green
} catch {
    $out = git status --porcelain
    if ($out) {
        Write-Error "   Error al hacer commit. Por favor verifica manualment."
        exit 1
    } else {
        Write-Host "   Nada que guardar (ya estaba commiteado)." -ForegroundColor Yellow
    }
}

# 3. Push Commit
Write-Host "3. Subiendo cambios..."
git push

# 4. Tag cleanup (local & remote)
Write-Host "4. Re-creando tag v0.5.0..."
git tag -d v0.5.0 2>$null
git push origin :refs/tags/v0.5.0 2>$null

# 5. Tag & Push Tag
git tag v0.5.0
git push origin v0.5.0

Write-Host ""
Write-Host "=== RELEASE COMPLETADO EXITOSAMENTE ===" -ForegroundColor Green
Write-Host "Verifica en GitHub Actions: https://github.com/BitStationBusiness/bitstation-tools/actions"
