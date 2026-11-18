# Viewsical

Viewsical 0.1.7 (formerly TubeDesk) is a Windows desktop video player built with Tauri 2, Rust, React and TypeScript. Search YouTube, play videos in an embedded native player, cache media for replay, read comments, manage resumable video/audio downloads, and play completed media offline.

## Run

Download the Windows x64 installer or portable ZIP from [the latest GitHub release](https://github.com/JJTeoh666/Viewsical/releases/latest). The installer sets up Viewsical for the current Windows user. For portable use, extract the entire ZIP before opening `Viewsical.exe`. Release assets include `SHA256SUMS.txt` for checksum verification.

Open `artifacts/Viewsical-portable/Viewsical.exe`, or install the setup executable in `artifacts`. Keep the portable `tools` and `ytdlp-plugins` folders beside the executable. Windows WebView2 Runtime is required; the installer can obtain it.

Viewsical has a YouTube-style sidebar, search, video grid and watch page. Paste a video link or search for words. The integrated desktop header includes search, back/forward navigation and window controls. Playback controls appear over the video while the pointer is inside and hide when it leaves. Keyboard controls remain available. Playback menus use translucent glass styling. Click empty video to pause/resume; double-click for fullscreen. Open the settings gear for playback speed, quality and video/audio-only mode. Press Tab to focus the keyboard-accessible playback controls. Use **Downloads** to pause, resume, play, or reveal files. Quality choices on a video card are maximum resolution caps; the player lists actual available qualities after resolving a video. MP4 downloads require H.264/AAC availability; choose MKV when the source offers other codecs. Audio downloads preserve the selected source format.

### Update an installed copy

Close Viewsical and run the newer Windows setup executable. On **Already Installed**, choose **Do not uninstall**. Keep the current installation folder. Setup replaces the program files in place and retains the library, sign-in, and settings.

### Uninstall

Close Viewsical and choose **Uninstall** under **Settings > Apps > Installed apps**. If prompted, allow setup to close Viewsical. Setup waits for Windows to release the program file. If it stays in use, close Viewsical and choose **Retry**.

## Browsing and playback

Visited Home, Search, Subscriptions, channel and playlist pages stay in memory until you close the app. Navigation restores their loaded items and scroll position. Use Reload to request fresh results; a failed reload keeps the previous page available. Signed-in account changes clear incompatible cached views.

Playback continues in a mini-player while you browse. Use its down-arrow button to dock it across the bottom of the window, with transport, seeking and volume controls. The up arrow restores the floating player. Docking and expanding keep the current source and position. Choosing a row inside a playlist replaces the play queue with that playlist and starts that occurrence, including repeated videos. Home, Search, library lists and playlists load another page when you scroll near the end. Playlist queues keep the loaded portion and fetch another page when you scroll near the bottom of the queue or playback approaches the last loaded item. Starting a playlist does not load its entire contents. A Load more / Retry button remains available. Source URLs can still expire and refresh independently of the page cache.

Audio-only mode loads an audio source, preserving playback position and pause intent when you change modes. It also applies to subsequent queue entries during the current run. Enable **Settings → Playback → Always start with audio only** to remember this preference across restarts and start every new video/queue item with audio only. The current item can still be switched to video without changing the default. Local completed downloads remain available offline.

Audio normalization is on by default under **Settings → Playback → Normalize audio**. YouTube’s loudness metadata controls a playback-only gain, capped at -20 dB with no boost. The volume slider stays independent. Missing metadata uses no correction; cached/downloaded media keeps the metadata when available. Original media files are unchanged. See [audio normalization](docs/AUDIO_NORMALIZATION.md) for the policy and verification.

The app remembers whether its main window was maximized and restores that choice at startup. Fullscreen and minimization do not replace it.

Scrolling a watch page keeps the visible portion of the video playing, clipped below the fixed header. It retains its size, playback position and controls. Search uses a separate circular submit button; Home remains available in the sidebar and through the app logo. Home and individual playlist pages show **Back to top** after scrolling, with reduced-motion support and space reserved beside the mini-player or above the bottom player.

Press **↑ / ↓** to change app volume by **5 percentage points**, including while paused or using the bottom player. Text fields, menus and dialogs keep their normal arrow navigation. Volume stays separate from mute and normalization. Opening an item starts it from the beginning, including from History and Downloads. After the last queued item finishes, dragging the progress bar resumes that item at the chosen position, and Play restarts it from the beginning.

Video and audio use the same React controls and Lucide icons. The in-page renderer uses libmpv to display video and controls in the main WebView. The compatibility renderer uses mpv’s native window and a separate transparent controls WebView. Controls hide immediately on pointer leave and after 2.5 seconds of inactivity while playing. The outer scrollbar is hidden; page scrolling, automatic pagination and internal queue/menu scrollbars remain available. See [shared player implementation and verification](docs/SHARED_PLAYER.md).

## Media cache and comments

Playback saves full audio and video components in background after the native player is ready. This uses additional network data. Only complete files with validated tracks and duration become reusable cache entries. Replay opens matching local components before resolving another online source, including after restarting Viewsical. Incomplete transfers are disposable; explicit Downloads remain the way to keep files permanently.

**Settings → Media cache** shows audio, video and in-progress storage. Turn automatic caching on/off, choose a size limit (2 GB by default), clear audio/video/all media, or remove an individual file. Older unused media is evicted as space is needed. Files currently playing are removed after the player releases them. Clearing media cache preserves downloads, sign-in and local history. Account changes clear account-scoped media.

The watch page shows read-only YouTube comments, with Top/Newest order, Load more, refresh and retry. Comments are loaded in pages of 20 up to 300 per order and cached in memory until closing the app. There are no posting, like or reply actions. Disabled comments and unavailable responses have distinct states.

## Accounts

**Sign in** opens Google's real sign-in page in a dedicated app WebView. Complete sign-in yourself, then return to Viewsical and select **I've signed in**. Viewsical validates the session before enabling subscriptions, subscribed channels and account playlists. It never asks for a Google password in its own interface and does not import external browser cookies.

Sign-in is remembered automatically across closing, restarting Windows, and app updates. Persistent cookies stay in the dedicated WebView2 profile. Session-only cookies have an encrypted, current-Windows-user DPAPI fallback with restricted file permissions. On restart Viewsical checks the saved session automatically; signing out removes the remembered session. A temporary network/provider failure retains previously saved sign-in and reports that validation could not finish.

Google may reject embedded sign-in with “This browser or app may not be secure.” Viewsical reports this limitation; anonymous search, playback and downloads remain available. A blocked login is not represented as a connected account. Account library access is read-only. Signing out clears the app's account session and private local history; downloaded files remain available. Local playback history is distinct from YouTube watch history; Viewsical does not intentionally report remote watch progress.

## Development

Development requires Node.js, Rust MSVC, Microsoft C++ Build Tools with the Windows SDK, and WebView2. This workspace has a project-local Rust toolchain and build tools in `.tools`.

```powershell
npm ci
.\scripts\setup-tools.ps1
```

`scripts/setup-tools.ps1` downloads pinned yt-dlp, Deno, mpv, libmpv, FFmpeg and FFprobe. It verifies available upstream archive checksums and records every binary SHA-256 in `tools/manifest.json`. The standalone yt-dlp release includes its EJS solver support. Updating the adapter is an explicit source/build change; there is no silent runtime self-update.

### Run the desktop app with a test profile

Run these commands in PowerShell to launch the Tauri desktop app with its own test library and WebView2 profile. Reuse the same folders when checking behavior across restarts.

```powershell
Set-Location -LiteralPath 'C:\jj\app test\Viewsical'
$env:CARGO_TARGET_DIR = Join-Path $PWD.Path '.tools\playback-target'
$env:TUBEDESK_DATA_DIR = Join-Path $PWD.Path '.tools\manual-test-data'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $PWD.Path '.tools\manual-test-webview'
.\scripts\dev.ps1
```

- **Start from zero.** Play part of a video, then reopen it from History. Confirm it starts at `0:00`. Relaunch the dev app and repeat in audio-only mode.
- **Queue completion.** Queue two short items. Confirm the first advances to the second, the last stops without an error, and Play replays it from `0:00`. Test video and audio-only modes.
- **Miniplayer.** Go to Home during playback. Check that the surface has no fullscreen button and that **Expand player** in the footer opens the watch page.
- **Playback and scrolling.** Pause, seek, and switch between video and audio-only on the same item. Confirm the position carries across the switch. Scroll the watch page slowly and quickly in both directions with video playing. Check that the video and controls move together and clip at the header.
- **Most replayed.** Open a YouTube video with a replay graph, such as `dQw4w9WgXcQ`. Check that the graph appears above the seek bar in both modes, and that you can still drag the bar. A video without replay data uses the plain seek bar.

### Run checks before packaging

Close the dev app and run these checks in the same PowerShell window. The browser smoke test uses Chrome and the frontend built by `npm run build`.

```powershell
npm test
.\scripts\test-rust.ps1
npm run build
node .\scripts\v017-browser-smoke.mjs
```

The native smoke test opens its own desktop app instance and checks real mpv playback, scrolling, queue completion, and replay. It uses Python for the Windows clipping check and expects `.tools/v016-fixture/video.mkv`, `.tools/v016-fixture/audio.mka`, and `.tools/read-player-regions.py` in the development workspace.

```powershell
. .\scripts\env.ps1
cargo build --manifest-path .\src-tauri\Cargo.toml
node .\scripts\v017-native-smoke.mjs
```

### Check the in-page video renderer

The dev app uses the in-page renderer on supported systems. Set `$env:TUBEDESK_VIDEO_RENDERER = 'native'` before launch to compare the compatibility renderer. Clear the variable to restore automatic selection. Run `.\scripts\setup-tools.ps1` first if your workspace predates the bundled libmpv DLL.

The desktop scroll check uses Python and FFmpeg to compare the displayed video with a marker beside it. It opens an isolated Windows test window and creates local 1080p60 and 4K60 fixtures.

```powershell
npm run build
. .\scripts\env.ps1
cargo build --manifest-path .\src-tauri\Cargo.toml --features tauri/custom-protocol
node .\scripts\verify-video-renderer.mjs native
node .\scripts\verify-video-renderer.mjs canvas
```

### Package for Windows

After the checks pass, run the packaging script.

```powershell
.\scripts\build.ps1
```

The build script produces a per-user NSIS installer and a portable ZIP in `artifacts`. The release package contains all media helpers; it does not depend on system Python, FFmpeg or mpv.

## Architecture

- `src`: local interface, typed IPC bridge, queue, presentation and accessibility.
- `src-tauri/src/session.rs`: isolated native cookie/session handling and remembered sign-in.
- `src-tauri/src/youtube.rs` and `youtube/`: replaceable yt-dlp adapter, split into request lifecycle, helper execution, browsing, playback sources, identity, metadata and error modules.
- `src-tauri/src/player.rs`: native child window, mpv IPC, source selection, seeking and bounded recovery.
- `src-tauri/src/downloads.rs`: persistent jobs, source refresh on resume, partial files, merging and FFprobe validation.
- `src-tauri/src/media_cache.rs`: persistent validated media components, active-file leases, storage limits and cleanup.
- `src-tauri/src/comments.rs`: bounded read-only comments, stable pagination anchors and cancellation.
- `src-tauri/src/store.rs`: settings, separate guest/account local history and download records in SQLite.

The local interface and isolated sign-in profile normally create two WebView2 process groups while running. Closing the main window initiates a bounded shutdown of extraction, downloads, mpv and both WebViews; the profile is preserved for remembered sign-in.

The application keeps its original internal identifier `app.tubedesk.desktop` so existing sign-in, settings, cache and history continue to work after the rename. Runtime data is stored under `%LOCALAPPDATA%\app.tubedesk.desktop`; internal media is in its `media-cache` folder. Logs omit cookie values and resolved stream URLs. Temporary scoped cookie files are restricted to the current Windows user, removed after helper operations, and swept after a crash. App sign-in pages have no privileged Tauri capabilities. Persistent records use stable video identities, not expiring playback URLs. Completed downloads and validated internal media can supply local playback; transient streaming buffers are managed by mpv.

The supplied workflow document informed component boundaries and recovery rules. Its inferred private Namida protocol details are not treated as a working dependency. Live streams, captions, account writes and batch playlist downloads are outside this first version.

See `docs/VERIFICATION.md` for actual checks and remaining limits, and `THIRD_PARTY_NOTICES.md` for bundled dependencies.

## Codebase graph

`graphify-out/graph.html` is the interactive codebase map, `graphify-out/graph.json` is the queryable graph, and `graphify-out/GRAPH_REPORT.md` records communities and relationship evidence. Generated builds, tool binaries, dependency caches and duplicate Windows icon exports are excluded. The graph covers app source, tests, scripts, design/runtime documentation and the app artwork.
