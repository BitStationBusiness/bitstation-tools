param(
  [Parameter(Mandatory=$true)][string]$input,
  [Parameter(Mandatory=$true)][string]$output
)

$ErrorActionPreference = "Stop"

# Resolver root de la tool
$toolRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $toolRoot "src\main.py"

if (!(Test-Path $src)) {
  Write-Error "main.py not found at: $src"
  exit 3
}

# Preferir python del venv (inyectado por el Worker) o fallback a python del sistema
$py = $env:BITSTATION_PYTHON
if ([string]::IsNullOrWhiteSpace($py)) {
  $py = "python"
}

& $py $src --input $input --output $output
exit $LASTEXITCODE