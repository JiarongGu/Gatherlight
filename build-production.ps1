# build-production.ps1 - Gatherlight production build (root entry point).
#
# Builds the whole shippable bundle: React client -> Kestrel host (self-contained single-file) ->
# native C++ launcher (Gatherlight.exe) -> publish/Gatherlight/ (libs/ res/ data/) + a sha256 manifest
# (+ optional zip). The heavy lifting lives in devtools/scripts/build-production.mjs (one engine for
# local + CI); this script is a friendly root wrapper that checks prerequisites and forwards options.
#
#   .\build-production.ps1                 # lean win-x64 bundle (resources via nuget at first run)
#   .\build-production.ps1 -Zip            # also produce the release .zip
#   .\build-production.ps1 -Offline        # bundle chromium/git/driver for air-gapped installs
#   .\build-production.ps1 -Rid win-arm64  # another runtime
#   .\build-production.ps1 -SkipClient     # reuse an existing client build (faster iteration)
param(
    [string]$Rid = "win-x64",
    [switch]$SkipClient,
    [switch]$Zip,
    [switch]$Offline,
    [switch]$SkipChromium
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$mode = if ($Offline) { "offline (resources bundled)" } else { "lean (resources via nuget at setup)" }
Write-Host ""
Write-Host "  Gatherlight production build" -ForegroundColor Cyan
Write-Host "  rid: $Rid  ·  $mode  ->  publish/Gatherlight/" -ForegroundColor DarkGray
Write-Host ""

# Prerequisites
foreach ($tool in @("node", "dotnet")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "X Required tool '$tool' not found on PATH." -ForegroundColor Red
        exit 1
    }
}
if ($Rid -eq "win-x64" -and -not (Test-Path "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe")) {
    Write-Host "! MSVC not detected - the native launcher will be skipped (Gatherlight.cmd is the fallback)." -ForegroundColor Yellow
}

$buildArgs = @("devtools/scripts/build-production.mjs", $Rid)
if ($SkipClient)   { $buildArgs += "--skip-client" }
if ($Zip)          { $buildArgs += "--zip" }
if ($Offline)      { $buildArgs += "--offline" }
if ($SkipChromium) { $buildArgs += "--skip-chromium" }

& node @buildArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "X Build failed." -ForegroundColor Red
    exit $LASTEXITCODE
}
