#requires -Version 5.1
<#
.SYNOPSIS
    Collect the win-x64 runtime resource files (Playwright driver + portable git + chromium
    headless-shell) and pack them into the Gatherlight.Resources NuGet package under publish/resources/.
    Build only — run publish-resources.ps1 to also push it to nuget.org.

    Reuses a locally-provisioned git/chromium when present (fast), else downloads/installs them.

.PARAMETER Version
    Package version. Defaults to ResourceProvisioner.ResourcesPackageVersion (what the app fetches).

.EXAMPLE
    ./build-resource.ps1
    ./build-resource.ps1 -Version 1.1.0
#>
[CmdletBinding()]
param([string]$Version)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '==> Collecting runtime resources (driver + git + chromium headless-shell) + packing Gatherlight.Resources...' -ForegroundColor Cyan
if ($Version) { node devtools/dev.mjs resources-pack $Version } else { node devtools/dev.mjs resources-pack }
if ($LASTEXITCODE -ne 0) { throw "resource pack failed (exit $LASTEXITCODE)" }

$nupkg = Get-ChildItem 'publish/resources/*.nupkg' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $nupkg) { throw 'no .nupkg was produced in publish/resources' }
$sizeMb = [math]::Round($nupkg.Length / 1MB, 1)
Write-Host "==> Built $($nupkg.Name)  ($sizeMb MB)  ->  publish/resources/" -ForegroundColor Green
if ($nupkg.Length -gt 250MB) { Write-Warning "Over nuget.org's 250 MB per-package limit — trim a payload before publishing." }
