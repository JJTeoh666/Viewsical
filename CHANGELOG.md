# Changelog

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
