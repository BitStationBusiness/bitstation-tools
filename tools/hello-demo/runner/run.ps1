# Hello Demo Tool - Backend Runner
# Entrypoint para Windows

param(
    [Parameter(Mandatory=$true)]
    [string]$InputFile,
    
    [Parameter(Mandatory=$true)]
    [string]$OutputFile
)

$ErrorActionPreference = "Stop"

try {
    # Leer input
    $inputJson = Get-Content -Path $InputFile -Raw | ConvertFrom-Json
    $message = $inputJson.message
    
    Write-Host "[hello-demo] Procesando mensaje: $message"
    
    # Simular procesamiento (demo)
    Start-Sleep -Milliseconds 500
    
    # Generar respuesta
    $response = @{
        ok = $true
        response = "Hola! Recibí tu mensaje: '$message' - Procesado por hello-demo v1.0.0"
        timestamp = (Get-Date -Format "o")
    }
    
    # Escribir output
    $response | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputFile -Encoding UTF8
    
    Write-Host "[hello-demo] Completado exitosamente"
    exit 0
    
} catch {
    $errorResponse = @{
        ok = $false
        error = $_.Exception.Message
    }
    
    $errorResponse | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputFile -Encoding UTF8
    
    Write-Host "[hello-demo] Error: $($_.Exception.Message)"
    exit 1
}
