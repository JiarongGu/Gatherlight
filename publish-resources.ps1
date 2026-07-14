#requires -Version 5.1
<#
.SYNOPSIS
    Build (via build-resource.ps1) and publish the Gatherlight.Resources NuGet package to nuget.org.
    Run this LOCALLY whenever the runtime bundle needs a new version — a Playwright/Chromium bump, or a
    new payload (e.g. adding the ONNX embedding model). The CI equivalent is
    .github/workflows/release-resources.yml.

.PARAMETER Version
    Package version. Defaults to ResourceProvisioner.ResourcesPackageVersion (the version the app
    fetches); warns if you pass a different one.

.PARAMETER ApiKey
    nuget.org API key. Falls back to $env:NUGET_API_KEY, then prompts (input hidden).

.PARAMETER PackOnly
    Build the .nupkg but do not push (dry run / inspect first).

.EXAMPLE
    ./publish-resources.ps1
    ./publish-resources.ps1 -Version 1.1.0 -PackOnly
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$ApiKey = $env:NUGET_API_KEY,
    [switch]$PackOnly
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Keep the package version in lock-step with what the app actually downloads.
$provCs = 'src/server/Gatherlight.Server/Modules/Resources/Services/ResourceProvisioner.cs'
$provVer = (Select-String -Path $provCs -Pattern 'ResourcesPackageVersion\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value
if (-not $Version) {
    $Version = $provVer
    Write-Host "Version not given -> using the provisioner's ResourcesPackageVersion: $Version" -ForegroundColor DarkGray
} elseif ($Version -ne $provVer) {
    Write-Warning "Version '$Version' != ResourcesPackageVersion '$provVer' in the provisioner. The app fetches '$provVer' — update that const (and rebuild/ship the app) or this upload won't be used."
}

# 1. Build (collect + pack) via build-resource.ps1.
& "$PSScriptRoot/build-resource.ps1" -Version $Version

$nupkg = Get-ChildItem 'publish/resources/*.nupkg' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $nupkg) { throw 'no .nupkg was produced in publish/resources' }
$sha = (Get-FileHash -Algorithm SHA256 $nupkg.FullName).Hash.ToLower()
Write-Host "    sha256: $sha" -ForegroundColor DarkGray

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
Write-Host "    App fetches it from: https://api.nuget.org/v3-flatcontainer/gatherlight.resources/$Version/gatherlight.resources.$Version.nupkg" -ForegroundColor DarkGray
