# fix_release_v0.5.1_definitive.ps1
$ErrorActionPreference = "Stop"

Write-Host "=== REPARACIÓN DEFINITIVA RELEASE v0.5.1 ===" -ForegroundColor Cyan

# 1. Asegurar limpieza
Write-Host "1. Asegurando entorno git..."
Stop-Process -Name "git" -Force -ErrorAction SilentlyContinue 2>$null
if (Test-Path .git\index.lock) {
    Remove-Item .git\index.lock -Force -ErrorAction SilentlyContinue
    Write-Host "   Lock eliminado."
}

# 2. Agregar cambios (CRÍTICO: esto es lo que faltaba antes)
Write-Host "2. Agregando cambios de versión..."
git add tools/z-image-turbo/tool.json
git add tools/add/tool.json
git add . 

# 3. Commit (Si falla es porque ya están, pero aseguramos)
Write-Host "3. Creando commit de versión..."
try {
    git commit -m "release: bump versions to z-image-turbo v0.5.1 and add v0.1.3"
    Write-Host "   COMMIT CREADO EXITOSAMENTE." -ForegroundColor Green
}
catch {
    $st = git status --porcelain
    if ($st) {
        Write-Error "   ERROR: No se pudo hacer commit. Faltan permisos de archivo."
        exit 1
    }
    Write-Host "   Nada nuevo que commitear, usando commit anterior..." -ForegroundColor Yellow
}

# 4. Reemplazar Tag (CRÍTICO: mover el tag al NUEVO commit)
Write-Host "4. Actualizando tag v0.5.1 al nuevo commit..."
# Borrar local y remoto viejo
git tag -d v0.5.1 2>$null
git push origin :refs/tags/v0.5.1 2>$null

# Crear nuevo y subir
git tag v0.5.1
git push origin v0.5.1

# Subir main también
git push origin main

Write-Host ""
Write-Host "=== REPARACIÓN COMPLETADA ===" -ForegroundColor Green
Write-Host "Ahora GitHub Actions debe construir la versión v0.5.1 CORRECTA."
