# Bundled tool notices and source locations

TubeDesk redistributes these Windows x64 builds unchanged. Upstream license texts
are alongside this file; the yt-dlp aggregate includes its bundled dependencies.

## yt-dlp 2026.10.26 and yt-dlp-ejs 0.8.0

- Binary release: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
- Corresponding source: https://github.com/yt-dlp/yt-dlp/tree/2026.10.26
- Source archive: https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.10.26.tar.gz
- Bundled dependency notices: https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/THIRD_PARTY_LICENSES.txt
- Pinned EJS declaration: https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/pyproject.toml
- EJS source: https://github.com/yt-dlp/ejs/tree/0.8.0
- EJS source archive: https://github.com/yt-dlp/ejs/archive/refs/tags/0.8.0.tar.gz
- EJS is Unlicense; bundled Meriyah ISC and Astring MIT notices are in yt-dlp-THIRD_PARTY_LICENSES.txt.
- See yt-dlp-LICENSE.txt, yt-dlp-ejs-LICENSE.txt, and yt-dlp-THIRD_PARTY_LICENSES.txt.

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
against pinned hashes, checks yt-dlp/Deno/FFmpeg published checksum files, and
verifies every shipped executable/DLL. Matching cached archives and installed
binaries are reused on subsequent runs.
