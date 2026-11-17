param([switch]$SkipChecks)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location $projectRoot
if (!(Test-Path -LiteralPath 'node_modules')) { & npm ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
if (!(Test-Path -LiteralPath 'tools\manifest.json')) { & (Join-Path $PSScriptRoot 'setup-tools.ps1') }
& node scripts/collect-licenses.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (!$SkipChecks) {
    & npm run check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & npm test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & (Join-Path $PSScriptRoot 'test-rust.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& npm run tauri -- build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$output = Join-Path $projectRoot 'artifacts'
$portable = Join-Path $output 'Viewsical-portable'
New-Item -ItemType Directory -Path $portable -Force | Out-Null
Copy-Item -LiteralPath 'src-tauri\target\release\Viewsical.exe' -Destination (Join-Path $portable 'Viewsical.exe') -Force
Copy-Item -LiteralPath 'tools' -Destination $portable -Recurse -Force
Copy-Item -LiteralPath 'THIRD_PARTY_NOTICES.md','README.md' -Destination $portable -Force
Copy-Item -LiteralPath 'docs' -Destination $portable -Recurse -Force
if (Test-Path -LiteralPath 'resources\player') { Copy-Item -LiteralPath 'resources\player' -Destination $portable -Recurse -Force }
Copy-Item -LiteralPath 'resources\ytdlp-plugins' -Destination $portable -Recurse -Force
Compress-Archive -Path (Join-Path $portable '*') -DestinationPath (Join-Path $output "Viewsical-$version-windows-x64-portable.zip") -Force
Get-ChildItem -LiteralPath 'src-tauri\target\release\bundle\nsis' -Filter '*.exe' | Copy-Item -Destination $output -Force
Get-ChildItem -LiteralPath $output -File | Where-Object { $_.Extension -in '.exe','.zip' } | ForEach-Object {
    $hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($_.Name)"
} | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
Write-Output "Packages are ready in $output"
