param([switch]$Force)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $projectRoot 'tools'
$cacheRoot = Join-Path $projectRoot '.tools\downloads'
$licenseRoot = Join-Path $toolRoot 'licenses'
New-Item -ItemType Directory -Path $toolRoot,$cacheRoot,$licenseRoot -Force | Out-Null
$ProgressPreference = 'SilentlyContinue'
function Fetch([string]$Url,[string]$Name) {
    $target = Join-Path $cacheRoot $Name
    if ($Force -or !(Test-Path -LiteralPath $target)) { Invoke-WebRequest -Uri $Url -OutFile $target }
    return $target
}
function Verify([string]$Path,[string]$Expected) {
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) { throw "Checksum mismatch: $Path" }
}
function Matches([string]$Path,[string]$Expected) {
    return (Test-Path -LiteralPath $Path) -and ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Expected)
}
function CopyVerified([string]$Source,[string]$Destination,[string]$Expected) {
    Verify $Source $Expected
    if ($Force -or !(Matches $Destination $Expected)) { Copy-Item -LiteralPath $Source -Destination $Destination -Force }
    Verify $Destination $Expected
}
function CopyNotice([string]$Source,[string]$Name) {
    $destination = Join-Path $licenseRoot $Name
    $expected = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Force -or !(Matches $destination $expected)) { Copy-Item -LiteralPath $Source -Destination $destination -Force }
}
function FetchNotice([string]$Url,[string]$Name) {
    # Pinned upstream URLs, rather than moving branches, supply every notice.
    $source = Fetch $Url "license-$Name"
    CopyNotice $source $Name
}
$ytVersion = '2026.10.26'
$pythonVersion = '3.13.17'
$pythonFile = "python-$pythonVersion-embed-amd64.zip"
$pythonUrl = "https://www.python.org/ftp/python/$pythonVersion/$pythonFile"
$pythonHash = '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38'
$pythonArchive = Fetch $pythonUrl $pythonFile
Verify $pythonArchive $pythonHash
$wheelLock = Join-Path $PSScriptRoot 'youtube-wheels.json'
$wheels = @(Get-Content -LiteralPath $wheelLock -Raw | ConvertFrom-Json)
$wheelArchives = foreach ($wheel in $wheels) {
    $file = Fetch $wheel.url ([System.IO.Path]::GetFileName(([uri]$wheel.url).AbsolutePath))
    Verify $file $wheel.sha256
    $file
}
$pythonRoot = Join-Path $toolRoot 'python'
$runtimeStamp = Join-Path $pythonRoot 'bundle.lock'
$stamp = "$pythonHash $((Get-FileHash -LiteralPath $wheelLock).Hash)"
if ($Force -or !(Test-Path -LiteralPath $runtimeStamp) -or (Get-Content -LiteralPath $runtimeStamp -Raw).Trim() -ne $stamp) {
    $stage = Join-Path $toolRoot ("python-stage-" + [guid]::NewGuid())
    try {
        Expand-Archive -LiteralPath $pythonArchive -DestinationPath $stage
        $packages = Join-Path $stage 'packages'
        New-Item -ItemType Directory -Path $packages -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        foreach ($wheelArchive in $wheelArchives) {
            [System.IO.Compression.ZipFile]::ExtractToDirectory($wheelArchive, $packages)
        }
        @('python313.zip', '.', 'packages') | Set-Content -LiteralPath (Join-Path $stage 'python313._pth') -Encoding ascii
        & (Join-Path $stage 'python.exe') -I -B -c "import yt_dlp, yt_dlp_ejs, requests, brotli; from yt_dlp.version import __version__; assert __version__ == '$ytVersion'"
        if ($LASTEXITCODE -ne 0) { throw 'The bundled Python environment failed its import check.' }
        $stamp | Set-Content -LiteralPath (Join-Path $stage 'bundle.lock') -Encoding ascii
        if (Test-Path -LiteralPath $pythonRoot) {
            $prior = Get-Item -LiteralPath $pythonRoot -Force
            if ($prior.FullName -ne [System.IO.Path]::GetFullPath($pythonRoot) -or ($prior.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or (Get-ChildItem -LiteralPath $pythonRoot -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1)) { throw 'Unexpected bundled Python directory.' }
            Remove-Item -LiteralPath $prior.FullName -Recurse -Force
        }
        Move-Item -LiteralPath $stage -Destination $pythonRoot
    } finally {
        if (Test-Path -LiteralPath $stage) {
            $staged = Get-Item -LiteralPath $stage -Force
            if ($staged.FullName -eq [System.IO.Path]::GetFullPath($stage) -and !($staged.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                Remove-Item -LiteralPath $staged.FullName -Recurse -Force
            }
        }
    }
}
CopyNotice (Join-Path $pythonRoot 'LICENSE.txt') 'Python-LICENSE.txt'

$denoVersion = '2.9.8'
$denoUrl = "https://github.com/denoland/deno/releases/download/v$denoVersion/deno-x86_64-pc-windows-msvc.zip"
$denoZip = Fetch $denoUrl 'deno.zip'
$denoChecksum = Fetch "$denoUrl.sha256sum" 'deno.sha256sum'
$denoHash = [regex]::Match((Get-Content -LiteralPath $denoChecksum -Raw), '(?i)\b[0-9a-f]{64}\b').Value
if ($denoHash -ne 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf') { throw 'The Deno published checksum differs from the pinned release.' }
Verify $denoZip $denoHash
$denoBinaryHash = '924397800533d3eb0ed0c889b20ad70e18b970d93acd8135bc043f425e528266'
if ($Force -or !(Matches (Join-Path $toolRoot 'deno.exe') $denoBinaryHash)) { Expand-Archive -LiteralPath $denoZip -DestinationPath $toolRoot -Force }
Verify (Join-Path $toolRoot 'deno.exe') $denoBinaryHash

$mpvUrl = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261111/mpv-x86_64-20261111-git-bcde6b93cc.7z'
$mpvArchive = Fetch $mpvUrl 'mpv.7z'
# Published SHA-256 digest on GitHub release 20261111's selected asset.
Verify $mpvArchive 'f259b5fd4b5c395617c948a4fadcdf55bba1c5282fb7c13e88626b3f71072baf'
$mpvBinaryHash = '3ea89fe7a4284b25dff3c72e1bde83e27324c90cfc4a074fe679293d19ee7c85'
$mpvDllHash = '4b074a3976399dc735484f5d43d04b519b7bdee8ac719d9ab8ed6bd4e6be0345'
$mpvExtract = Join-Path $cacheRoot 'mpv-extracted'
New-Item -ItemType Directory -Path $mpvExtract -Force | Out-Null
if ($Force -or !(Matches (Join-Path $mpvExtract 'mpv.exe') $mpvBinaryHash) -or !(Matches (Join-Path $mpvExtract 'd3dcompiler_43.dll') $mpvDllHash)) {
    & tar -xf $mpvArchive -C $mpvExtract
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract mpv with Windows tar.' }
}
CopyVerified (Join-Path $mpvExtract 'mpv.exe') (Join-Path $toolRoot 'mpv.exe') $mpvBinaryHash
CopyVerified (Join-Path $mpvExtract 'd3dcompiler_43.dll') (Join-Path $toolRoot 'd3dcompiler_43.dll') $mpvDllHash

$libmpvVersion = '0.42.0'
$libmpvName = "libmpv-v$libmpvVersion-x86_64-w64-mingw32-lgpl.zip"
$libmpvUrl = "https://github.com/mpv-player/mpv/releases/download/v$libmpvVersion/$libmpvName"
$libmpvArchiveHash = '8e5f77430efc53ef175804ba6618527e3af0448a0dcabf04d3cc72659d1a6fce'
$libmpvBinaryHash = '94fb87247732c59915cd59808bc582e843a71c22214b7b6c1e5563aa8149cef4'
$libmpvArchive = Fetch $libmpvUrl $libmpvName
Verify $libmpvArchive $libmpvArchiveHash
$libmpvExtract = Join-Path $cacheRoot "libmpv-$libmpvVersion"
$libmpvBinary = Join-Path $libmpvExtract 'libmpv-2.dll'
$libmpvNotice = Join-Path $libmpvExtract 'LICENSE.LGPL'
if ($Force -or !(Matches $libmpvBinary $libmpvBinaryHash) -or !(Test-Path -LiteralPath $libmpvNotice)) {
    New-Item -ItemType Directory -Path $libmpvExtract -Force | Out-Null
    Expand-Archive -LiteralPath $libmpvArchive -DestinationPath $libmpvExtract -Force
}
CopyVerified $libmpvBinary (Join-Path $toolRoot 'libmpv-2.dll') $libmpvBinaryHash
CopyNotice $libmpvNotice 'libmpv-LICENSE.LGPL'

# The matching static FFmpeg build avoids requiring a system installation.
$ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z'
$ffmpegArchive = Fetch $ffmpegUrl 'ffmpeg-8.1.2.7z'
$ffmpegChecksum = Fetch "$ffmpegUrl.sha256" 'ffmpeg-8.1.2.sha256'
$ffmpegArchiveHash = [regex]::Match((Get-Content -LiteralPath $ffmpegChecksum -Raw), '(?i)\b[0-9a-f]{64}\b').Value
if ($ffmpegArchiveHash -ne 'e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6') { throw 'The FFmpeg published checksum differs from the pinned release.' }
Verify $ffmpegArchive $ffmpegArchiveHash
$ffmpegExtract = Join-Path $cacheRoot 'ffmpeg-8.1.2-extracted'
New-Item -ItemType Directory -Path $ffmpegExtract -Force | Out-Null
$ffmpegPackage = Join-Path $ffmpegExtract 'ffmpeg-8.1.2-essentials_build'
$ffmpegHashes = @{ 'ffmpeg.exe'='1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e'; 'ffprobe.exe'='b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07' }
if ($Force -or !(Matches (Join-Path $ffmpegPackage 'bin\ffmpeg.exe') $ffmpegHashes['ffmpeg.exe']) -or !(Matches (Join-Path $ffmpegPackage 'bin\ffprobe.exe') $ffmpegHashes['ffprobe.exe']) -or !(Test-Path -LiteralPath (Join-Path $ffmpegPackage 'LICENSE')) -or !(Test-Path -LiteralPath (Join-Path $ffmpegPackage 'README.txt'))) {
    & tar -xf $ffmpegArchive -C $ffmpegExtract
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract FFmpeg with Windows tar.' }
}
foreach ($binary in @('ffmpeg.exe','ffprobe.exe')) {
    $found = Get-ChildItem -LiteralPath $ffmpegExtract -Recurse -Filter $binary | Select-Object -First 1
    if (!$found) { throw "Missing $binary in archive" }
    CopyVerified $found.FullName (Join-Path $toolRoot $binary) $ffmpegHashes[$binary]
}

# Preserve upstream notices for the pinned library and EJS package.
FetchNotice "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$ytVersion/LICENSE" 'yt-dlp-LICENSE.txt'
FetchNotice "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$ytVersion/THIRD_PARTY_LICENSES.txt" 'yt-dlp-THIRD_PARTY_LICENSES.txt'
FetchNotice 'https://raw.githubusercontent.com/yt-dlp/ejs/0.8.0/LICENSE' 'yt-dlp-ejs-LICENSE.txt'
FetchNotice "https://raw.githubusercontent.com/denoland/deno/v$denoVersion/LICENSE.md" 'Deno-LICENSE.txt'
FetchNotice 'https://raw.githubusercontent.com/mpv-player/mpv/bcde6b93cc/Copyright' 'mpv-Copyright.txt'
FetchNotice 'https://raw.githubusercontent.com/mpv-player/mpv/bcde6b93cc/LICENSE.GPL' 'GPL-2.0.txt'
FetchNotice 'https://raw.githubusercontent.com/mpv-player/mpv/bcde6b93cc/LICENSE.LGPL' 'LGPL-2.1.txt'
CopyNotice (Join-Path $ffmpegPackage 'LICENSE') 'FFmpeg-LICENSE.txt'
CopyNotice (Join-Path $ffmpegPackage 'README.txt') 'FFmpeg-BUILD.txt'

$sources = @'
# Bundled tool notices and source locations

Viewsical redistributes these Windows x64 builds unchanged. Upstream license texts
are alongside this file. Python wheel notices are in python/packages/*.dist-info.

## yt-dlp 2026.10.26 and yt-dlp-ejs 0.8.0

- Python wheel: https://pypi.org/project/yt-dlp/2026.10.26/
- Corresponding source: https://github.com/yt-dlp/yt-dlp/tree/2026.10.26
- Source archive: https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.10.26.tar.gz
- Bundled dependency notices: https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/THIRD_PARTY_LICENSES.txt
- Pinned EJS declaration: https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/pyproject.toml
- EJS source: https://github.com/yt-dlp/ejs/tree/0.8.0
- EJS source archive: https://github.com/yt-dlp/ejs/archive/refs/tags/0.8.0.tar.gz
- EJS is Unlicense; bundled Meriyah ISC and Astring MIT notices are in yt-dlp-THIRD_PARTY_LICENSES.txt.
- See yt-dlp-LICENSE.txt, yt-dlp-ejs-LICENSE.txt, and yt-dlp-THIRD_PARTY_LICENSES.txt.

## CPython 3.13.17

- Windows x64 embeddable runtime: https://www.python.org/downloads/release/python-31317/
- See Python-LICENSE.txt.

## Deno 2.9.8

- Binary release: https://github.com/denoland/deno/releases/tag/v2.9.8
- Corresponding source: https://github.com/denoland/deno/tree/v2.9.8
- Source archive: https://github.com/denoland/deno/archive/refs/tags/v2.9.8.tar.gz
- MIT license: Deno-LICENSE.txt.

## mpv 20261111-git-bcde6b93cc (shinchiro Windows build)

- Binary archive and published digest: https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20261111
- Corresponding mpv commit: https://github.com/mpv-player/mpv/tree/bcde6b93cc
- mpv source archive: https://github.com/mpv-player/mpv/archive/bcde6b93cc.tar.gz
- Windows build recipes and dependency definitions: https://github.com/shinchiro/mpv-winbuild-cmake/tree/20261111
- d3dcompiler_43.dll is redistributed unchanged from that same mpv archive.
- See mpv-Copyright.txt, GPL-2.0.txt, and LGPL-2.1.txt for upstream licensing details.

## libmpv 0.42.0 (official Windows LGPL build)

- Release archive and published digest: https://github.com/mpv-player/mpv/releases/tag/v0.42.0
- Corresponding source and build recipes: https://github.com/mpv-player/mpv/tree/v0.42.0
- Source archive: https://github.com/mpv-player/mpv/archive/refs/tags/v0.42.0.tar.gz
- See libmpv-LICENSE.LGPL. The player helper loads the unmodified DLL at runtime.

## FFmpeg and FFprobe 8.1.2-essentials

- Binary archive: https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z
- Build provider and package information: https://www.gyan.dev/ffmpeg/builds/
- Exact source commit recorded in the archive README: https://github.com/FFmpeg/FFmpeg/commit/38b88335f9
- Source archive: https://github.com/FFmpeg/FFmpeg/archive/38b88335f9.tar.gz
- FFmpeg release source: https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
- GPL v3: FFmpeg-LICENSE.txt is copied verbatim from this archive's LICENSE.
- FFmpeg-BUILD.txt is the archive README, including build configuration and source locations.

## Integrity

tools/manifest.json records pinned archive and executable SHA-256 hashes,
including the unchanged mpv DLL. setup-tools.ps1 verifies downloaded archives
against pinned hashes, checks Python wheel hashes and Deno/FFmpeg published checksum files, and
verifies every shipped executable/DLL. Matching cached archives and installed
binaries are reused on subsequent runs.
'@
$sourcePath = Join-Path $licenseRoot 'sources.md'
if ($Force -or !(Test-Path -LiteralPath $sourcePath) -or (Get-Content -LiteralPath $sourcePath -Raw) -ne ($sources + [Environment]::NewLine)) {
    $sources | Set-Content -LiteralPath $sourcePath -Encoding utf8
}
$manifest = @(
    @{ name='yt-dlp'; version=$ytVersion; source=$wheels[0].url; file='python/packages/yt_dlp/__init__.py'; archiveSha256=$wheels[0].sha256 },
    @{ name='Python'; version=$pythonVersion; source=$pythonUrl; file='python/python.exe'; archiveSha256=$pythonHash },
    @{ name='Deno'; version=$denoVersion; source=$denoUrl; file='deno.exe'; archiveSha256=(Get-FileHash $denoZip).Hash.ToLowerInvariant() },
    @{ name='mpv'; version='20261111-git-bcde6b93cc'; source=$mpvUrl; file='mpv.exe'; archiveSha256=(Get-FileHash $mpvArchive).Hash.ToLowerInvariant() },
    @{ name='libmpv'; version=$libmpvVersion; source=$libmpvUrl; file='libmpv-2.dll'; archiveSha256=$libmpvArchiveHash },
    @{ name='FFmpeg'; version='8.1.2-essentials'; source=$ffmpegUrl; file='ffmpeg.exe'; archiveSha256=(Get-FileHash $ffmpegArchive).Hash.ToLowerInvariant() },
    @{ name='FFprobe'; version='8.1.2-essentials'; source=$ffmpegUrl; file='ffprobe.exe'; archiveSha256=(Get-FileHash $ffmpegArchive).Hash.ToLowerInvariant() },
    @{ name='mpv Direct3D compiler helper'; version='20261111-git-bcde6b93cc'; source=$mpvUrl; file='d3dcompiler_43.dll'; archiveSha256=(Get-FileHash $mpvArchive).Hash.ToLowerInvariant() }
)
foreach ($entry in $manifest) { $entry.sha256 = (Get-FileHash -LiteralPath (Join-Path $toolRoot $entry.file)).Hash.ToLowerInvariant() }
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $toolRoot 'manifest.json') -Encoding utf8
Write-Output 'Bundled media tools, checksums, source links, and license notices are ready.'
