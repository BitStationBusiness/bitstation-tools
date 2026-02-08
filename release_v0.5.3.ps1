# release_v0.5.3.ps1
$ErrorActionPreference = "Stop"

Write-Host "=== Iniciando Release Manual v0.5.3 ===" -ForegroundColor Cyan

# 1. Intentar limpiar bloqueos antiguos
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

# 2. Verificar version en tool.json
Write-Host "2. Verificando versión..."
$toolJson = Get-Content "tools/z-image-turbo/tool.json" | ConvertFrom-Json
if ($toolJson.version -ne "0.5.3") {
    Write-Error "   La versión en tool.json no es 0.5.3 (es $($toolJson.version)). Por favor corrige esto antes de continuar."
    exit 1
}
Write-Host "   Versión correcta: $($toolJson.version)" -ForegroundColor Green

# 3. Add & Commit
Write-Host "3. Guardando cambios..."
git add .
try {
    git commit -m "chore: release v0.5.3"
    Write-Host "   Cambios guardados." -ForegroundColor Green
} catch {
    $out = git status --porcelain
    if ($out) {
        Write-Error "   Error al hacer commit. Por favor verifica manualmente."
        exit 1
    } else {
        Write-Host "   Nada que guardar (ya estaba commiteado)." -ForegroundColor Yellow
    }
}

# 4. Push Main
Write-Host "4. Sincronizando rama principal..."
git push origin main

# 5. Re-crear tag (Moverlo al nuevo commit)
Write-Host "5. Actualizando tag v0.5.3..."
# Borrar remoto primero para evitar conflictos
git push origin --delete v0.5.3 2>$null
# Borrar local
git tag -d v0.5.3 2>$null
# Crear nuevo
git tag v0.5.3
# Subir nuevo
git push origin v0.5.3

Write-Host ""
Write-Host "=== RELEASE v0.5.3 ENVIADO ===" -ForegroundColor Green
Write-Host "GitHub Actions ahora construirá la release con la versión correcta."
Write-Host "Verifica aquí: https://github.com/BitStationBusiness/bitstation-tools/actions"
