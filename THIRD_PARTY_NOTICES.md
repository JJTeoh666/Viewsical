# Third-party software

Viewsical bundles these independently maintained tools. Exact binary hashes and source URLs are in `tools/manifest.json`.

| Component | License and source |
| --- | --- |
| yt-dlp | Unlicense (Windows standalone binaries also bundle Python and dependencies with their own licenses): https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE and https://github.com/yt-dlp/yt-dlp#license |
| yt-dlp-ejs | Unlicense, with MIT/ISC components: https://github.com/yt-dlp/ejs |
| Deno | MIT and bundled third-party licenses: https://github.com/denoland/deno/blob/main/LICENSE.md |
| mpv Windows build | GPL; build recipes and corresponding source revisions: https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20261111 and https://github.com/mpv-player/mpv |
| FFmpeg / FFprobe | GPL enabled in the selected Gyan essentials build. Build information, corresponding sources and dependencies: https://www.gyan.dev/ffmpeg/builds/ and https://ffmpeg.org/legal.html |
| Tauri | Apache-2.0 or MIT: https://github.com/tauri-apps/tauri |
| Tauri single-instance plugin | Apache-2.0 or MIT: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/single-instance |
| React | MIT: https://github.com/facebook/react |
| Roboto | Apache-2.0: https://github.com/googlefonts/roboto |
| Lucide | ISC: https://lucide.dev/license |

Upstream license texts and source information are included in `tools/licenses/`. The bundled mpv and FFmpeg executables are separate programs; their source and redistribution obligations remain applicable. Preserve these notices when redistributing the package. YouTube is a trademark of Google; Viewsical is an independent application.
