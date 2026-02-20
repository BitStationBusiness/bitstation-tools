<#
.SYNOPSIS
    Publica un release de bitstation-tools.
.DESCRIPTION
    Automatiza el ciclo completo:
    1. Valida tools
    2. (Opcional) Bump de versiones
    3. Genera manifests
    4. Empaqueta tools
    5. Commit + tag + push (dispara GitHub Actions)
.EXAMPLE
    .\scripts\publish_release.ps1 -Version "0.8.2"
    .\scripts\publish_release.ps1 -Version "0.9.0" -BumpPart minor
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [ValidateSet("none", "patch", "minor", "major")]
    [string]$BumpPart = "none",

    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "=== BitStation Tools Release v$Version ===" -ForegroundColor Cyan
Write-Host "Repo: $repoRoot"

Push-Location $repoRoot
try {
    # Check clean working tree
    $status = git status --porcelain 2>&1
    if ($status -and -not $Force) {
        Write-Warning "Working tree has uncommitted changes. Use -Force to proceed."
        Write-Host $status
        exit 1
    }

    # Step 1: Bump versions if requested
    if ($BumpPart -ne "none") {
        Write-Host ""
        Write-Host "[1/5] Bumping versions ($BumpPart)..." -ForegroundColor Yellow
        python scripts/bump_version.py --part $BumpPart
        if ($LASTEXITCODE -ne 0) { throw "bump_version.py failed" }
    }
    else {
        Write-Host ""
        Write-Host "[1/5] Skipping version bump" -ForegroundColor DarkGray
    }

    # Step 2: Validate
    Write-Host ""
    Write-Host "[2/5] Validating tools..." -ForegroundColor Yellow
    python build/validate_tools.py
    if ($LASTEXITCODE -ne 0) { throw "validate_tools.py failed" }

    # Step 3: Generate manifests
    Write-Host ""
    Write-Host "[3/5] Generating manifests..." -ForegroundColor Yellow
    python build/generate_manifest.py
    if ($LASTEXITCODE -ne 0) { throw "generate_manifest.py failed" }

    # Step 4: Pack tools
    Write-Host ""
    Write-Host "[4/5] Packing tools..." -ForegroundColor Yellow
    python build/pack_tools.py --release-tag "v$Version"
    if ($LASTEXITCODE -ne 0) { throw "pack_tools.py failed" }

    # Step 5: Commit, tag, push
    Write-Host ""
    Write-Host "[5/5] Committing and tagging..." -ForegroundColor Yellow

    $tag = "v$Version"

    if ($DryRun) {
        Write-Host "[DRY-RUN] Would commit, tag '$tag', and push" -ForegroundColor Magenta
        Write-Host "[DRY-RUN] Files in dist/:" -ForegroundColor Magenta
        Get-ChildItem dist/ | ForEach-Object { Write-Host "  $_" }
    }
    else {
        git add -A
        git commit -m "release: v$Version"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Nothing to commit (maybe already committed)"
        }

        # Check if tag exists
        $existingTag = git tag -l $tag 2>&1
        if ($existingTag) {
            if ($Force) {
                Write-Warning "Tag $tag already exists. Deleting (forced)..."
                git tag -d $tag
                git push origin --delete $tag 2>&1 | Out-Null
            }
            else {
                throw "Tag $tag already exists. Use -Force to overwrite."
            }
        }

        git tag -a $tag -m "Release $tag"
        Write-Host "Tag created: $tag" -ForegroundColor Green

        git push origin HEAD
        git push origin $tag
        Write-Host ""
        Write-Host "Pushed to origin. GitHub Actions will publish the release." -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "=== Release v$Version complete ===" -ForegroundColor Green
}
finally {
    Pop-Location
}
