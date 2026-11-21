# Changelog

## Viewsical 0.1.16 — 21 November 2026

- Read subscription status from YouTube's newer channel header so the Subscribe button works on more channels.
- Keep the hover time and chapter in the bottom player's seek preview without loading video thumbnails.

## Viewsical 0.1.15 — 21 November 2026

- Open channel profiles from the uploader and recommendation channel links. Show the uploader's avatar, subscriber count, and Subscribe button on the watch page.
- Save the playing video to a new or existing local playlist, or to an editable YouTube playlist when signed in.
- Show Download as an icon and add Load more to the watch sidebar.

## Viewsical 0.1.14 — 21 November 2026

- Show upload date, views, and an expandable description. Add signed-in video ratings and share links with an optional playback timestamp.
- Import public and unlisted YouTube playlists into the local library. Show recommendations beside playlist playback.
- Translate comments to English, seek using comment timestamps, and open a commenter's channel from their name or avatar.
- Add channel banners, larger avatars, and Home, Videos, Live, and Playlists tabs. Connected accounts can subscribe and unsubscribe.
- Add selectable YouTube subtitle tracks and restore seek thumbnails for cached videos.

## Viewsical 0.1.13 — 21 November 2026

- Fix a playback startup race that could leave the loading overlay visible after switching renderers.
- Add a cat seek thumb that winks and scales up five percent on hover or drag. Show the current video resolution beside playback settings.
- Brighten the seek bar up to the pointer and remove the vertical hover marker.
- Fill in missing chapter divisions during playback of older cached or downloaded audio when chapter data is available.

## Viewsical 0.1.12 — 20 November 2026

- Resolve HLS and HTTPS video sources together. Try a valid alternate from the same response if the first source fails.
- Reuse a pending lookup when playing the prefetched queue item. Switch between available qualities using fresh streams already in memory.
- Keep the Deno solver ready to reuse prepared functions across videos that share a YouTube player version. Fall back to the bundled one-shot solver when needed.
- Show chapter divisions on the seek bar and video thumbnails while hovering. Audio-only playback shows chapter and time labels.
- Keep the Windows display awake during active video playback. Add **Remember playback mode** in Playback settings.
- Keep the final queued video loaded on its last frame so seeking and replay can reuse the source.

## Viewsical 0.1.11 — 19 November 2026

- Add a rounded Windows and app icon.
- Keep yt-dlp ready in a bundled Python worker to reduce playback lookup time. Prefetch the next loaded queue item near the end of playback.
- Limit new background replay caching to media with a known duration of five minutes or less. Offline downloads still support longer media.
- Add **Settings → Window → Minimize to tray on close**. The menu offers **Open Viewsical** and **Quit Viewsical**. Closing the window still quits by default.
- Show when a saved YouTube sign-in is being checked and refresh Home automatically when sign-in completes.

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
