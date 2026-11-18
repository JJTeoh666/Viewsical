# Audio normalization and player changes — Viewsical 0.1.5

Viewsical 0.1.6 retains this gain policy and replaces the historical ASS/Lua controls described below with [shared React controls](SHARED_PLAYER.md). Normalization is regression-tested in both video and audio-only modes, including cached and completed download playback.

The supplied `C:\jj\Testing\audionorm.md` is reference analysis, not an instruction source. Its verified Namida principle is retained: negate a YouTube loudness value to obtain a per-item playback correction, keep it independent from user volume, reset missing values, and bind results to the current video/load. No private Namida dependency is included.

## Gain policy

`normalization::gain_db` accepts finite YouTube loudness values within [-100,100] dB. Enabled playback uses `clamp(-loudness_db, -20, 0)` dB, equivalent to `clamp(10^(-loudness_db/20),0.1,1.0)` in linear amplitude. Positive reported loudness attenuates the track. Quiet tracks are not boosted; this conservative headroom policy avoids adding clipping without a measured peak or limiter. Missing/invalid metadata or a disabled setting uses 0 dB. This is metadata normalization, not waveform analysis, dynamic compression or a guaranteed LUFS target.

The mpv `volume-gain` property applies dB gain on top of the user volume. The volume slider continues to represent the user's unnormalized setting; mpv's cubic volume curve is not reused as a linear multiplier. There is no filter-chain rebuild, second audio source, re-encode or extra startup network request. Muting, speed, position and pause intent remain independent.

## Adapter and lifecycle

The bundled `ytdlp-plugins/viewsical` plugin overrides the pinned yt-dlp 2026.10.26 YouTube extractor through its documented plugin hook. It reads only `playerConfig.audioConfig.loudnessDb` from a player response whose `videoDetails.videoId` matches the requested item. A context-local extraction scope handles reuse, nested/concurrent calls and exceptions. It adds only optional `viewsical_loudness_db` to normalized helper output. It does not fetch an extra response or retain raw responses, stream URLs or cookies.

The app passes `--no-plugin-dirs` followed by one explicit application-owned plugin directory. Default/user plugin directories stay disabled. The frozen yt-dlp executable supplies Python; no system Python is needed. The pinned extractor hook must be checked when upgrading yt-dlp.

Rust validates the value again and retains it as optional `MediaItem.youtubeLoudnessDb`. Only this stable numeric value accompanies normal cache/download metadata. Existing cache/download records remain readable; records without a value use neutral gain. Fresh cache fills and download helper metadata preserve the value for offline playback. Downloaded audio bytes remain unchanged.

Source commits pass an explicit string-valued `volume-gain` file option, including 0 for missing metadata. Existing selection/load/session guards reject stale extraction results. A settings change serializes with source commits and applies gain from the current item; the file-loaded handler re-reads the setting to cover changes during opening. Changing volume keeps normalization separate. The settings UI saves the latest active volume/mute values rather than an older settings snapshot.

## Native controls and window state

The native ASS overlay now uses physical one-pixel clipped alpha rows with smoothstep easing instead of 6/12 large strips. Pixel-aligned clips avoid fractional strip seams and overlapping antialias edges. Top/bottom fades disappear with the controls when the pointer leaves.

Native video settings share the audio menu's root layout: Playback mode, Playback speed, Quality; vector icons, right-aligned values and chevrons; rounded translucent surface; disabled audio-only quality. The root has no extra Settings header. Submenus preserve current selection and scoped input. ASS cannot sample and blur the underlying video, so the native surface uses translucency; the web menu retains CSS backdrop blur.

Main-window maximized/restored state is persisted separately in SQLite `ui_state`, restored before the initial window is shown, and updated on normal resize/close. Fullscreen, minimized and hidden states do not replace the normal choice. Frontend settings and account changes cannot overwrite it.

## Verification

- Rust checks and 54 native tests: normalization sign/caps/fallback, stored metadata, legacy settings, cache leases, scoped native input and window state isolation.
- 17 frontend unit tests plus TypeScript/Vite production build.
- 9 plugin tests: matching IDs, missing/non-finite/bool values, extractor reuse, nested/concurrent calls and exception cleanup.
- Actual bundled mpv PCM float output at user volumes 37,80,100: -6 dB amplitude ratios approximately 0.501187, then native IPC checks for per-file resets and live toggling. Integer PCM output has its own gain quantization; float output verifies the requested gain without that test-sink rounding.
- 9 actual mpv/ASS checks and screenshots: smooth fades, matching native menu, mode submenu action and pointer-leave clearing.
- Isolated app-profile live playback, gain toggles, audio/video switching, completed cache and download replay, and real window close/reopen checks are recorded in `artifacts/v015-app-results.json`.

Live anonymous test values: `dQw4w9WgXcQ` returned +0.98999977 dB (correction -0.98999977); `jNQXAC9IVRw` returned -9.6700001 dB (neutral under the no-boost policy). These observations do not guarantee metadata availability for every video/client. Tests do not establish authenticated account behavior.

## Primary technical references

- [mpv volume and gain contracts](https://mpv.io/manual/stable/#options-volume-gain)
- [mpv audio gain implementation](https://github.com/mpv-player/mpv/blob/master/player/audio.c)
- [yt-dlp plugin mechanism](https://github.com/yt-dlp/yt-dlp#plugins)
- [Pinned YouTube extractor](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/youtube/_video.py)
