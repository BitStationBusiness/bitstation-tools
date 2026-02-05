param(
  [Parameter(Mandatory=$true)]
  [Alias("input")]
  [string]$InPath,

  [Parameter(Mandatory=$true)]
  [Alias("output")]
  [string]$OutPath
)

$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $toolRoot "src\main.py"

if (!(Test-Path $src)) {
  Write-Error "main.py not found at: $src"
  exit 3
}

$py = $env:BITSTATION_PYTHON
if ([string]::IsNullOrWhiteSpace($py)) { $py = "python" }

& "$py" "$src" --input "$InPath" --output "$OutPath"
exit $LASTEXITCODE