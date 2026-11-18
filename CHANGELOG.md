# Changelog

## Viewsical 0.1.10 — 18 November 2026

- Wait for Viewsical and its playback helper to exit during an install or uninstall.
- Document how to keep the existing installation and app data when upgrading.

## Viewsical 0.1.9 — 18 November 2026

- Scroll video and playback controls together in the main window. If the renderer fails, the compatibility player resumes the current item.
- Draw YouTube’s Most replayed graph on the video and audio seek bars when the data is available.
- Remove the Keyboard controls button beneath the video. Press Tab to reach the playback controls.
- Document how to run and test the desktop app before packaging.

## Viewsical 0.1.8 — 18 November 2026

- Reduce playback polling and redundant control updates.
- Remove the upper fullscreen button from the floating miniplayer and retain the footer's Expand player control.
- Open audio and video from the beginning and clear saved positions while retaining watch history.
- Stop cleanly at the end of the queue with replay and seeking available.

## Viewsical 0.1.7 — 18 November 2026

- Share React playback controls, Lucide icons and translucent menus between video and audio modes. Reuse one transparent controls WebView above the native player.
- Keep the visible part of the video playing while scrolling the watch page, with clipping below the header.
- Use a circular search button and add Back to top on Home and individual playlist pages.
- Change volume by five percentage points with Up/Down, preserving text and menu navigation, mute state and normalization.
- Restore seeking and replay after the final item in an audio-only queue finishes.
- Retain loudness normalization in video, audio-only, cache replay and completed downloads, with independent user volume.
- Hide the outer page scrollbar while retaining scrolling and automatic pagination.
- Remove the retired Lua control renderer and clean up its installed resource during upgrades.
- Split the YouTube adapter into focused Rust modules while preserving its public interface and function behavior.
- Refresh the Graphify codebase map and retain existing documentation concepts.

Windows x64 packages include the required media helpers and third-party notices. The internal app identifier remains unchanged, preserving existing sign-in, history, downloads and preferences across upgrades.

Verification includes 61 Rust tests, 26 frontend unit tests and 10 isolated live app checks covering actual YouTube video/audio playback, normalization, cache replay, completed audio download and restart behavior. Additional native and browser layout coverage is recorded in the shared-player and scrolling documents under `docs/`.
