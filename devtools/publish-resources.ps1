#requires -Version 5.1
<#
.SYNOPSIS
    Build the Gatherlight.Resources NuGet package (the win-x64 runtime: Playwright driver + git +
    chromium headless-shell) and publish it to nuget.org. Run this LOCALLY whenever the bundle needs a
    new version — a Playwright/Chromium bump, or a new payload (e.g. adding the ONNX embedding model).

    It packs via `dev.mjs resources-pack` (reuses a locally-provisioned git/chromium when present, else
    downloads them), then `dotnet nuget push`. The CI equivalent is .github/workflows/release-resources.yml.

.PARAMETER Version
    Package version. Defaults to ResourceProvisioner.ResourcesPackageVersion (the app fetches THAT
    version), and warns if you pass a different one.

.PARAMETER ApiKey
    nuget.org API key. Falls back to $env:NUGET_API_KEY, then prompts (input hidden).

.PARAMETER PackOnly
    Build the .nupkg but do not push (dry run / inspect first).

.EXAMPLE
    ./devtools/publish-resources.ps1
        Pack at the provisioner's version and push (key from $env:NUGET_API_KEY or a prompt).

.EXAMPLE
    ./devtools/publish-resources.ps1 -Version 1.1.0 -PackOnly
        Build 1.1.0 locally without pushing (bump the provisioner const to 1.1.0 first).
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$ApiKey = $env:NUGET_API_KEY,
    [switch]$PackOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot   # devtools/ -> repo root
Set-Location $repo

# Keep the package version in lock-step with what the app actually downloads.
$provCs = 'src/server/Gatherlight.Server/Modules/Resources/Services/ResourceProvisioner.cs'
$provVer = (Select-String -Path $provCs -Pattern 'ResourcesPackageVersion\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value
if (-not $Version) {
    $Version = $provVer
    Write-Host "Version not given -> using the provisioner's ResourcesPackageVersion: $Version" -ForegroundColor DarkGray
} elseif ($Version -ne $provVer) {
    Write-Warning "Version '$Version' != ResourcesPackageVersion '$provVer' in the provisioner. The app fetches '$provVer' — update that const (and rebuild/ship the app) or this upload won't be used."
}

# 1. Pack — assembles driver + git + chromium headless-shell, then `dotnet pack` -> dist/resources.
Write-Host "==> Packing Gatherlight.Resources $Version ..." -ForegroundColor Cyan
node devtools/dev.mjs resources-pack $Version
if ($LASTEXITCODE -ne 0) { throw "resources-pack failed (exit $LASTEXITCODE)" }

$nupkg = Get-ChildItem 'dist/resources/*.nupkg' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $nupkg) { throw 'no .nupkg was produced in dist/resources' }
$sizeMb = [math]::Round($nupkg.Length / 1MB, 1)
$sha = (Get-FileHash -Algorithm SHA256 $nupkg.FullName).Hash.ToLower()
Write-Host "==> Built $($nupkg.Name)  ($sizeMb MB)" -ForegroundColor Green
Write-Host "    sha256: $sha" -ForegroundColor DarkGray
if ($nupkg.Length -gt 250MB) { Write-Warning "The package is over nuget.org's 250 MB per-package limit — the push will be rejected. Trim a payload." }

if ($PackOnly) {
    Write-Host "==> -PackOnly: not pushing. Package is at $($nupkg.FullName)" -ForegroundColor Yellow
    return
}

# 2. Push to nuget.org. Key from -ApiKey, else $env:NUGET_API_KEY, else a hidden prompt.
if (-not $ApiKey) {
    $sec = Read-Host 'nuget.org API key' -AsSecureString
    $ApiKey = [System.Net.NetworkCredential]::new('', $sec).Password
}
if (-not $ApiKey) { throw 'no nuget.org API key (set $env:NUGET_API_KEY or pass -ApiKey)' }

Write-Host "==> Pushing $($nupkg.Name) to nuget.org ..." -ForegroundColor Cyan
dotnet nuget push $nupkg.FullName --api-key $ApiKey --source 'https://api.nuget.org/v3/index.json' --skip-duplicate
if ($LASTEXITCODE -ne 0) { throw "dotnet nuget push failed (exit $LASTEXITCODE)" }
Write-Host "==> Published Gatherlight.Resources $Version." -ForegroundColor Green
Write-Host "    The app fetches it from: https://api.nuget.org/v3-flatcontainer/gatherlight.resources/$Version/gatherlight.resources.$Version.nupkg" -ForegroundColor DarkGray
