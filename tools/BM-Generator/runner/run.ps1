param(
  [Parameter(Mandatory=$true)]
  [Alias("input")]
  [string]$InPath,

  [Parameter(Mandatory=$true)]
  [Alias("output")]
  [string]$OutPath
)

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolDir    = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $ToolDir "backend"
$VenvDir    = Join-Path $ToolDir ".venv"

# Auto-setup if venv missing
if (-not (Test-Path (Join-Path $VenvDir "Scripts\python.exe"))) {
    Write-Host "[BM-Generator] Venv not found, running setup..."
    $SetupScript = Join-Path $ScriptDir "setup.ps1"
    if (Test-Path $SetupScript) {
        & $SetupScript
        if ($LASTEXITCODE -ne 0) {
            Write-Error "[BM-Generator] Setup failed with exit code $LASTEXITCODE"
            exit 1
        }
    } else {
        Write-Error "[BM-Generator] setup.ps1 not found"
        exit 1
    }
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$CliScript  = Join-Path $BackendDir "cli.py"

if (-not (Test-Path $VenvPython)) {
    Write-Error "Python not found at $VenvPython"
    exit 1
}

if (-not (Test-Path $CliScript)) {
    Write-Error "CLI script not found at $CliScript"
    exit 1
}

$Env:PYTHONPATH = $BackendDir
& $VenvPython $CliScript --input "$InPath" --output "$OutPath"
exit $LASTEXITCODE
