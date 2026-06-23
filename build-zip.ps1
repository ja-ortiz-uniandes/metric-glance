# Packages extension/ into dist/metric-glance-<version>.zip
# Version is read from extension/manifest.json. The archive has
# manifest.json at its root, as AMO requires.

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$srcDir = Join-Path $root "extension"
$distDir = Join-Path $root "dist"

$manifestPath = Join-Path $srcDir "manifest.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

$outFile = Join-Path $distDir "metric-glance-$version.zip"
if (Test-Path $outFile) {
    Remove-Item $outFile -Force
}

# Zip the CONTENTS of extension/ so manifest.json sits at the archive root.
Compress-Archive -Path (Join-Path $srcDir "*") -DestinationPath $outFile -CompressionLevel Optimal

Write-Host "Built $outFile"
