## TubeDesk 0.1.3 — 17 November 2026

- Rust: 48 tests passed, including legacy settings compatibility, persisted audio-only preference, and actual mpv/Lua pointer-leave regression checks. Native menus use rounded translucent ASS layers; ASS does not support backdrop blur. The HTML audio-player menu uses CSS backdrop blur.
- Frontend: 16 unit tests, TypeScript and production build passed. 42 integrated browser checks cover custom title controls, connected-account tick, back/forward navigation, dock/undock without another play request, retained queue, persisted audio setting commands, comments menu keyboard behavior, both themes and 1500/1024/700 widths.
- Player presentation: 12 isolated checks cover native rectangle visibility during docking, existing-source transport/seek, hover contrast, pointer enter/leave, menu dismissal, keyboard access and glass CSS.
- Windows native integration: nine real-app checks passed with isolated app data/WebView profile. Frameless state and scoped maximize/restore/minimize/close work; audio-only default overrides a new video request, survives restart, and starts the first new video in audio mode. Real native audio continues advancing across dock/undock with the same load ID.
- App artwork: supplied testicon.png was padded to a square using its existing background, preserving the full drawing. Multi-resolution Windows ICO and app PNG generated from this artwork.
- Custom window controls follow Tauri's [window customization guidance](https://v2.tauri.app/learn/window-customization/). Only the trusted main window receives minimize, maximize and drag permissions; the isolated sign-in WebView remains unprivileged.

Reproduce with scripts/test-rust.ps1, src/v013-fixture-smoke.mjs, scripts/player-layout-smoke.mjs and scripts/chrome-smoke.mjs. See artifacts/v013-frontend-fixture-results.json and artifacts/v013-player-layout-results.json and artifacts/v013-native-chrome-results.json.

---

# Verification record

## TubeDesk 0.1.2 - 17 November 2026

Added persistent internal audio/video caching, storage management, read-only video comments, and player audio/source lifecycle fixes. Namida's public cache/player/comment orchestration was reviewed; see CACHE_PLAYBACK.md for references and the implementation boundary.

- Rust: 47 regression/unit tests passed through scripts/test-rust.ps1. This compiles Cargo's actual test artifact and embeds the Windows Common Controls v6 manifest into a copy, required by the dialog plugin's TaskDialogIndirect import. It does not modify the application or Cargo artifact. Coverage includes the observed HLS response with no acodec, source clearing, stale entries, missing audio, cache validation/pins/partitions/restart cleanup, comment cursors/parser, and the real mpv Lua input fixture.
- Frontend: TypeScript and production builds passed, with 16 unit tests and 32 isolated browser fixture checks. Cache settings, pending bytes/workers, pinned deletion, comments sort/continuation/navigation cache, safe text rendering, disabled sections and session invalidation are covered. Both themes were inspected.
- Real comments: top and newest pages plus continuation returned actual Shelter comments. Ordering can change between provider requests, so the interface deduplicates by stable comment ID rather than claiming immutable page boundaries. Comments are viewing only.
- Audio diagnosis: direct Shelter sources can be rejected with403. Its selected HLS audio format234 has vcodec=none and protocol=m3u8_native but omits acodec. The adapter previously discarded it, passing video616 alone to the player. It now retains the selected audio component. Empty audio-files string values also caused mpv to open an empty filename; typed source arrays now pair/clear media without that parser issue.
- Native player: the final live suite passed 11 checks. Actual video playback had selected decoded audio and an open native output with mute off and positive volume. The reported Shelter video progressed continuously for30 seconds while those audio checks passed during background cache work. Online audio/video switching also retained audio. The tests establish decoder/output operation; they are not a recording of physical speakers.
- Persistent media: playing the short public video jNQXAC9IVRw produced separate complete audio/video cache files. Independent FFprobe checks confirmed expected tracks and duration; FFmpeg volume analysis confirmed the cached audio contained a non-silent signal. Replay opened the internal file path, and close/reopen reused it with working audio.
- Cache deletion: clearing active files deferred removal until the player released them; entries then reached zero. Explicit download records remained unchanged. Cache enable/size preferences survived restart. No signed googlevideo source URL was present in the persisted index.
- Native protocol: scripts/player-protocol-smoke.mjs passed five checks, including a semicolon in an audio filename, a typed paired source list, selected external audio, and clearing to an audio-only source. Native window/OS DPI combinations were not exhaustively retested.

Reproduce with scripts/test-rust.ps1, scripts/cache-player-smoke.mjs, scripts/player-protocol-smoke.mjs and src/v012-fixture-smoke.mjs. Results are in artifacts/v012-cache-player-results.json and artifacts/v012-frontend-fixture-results.json. The live suite uses isolated app data and WebView profiles and does not sign in or read personal browser sessions.

Automatic caching fetches the full selected source in background and can use additional data. Unknown duration, incomplete transfers, missing tracks, size-limit failure and validation errors cannot publish complete media. Internal cache is disposable; permanent media belongs in Downloads. Live streams, captions, remote account edits, comment posting/replies and batch playlist downloads remain deferred.

---

## TubeDesk 0.1.1 - 17 November 2026

Implemented and verified the playback, remembered sign-in, lifecycle and interface update.

- Rust: strict Clippy passed; 34 regression/unit tests passed, including stale-entry events, secondary-error precedence, source expiry, scoped headers, Mix identity, DPAPI roundtrip/tamper/forget, and shutdown races.
- Frontend: TypeScript and production build passed; 11 unit tests and 17 isolated browser fixture checks passed. Fixtures cover cached navigation and scroll, explicit reload, a 36-entry playlist, duplicate occurrences, continuation, mini-player continuity, audio mode, settings, accessibility controls, both themes and widths 1500/1024/700.
- Live playback: the reported Shelter video fzQ6gRAEoy0 rendered at 1080p. A 60-second continuous playback check passed. The final integrated native suite also passed playback, paused-position preservation across audio mode, returning to video, and mini-player expansion without another play command.
- Live transport diagnosis: direct video399 and audio251 URLs returned HTTP403. HLS video616 and audio234 both returned206. The bounded recovery now changes both components to HLS, preserves playback intent, and retains the original HTTP rejection when a secondary wrapper reports a missing file. Downloads use compatible HLS video/audio together before other sources.
- Live downloads: individual MP4 download paused/resumed, completed, and independently passed FFprobe audio/video stream validation. The completed local file played successfully. The new source format policy retains the pinned selection/fingerprint protections for partial-file resume.
- Account: the existing app-owned signed-in profile restored automatically; authenticated library returned13 playlists and24 entries from an actual playlist. Main close and reopen retained connected sign-in. No password, CAPTCHA or Google sign-in controls were automated; no external browser session was imported.
- Native lifecycle: main close with an isolated auth window exited normally; the regression tracked owned child PIDs and confirmed release. Library records survived restart. Seven old hidden0.1.0 instances were found holding the profile open and were stopped. The new single-instance plugin prevents duplicate new-version launches.
- Native input: upstream mpv disables its embedded Win32 child. TubeDesk now enables only its verified mpv-owned child. Native toggle and volume requests were observed from real pointer input. The video surface and overlay were visually inspected on this Windows desktop. Additional system DPI modes were not changed or exhaustively tested.

Reproducible checks: scripts/regression-smoke.mjs, scripts/account-smoke.mjs, src/fixture-smoke.mjs, scripts/source-probe.mjs and scripts/package-smoke.mjs. Native tests use an isolated profile except the explicitly named account check, which uses the app's existing remembered session without signing out. Result JSON and screenshots are in artifacts.

The portable package and installer preserve the application identifier and user-data location. Remembered login remains subject to Google's server-side expiry/revocation. Unavailable/private content and missing Mix context are reported explicitly. Live streams, captions, remote account edits and batch playlist downloads remain deferred.

---

# Verification — 16 November 2026

## Passed

- Rust formatting and `cargo clippy --all-targets -- -D warnings`.
- 19 Rust unit tests: URL/timestamp normalization, query/session-bound cursors, stream/header filtering, cookie scope and rotation, saved-session revalidation, redacted errors, settings/history persistence and partitions, source identity, download progress, and playback preferences.
- TypeScript check, Vite production build, and 6 frontend tests, including explicit/omitted playback positions through IPC.
- npm audit: zero reported vulnerabilities at implementation time.
- Browser layout checks at 1440, 1024 and 700 CSS pixels without horizontal overflow. Keyboard menu navigation, Escape, focus return, and Ctrl+K tested. Both themes inspected; measured dark normal-text/control contrast exceeded 4.5:1.
- Actual local HTTP range tests using the bundled yt-dlp: valid `206` resumed from byte 14302; a server ignoring Range with `200` restarted safely. Both final 42907-byte files matched the original SHA-256. Reproduce with `python scripts/range-smoke.py`.

## Actual desktop and YouTube checks

`scripts/smoke.mjs` launches Vite, the real Rust desktop executable and Playwright in one isolated test session. Debugging flags exist only in that test process. The final run passed all 15 checks, recorded in `artifacts/native-smoke-results.json`:

1. All five media tools available from bundled paths.
2. In-flight search cancellation returns the expected typed error.
3. A real YouTube link renders actual metadata.
4. Fresh playback applies newly saved volume, mute and speed preferences.
5. A real video plays through embedded mpv; pause and seek work.
6. Quality changes preserve pause and the five-second playback position.
7. Fullscreen enters and exits.
8. A real MP4 download pauses, resumes, merges and passes independent FFprobe checks for both video and audio.
9. An audio-only download passes independent FFprobe checks and preserves its source audio container.
10. A completed local file plays without resolving a streaming source.
11. Account library requests reject an anonymous session.
12. Untrusted pasted URLs are rejected.
13. Remote sign-in content cannot invoke privileged application commands.
14. The dedicated sign-in window opens Google's real page.
15. No frontend runtime errors observed.

The public test video was `jNQXAC9IVRw` ("Me at the zoo"). The final MP4 was 744413 bytes, with about 19 seconds duration. Both 240p and 144p sources played. A Windows screenshot visually confirmed that video rendered inside the reserved rectangle with controls below it. The native child-window title was also checked: it shows `TubeDesk video`, without a signed streaming URL.

One earlier audio request had a transient transport failure. A direct bundled-tool download and the final full desktop run both completed successfully. The app exposes failed-task Resume rather than marking incomplete output complete.

## Limits of this evidence

- No Google credentials, password-manager data, CAPTCHA or authentication controls were automated. Connected subscriptions, subscribed channels and private playlists require a personal sign-in test. Opening a Google page is not proof of successful authentication; Google can reject embedded WebView sign-in.
- Cookie parsing, native API usage, rotation conflicts and session-generation isolation are covered by code checks and unit tests; a complete signed-in account lifecycle has not been demonstrated with a real account.
- Native rendering was inspected at the computer's current Windows display scale. Other DPI values and hardware configurations are not exhaustively certified.
- Local-file playback was demonstrated. The computer's network adapter was not disabled during testing.
- Disk-full handling, arbitrary mid-stream URL expiry, unsupported codecs and every YouTube region/content policy were not all forced in a live test. Error handling exists, but those branches should not be represented as fully exercised.
- Windows x64 only. Live streams, captions, remote account edits and batch playlist downloads are outside this version.

## Build environment and dependencies

Rust 1.100.0 MSVC, Microsoft C++ tools 14.44, Node.js 24.11.1. Runtime dependencies are pinned in Cargo.lock/package-lock.json and `tools/manifest.json`: yt-dlp 2026.10.26, Deno 2.9.8, mpv 0.42.0 development build bcde6b93cc, FFmpeg/FFprobe 8.1.2 essentials. The matching cached tools were verified twice without changing their binary timestamps. Dependency notices and source links are included in `tools/licenses` and `THIRD_PARTY_NOTICES.md`.

Native process, loopback and named-pipe testing required an execution session outside the restricted command sandbox. This did not require disabling Windows security settings. An intermittent Windows linker file lock cleared on retry; the actual final Rust unit-test run passed all 19 tests.

## Release package

The optimized Windows x64 build produced the per-user NSIS installer and portable ZIP in `artifacts`. The portable executable was launched without Vite; it served the bundled interface from `http://tauri.localhost/`, loaded the bundled font and located every bundled media helper. `artifacts/package-smoke-results.json` records that check. The portable ZIP's file list and CRCs were verified. Package SHA-256 values are in `artifacts/SHA256SUMS.txt`.

The installer was compiled and hashed; it was not installed over the user's system during testing. The portable application is the launch-tested release layout.
