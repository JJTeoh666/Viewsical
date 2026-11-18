param([switch]$SkipChecks, [switch]$PackageOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
Set-Location $projectRoot
if (!(Test-Path -LiteralPath 'node_modules')) { & npm ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
if (!(Test-Path -LiteralPath 'tools\manifest.json') -or !(Test-Path -LiteralPath 'tools\libmpv-2.dll')) { & (Join-Path $PSScriptRoot 'setup-tools.ps1') }
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
if (!$PackageOnly) {
    & npm run tauri -- build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'src-tauri\target' }
$release = Join-Path $target 'release'
$binaryPath = Join-Path $release 'Viewsical.exe'
$installerPath = Join-Path $release "bundle\nsis\Viewsical_${version}_x64-setup.exe"
if ($PackageOnly) {
    $binary = Get-Item -LiteralPath $binaryPath
    if ($binary.VersionInfo.ProductVersion -ne $version -or !(Test-Path -LiteralPath $installerPath)) { throw 'Build the matching native binary and installer before packaging.' }
}
$output = Join-Path $projectRoot 'artifacts'
$portable = Join-Path $output 'Viewsical-portable'
New-Item -ItemType Directory -Path $portable -Force | Out-Null
Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $portable 'Viewsical.exe') -Force
Copy-Item -LiteralPath 'tools' -Destination $portable -Recurse -Force
Copy-Item -LiteralPath 'THIRD_PARTY_NOTICES.md','README.md' -Destination $portable -Force
Copy-Item -LiteralPath 'docs' -Destination $portable -Recurse -Force
# The web overlay replaces the obsolete Lua resources in older portable builds.
$obsoletePlayer = Join-Path $portable 'player'
if (Test-Path -LiteralPath $obsoletePlayer) {
    $portableAbsolute = [System.IO.Path]::GetFullPath($portable)
    $obsoleteAbsolute = [System.IO.Path]::GetFullPath($obsoletePlayer)
    $obsoleteItem = Get-Item -LiteralPath $obsoleteAbsolute -Force
    if ([System.IO.Path]::GetDirectoryName($obsoleteAbsolute) -ne $portableAbsolute -or ($obsoleteItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected portable player resource path.' }
    Remove-Item -LiteralPath $obsoleteAbsolute -Recurse -Force
}
Copy-Item -LiteralPath 'resources\ytdlp-plugins' -Destination $portable -Recurse -Force
Compress-Archive -Path (Join-Path $portable '*') -DestinationPath (Join-Path $output "Viewsical-$version-windows-x64-portable.zip") -Force
Copy-Item -LiteralPath $installerPath -Destination $output -Force
Get-ChildItem -LiteralPath $output -File | Where-Object { $_.Extension -in '.exe','.zip' } | ForEach-Object {
    $hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($_.Name)"
} | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
Write-Output "Packages are ready in $output"
