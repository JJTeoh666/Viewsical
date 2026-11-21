# Graph Report - Viewsical  (2026-11-21)

## Corpus Check
- 149 files · ~115,523 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2272 nodes · 5556 edges · 126 communities (95 shown, 31 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 252 edges (avg confidence: 0.67)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Persistent Media Cache
- Account Session Isolation
- Download Job Lifecycle
- Native Overlay and Geometry
- ui.tsx
- Shared Playback Controls
- video_surface.rs
- Frontend Data Contracts
- Application
- Browser Interface Regression
- Read Only Comment Interface
- Audio Readiness and Native Events
- Windows Bundle Configuration
- Frontend Dependencies
- video_renderer.rs
- Player Commands and Presentation
- account_actions.py
- Comments and Data Models
- Media Failure Recovery
- process.rs
- AppError
- playback.rs
- YouTube Adapter Regression
- Native Playback Ownership
- Local Persistent State
- watch.rs
- youtube/subtitles.rs
- persistent_solver.py
- timeline.rs
- SubscriptionTests
- display_awake.rs
- Viewsical
- verify-video-renderer.mjs
- Adapter and Range Checks
- v017-browser-smoke.mjs
- Application Startup and Shutdown
- pending.rs
- tray.rs
- Queue and Browse Interface
- Browse Metadata Cache
- Playback Source Lifecycle
- media_item
- Scoped Overlay Actions
- Persistent Data Contracts
- Release Package Verification
- Stable YouTube Identity
- player/subtitles.rs
- Application TypeScript Options
- YouTube Browse Metadata
- Cache Playback Integration
- Desktop Window Integration
- local_playlists.rs
- Native Scroll Regression
- Offline Media Orchestration
- Native Controls Regression
- Normalization App Regression
- Live Media Regression
- Result
- .resolve_source
- json
- Application Lifecycle Regression
- YouTube Request Lifecycle
- Gpu
- Historical Lua Visual Tests
- Build TypeScript Options
- Media Protocol Diagnostics
- PlaybackPlan
- smoke.mjs
- Normalization and IPC Diagnostics
- LoudnessPluginTests
- local_playlists_survive_reopening_and_reimport_replaces_the_snapshot
- Mpv
- caption_download.py
- Viewsical 0.1.18 release changes
- Shared Controls Architecture
- WatchInfo
- test-loudness-plugin.py
- worker.py
- Loudness Normalization Policy
- MediaFailure
- Remembered Window State
- Wake
- scripts
- Account Session Verification
- super
- comment_translate.py
- Scrolling and Navigation Behavior
- Historical Architecture Notes
- Dependency License Collection
- Bundled Media Tool Setup
- Application Architecture and Release
- Installer and portable delivery
- Library
- pathlib
- persistent-solver.js
- Circular playback medallion
- Main Window Capabilities
- Overlay Window Capabilities
- Recovery
- Input
- Viewsical 0.1.7 release changes
- Output
- NoRedirects
- Seek Cat Sprite Sheet
- TypeScript Project References
- Viewsical 0.1.10 Windows install and upgrade handling
- Viewsical 0.1.11 worker, prefetch, cache limit, and tray
- Viewsical 0.1.12 source reuse, seek preview, and display sleep
- Viewsical 0.1.13 playback startup and timeline improvements
- Viewsical 0.1.14 watch actions, comments, and subtitles
- Viewsical 0.1.15 channel profiles and playlist actions
- Viewsical 0.1.16 subscription state and thumbnail-free docked preview
- Viewsical 0.1.17 subscription, playlist, and comment changes
- Viewsical 0.1.8 lower playback overhead and queue completion
- Viewsical 0.1.9 in-page video scrolling and Most replayed
- Rust Package Identity

## God Nodes (most connected - your core abstractions)
1. `AppResult` - 219 edges
2. `PlayerManager` - 93 edges
3. `AppState` - 65 edges
4. `AppError` - 51 edges
5. `Application()` - 45 edges
6. `Store` - 38 edges
7. `PlaybackPlan` - 36 edges
8. `SessionManager` - 30 edges
9. `YoutubeGateway` - 30 edges
10. `ensure_generation()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `Session-generation invalidation` --semantically_similar_to--> `In-memory browsing pages`  [INFERRED] [semantically similar]
  docs/CACHE_PLAYBACK.md → README.md
- `Scoped frameless window controls` --conceptually_related_to--> `Isolated account WebView`  [EXTRACTED]
  docs/VERIFICATION.md → README.md
- `Background FFmpeg component copy` --implements--> `Validated persistent media cache`  [EXTRACTED]
  docs/CACHE_PLAYBACK.md → README.md
- `Disposable cache boundary` --rationale_for--> `Validated persistent media cache`  [EXTRACTED]
  docs/CACHE_PLAYBACK.md → README.md
- `Pinned cache file leases` --rationale_for--> `Validated persistent media cache`  [EXTRACTED]
  docs/CACHE_PLAYBACK.md → README.md

## Import Cycles
- 1-file cycle: `src-tauri/src/video_surface.rs -> src-tauri/src/video_surface.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/watch.rs -> src-tauri/src/youtube/gateway.rs`
- 2-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/timeline.rs -> src-tauri/src/youtube/gateway.rs`
- 2-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/subtitles.rs -> src-tauri/src/youtube/gateway.rs`
- 2-file cycle: `src-tauri/src/youtube/pending.rs -> src-tauri/src/youtube/playback.rs -> src-tauri/src/youtube/pending.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/downloads.rs -> src-tauri/src/lib.rs -> src-tauri/src/downloads.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/playback.rs -> src-tauri/src/youtube/gateway.rs`
- 3-file cycle: `src-tauri/src/downloads.rs -> src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/downloads.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/video_surface.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/watch.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/pending.rs -> src-tauri/src/youtube/watch.rs -> src-tauri/src/youtube/gateway.rs`
- 3-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/pending.rs -> src-tauri/src/youtube/playback.rs -> src-tauri/src/youtube/gateway.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/youtube/gateway.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 4-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/youtube/pending.rs -> src-tauri/src/youtube/watch.rs -> src-tauri/src/lib.rs`
- 4-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/pending.rs -> src-tauri/src/youtube/watch.rs -> src-tauri/src/lib.rs`
- 4-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/playback.rs -> src-tauri/src/youtube/pending.rs -> src-tauri/src/youtube/watch.rs -> src-tauri/src/youtube/gateway.rs`

## Hyperedges (group relationships)
- **Validated local playback lifecycle** — docs_cache_playback_local_first, docs_cache_playback_output_validation, docs_cache_playback_file_leases, readme_media_cache, readme_native_player [EXTRACTED 1.00]
- **Account-scoped state invalidation** — docs_cache_playback_session_generation, readme_media_cache, docs_cache_playback_comment_cursor, readme_browse_cache [INFERRED 0.95]

## Communities (126 total, 31 thin omitted)

### Community 0 - "Persistent Media Cache"
Cohesion: 0.07
Nodes (34): cache_clear(), cache_command(), cache_configure(), cache_outputs(), cache_summary(), CacheContent, Audio, Both (+26 more)

### Community 1 - "Account Session Isolation"
Cohesion: 0.07
Nodes (34): allowed_cookie_domain(), allowed_navigation(), BLOCKED, complete_sign_in(), cookie_key(), cookie_line(), cookie_updates_reject_external_domains_and_preserve_expiry(), CookieKey (+26 more)

### Community 2 - "Download Job Lifecycle"
Cohesion: 0.07
Nodes (20): download_action(), download_error(), DownloadManager, enqueue_download(), errors_do_not_expose_session_material(), format_selector(), hide_command(), identity_compatible() (+12 more)

### Community 3 - "Native Overlay and Geometry"
Cohesion: 0.08
Nodes (42): accept_ready(), allowed_navigation(), allowed_url(), apply(), bounds(), create_window(), Desired, desired_geometry() (+34 more)

### Community 4 - "ui.tsx"
Cohesion: 0.09
Nodes (37): lucide-react, react, BrowseEntry, Fetcher, channelBrowseKind, compactCount, sections, ChannelSubscribe() (+29 more)

### Community 5 - "Shared Playback Controls"
Cohesion: 0.08
Nodes (43): ControlsProps, HeatmapProps, PlayerControls, PlayerSettings(), close(), keys(), replayHeatmap(), SettingsProps (+35 more)

### Community 6 - "video_surface.rs"
Cohesion: 0.09
Nodes (30): apply(), eligible(), failed(), forward(), install_buffer(), is_canvas(), log_helper_error(), MAX_BYTES (+22 more)

### Community 7 - "Frontend Data Contracts"
Cohesion: 0.08
Nodes (35): api, QueuePrefetch, video, relativeDate(), active, cacheLimits, cacheUsage(), GiB (+27 more)

### Community 8 - "Application"
Cohesion: 0.07
Nodes (28): Application(), activate(), browseContent(), openPlaylist(), openSignIn(), playlistSaved(), playPlaylistCard(), refreshSubscriptionLibrary() (+20 more)

### Community 9 - "Browser Interface Regression"
Cohesion: 0.07
Nodes (26): vite@^7.3.1, playwright, vite, output, results, root, check(), output (+18 more)

### Community 10 - "Read Only Comment Interface"
Cohesion: 0.09
Nodes (20): COMMENT_LIMIT, CommentCache, CommentEntry, commentKey(), Fetcher, RecordEntry, CommentReplies(), CommentRow() (+12 more)

### Community 11 - "Audio Readiness and Native Events"
Cohesion: 0.07
Nodes (22): cacheable_duration(), audio_params_present(), audio_source_command(), AudioState, AudioTrack, engine_reset_accepts_early_events_for_reused_entry_id(), EntryTracker, fresh_play_commands_use_latest_saved_preferences() (+14 more)

### Community 12 - "Windows Bundle Configuration"
Cohesion: 0.05
Nodes (41): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+33 more)

### Community 13 - "Frontend Dependencies"
Cohesion: 0.07
Nodes (34): dependencies, @fontsource/roboto@^5.2.8, lucide-react@^0.577.0, react@^19.2.4, react-dom@^19.2.4, @tauri-apps/api@^2.10.1, @tauri-apps/plugin-dialog@^2.6.0, devDependencies (+26 more)

### Community 14 - "video_renderer.rs"
Cohesion: 0.06
Nodes (12): ADVANCED_CONTROL, BLOCK_FOR_TARGET_TIME, D3D11_FBO, D3D11_INIT_PARAMS, FRAME_PRESENT, FRAME_REDRAW, FrameInfo, MAX_FRAME_BYTES (+4 more)

### Community 15 - "Player Commands and Presentation"
Cohesion: 0.13
Nodes (23): AppState, bootstrap(), clear_history(), reveal_download(), save_settings(), AppResult, ensure_control_load(), ensure_control_window() (+15 more)

### Community 16 - "account_actions.py"
Cohesion: 0.12
Nodes (24): channel_controls(), dedicated_controls(), descendants(), matching_control(), playlist_options(), QuietLog, rating_action(), rating_controls() (+16 more)

### Community 17 - "Comments and Data Models"
Cohesion: 0.13
Nodes (29): bad_cursor(), bounded_text(), cancel_comments(), comment_from_json(), comment_parent(), Cursor, cursors_are_bounded_and_scoped_to_video_sort_and_account_generation(), disabled_empty_and_missing_sections_are_distinct() (+21 more)

### Community 18 - "Media Failure Recovery"
Cohesion: 0.20
Nodes (3): classify_media_failure(), merge_failure(), StartupClock

### Community 19 - "process.rs"
Cohesion: 0.12
Nodes (9): cancelled(), MAX_JSON, PlaybackWorker, read_limited(), size_error(), timeout_error(), worker_error(), WORKER_START (+1 more)

### Community 20 - "AppError"
Cohesion: 0.12
Nodes (18): AppError, ACTION_TIMEOUT, cancelled(), channel_subscription(), log_subscription_diagnostics(), playlist_save_unavailable(), playlist_sign_in(), RESPONSE_LIMIT (+10 more)

### Community 21 - "playback.rs"
Cohesion: 0.18
Nodes (23): cdn_url(), expired_source(), has_expired_component(), is_audio_track(), is_hls(), make_video_plan(), matching_headers(), MAX_CACHED_INVENTORIES (+15 more)

### Community 22 - "YouTube Adapter Regression"
Cohesion: 0.11
Nodes (21): encode_cursor(), classify_error(), playback_from_json(), source_selector(), video_candidates_from_json(), candidate_fixture(), classifies_rejections_without_exposing_cookie_material(), expired_selections_never_outrank_a_fresh_candidate() (+13 more)

### Community 23 - "Native Playback Ownership"
Cohesion: 0.09
Nodes (7): ProcessJob, LocalSource, PipeWriter, PlayerManager, PrefetchAttempt, QueueBackground, QueuePrefetch

### Community 24 - "Local Persistent State"
Cohesion: 0.17
Nodes (7): history_and_settings_survive_reopening(), maximized_state_survives_reopening_and_stale_settings_saves(), old_download_defaults_move_to_app_storage_and_custom_folders_stay_selected(), remembered_mode_survives_reopening_and_other_setting_changes(), Store, write_preferred_playback_mode(), write_settings()

### Community 25 - "watch.rs"
Cohesion: 0.16
Nodes (17): ensure_generation(), CachedDetails, DETAILS_TTL, MAX_DETAILS, rate_video(), rating_unavailable(), validate_video(), video_channel() (+9 more)

### Community 26 - "youtube/subtitles.rs"
Cohesion: 0.14
Nodes (13): cancelled(), CAPTION_TIMEOUT, CAPTION_TTL, CaptionCache, CaptionSource, Catalog, download_failed(), MAX_CAPTION_BYTES (+5 more)

### Community 27 - "persistent_solver.py"
Cohesion: 0.14
Nodes (10): activate(), digest(), instrumented_core(), millis(), pinned_scripts(), provider_responses(), remaining(), reusable_core() (+2 more)

### Community 28 - "timeline.rs"
Cohesion: 0.14
Nodes (10): board(), BOARD_TTL, cached_storyboards_expire_without_discarding_chapters(), MAX_TIMELINES, MISSING_TTL, storyboard_expiry(), Timeline, TimelineCache (+2 more)

### Community 29 - "SubscriptionTests"
Cohesion: 0.20
Nodes (6): ambiguous_control(), channel_doc(), legacy_control(), modern_control(), SubscriptionTests, watch_doc()

### Community 30 - "display_awake.rs"
Cohesion: 0.10
Nodes (3): DisplayAwake, needs_display(), PowerRequest

### Community 31 - "Viewsical"
Cohesion: 0.09
Nodes (23): Viewsical HTML application shell, React main entrypoint reference, Remembered playback mode and audio-only default, Independent playback loudness normalization, In-memory browsing pages, Queryable codebase map, Bounded read-only comment browsing, Tauri Rust React and TypeScript desktop stack (+15 more)

### Community 32 - "verify-video-renderer.mjs"
Cohesion: 0.13
Nodes (23): analyses, canvasInteractions(), checks, children, data, delay(), desktopOrigin(), exec (+15 more)

### Community 33 - "Adapter and Range Checks"
Cohesion: 0.11
Nodes (5): _ViewsicalChannelIE, _comment_threads(), _loudness_for_video(), _record_comment_threads(), _ViewsicalYoutubeIE

### Community 34 - "v017-browser-smoke.mjs"
Cohesion: 0.16
Nodes (22): chapterGeometry(), check(), output, previewSheet(), railPixels(), results, root, scaledOverlayChecks() (+14 more)

### Community 35 - "Application Startup and Shutdown"
Cohesion: 0.12
Nodes (7): Bootstrap, desktop_builder(), request_shutdown(), run(), ShutdownSignals, simultaneous_close_routes_start_exactly_one_cleanup(), AppPaths

### Community 36 - "pending.rs"
Cohesion: 0.17
Nodes (6): attaching_before_queue_cancellation_keeps_one_lookup(), final_subscriber_and_account_change_cancel_work(), Lookup, Outcome, PendingPrefetches, PrefetchWork

### Community 37 - "tray.rs"
Cohesion: 0.17
Nodes (10): create_icon(), hide_icon(), ID, maintenance_requested(), OPEN, QUIT, show_icon(), show_main_window() (+2 more)

### Community 38 - "Queue and Browse Interface"
Cohesion: 0.18
Nodes (13): isDesktop, accountPages, activeDownloads, browseKinds, BackToTop(), appendQueuePage(), boundMix(), emptyQueue() (+5 more)

### Community 39 - "Browse Metadata Cache"
Cohesion: 0.17
Nodes (6): BrowseCache, mergeBrowseItems(), RecordEntry, BrowseKind, BrowsePage, RecommendationSource

### Community 41 - "media_item"
Cohesion: 0.20
Nodes (12): ReplayHeatSegment, cancel_browse(), canonical_video(), media_item(), replay_heatmap(), storyboard_format(), text(), video_channel_id() (+4 more)

### Community 42 - "Scoped Overlay Actions"
Cohesion: 0.10
Nodes (18): OverlayAction, AdjustVolume, FocusControls, Fullscreen, Minimize, Mode, Mute, Next (+10 more)

### Community 43 - "Persistent Data Contracts"
Cohesion: 0.15
Nodes (16): AppSettings, BrowsePage, CollectionSummary, DownloadRequest, DownloadTask, HistoryItem, MediaItem, PlayerBounds (+8 more)

### Community 44 - "Release Package Verification"
Cohesion: 0.13
Nodes (12): app, delay(), env, executable, results, root, until(), child (+4 more)

### Community 45 - "Stable YouTube Identity"
Cohesion: 0.20
Nodes (15): ChannelProfile, VideoRef, browse_target(), invalid_channel(), profile(), profile_separates_safe_header_images_and_ignores_shelf_counts(), safe_image(), tab_url() (+7 more)

### Community 46 - "player/subtitles.rs"
Cohesion: 0.24
Nodes (7): SourceToken, attached_id(), cancelled(), native_track_id(), PlayerManager, SelectedSubtitle, SubtitleFile

### Community 47 - "Application TypeScript Options"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+11 more)

### Community 48 - "YouTube Browse Metadata"
Cohesion: 0.18
Nodes (5): collection_summary(), decode_cursor(), includes_item(), PAGE_SIZE, YoutubeGateway

### Community 49 - "Cache Playback Integration"
Cohesion: 0.15
Nodes (15): children, close(), data, delay(), engine(), ipc(), launch(), out (+7 more)

### Community 50 - "Desktop Window Integration"
Cohesion: 0.15
Nodes (15): children, close(), data, delay(), engine(), ipc(), launch(), out (+7 more)

### Community 51 - "local_playlists.rs"
Cohesion: 0.20
Nodes (10): import_local_playlist(), import_target(), imported_playlist(), local_playlist(), local_playlists(), MAX_PLAYLIST_ITEMS, preserves_order_and_duplicates_and_skips_private_entries(), remove_local_playlist() (+2 more)

### Community 52 - "Native Scroll Regression"
Cohesion: 0.15
Nodes (14): children, delay(), invoke(), ipc(), item, native(), playing(), profile (+6 more)

### Community 53 - "Offline Media Orchestration"
Cohesion: 0.14
Nodes (9): Background FFmpeg component copy, Namida public orchestration reference, Selected HLS audio metadata fix, Native decoder and output evidence, TubeDesk versioned verification evidence, Persistent resumable downloads, libmpv in-page WebView video renderer, Validated persistent media cache (+1 more)

### Community 54 - "Native Controls Regression"
Cohesion: 0.16
Nodes (14): children, delay(), invoke(), ipc(), item, native(), playing(), profile (+6 more)

### Community 55 - "Normalization App Regression"
Cohesion: 0.17
Nodes (14): children, close(), data, delay(), ipc(), launch(), native(), playing() (+6 more)

### Community 56 - "Live Media Regression"
Cohesion: 0.17
Nodes (14): children, close(), data, delay(), ipc(), launch(), native(), playing() (+6 more)

### Community 57 - "Result"
Cohesion: 0.22
Nodes (5): notify(), Renderer<'a>, Result, run(), run_video_renderer()

### Community 58 - ".resolve_source"
Cohesion: 0.30
Nodes (4): PrefetchLookup, PlaybackCandidates, ResolveOptions, YoutubeGateway

### Community 59 - "json"
Cohesion: 0.19
Nodes (3): check_resume(), main(), run()

### Community 60 - "Application Lifecycle Regression"
Cohesion: 0.17
Nodes (13): children, closeMain(), data, delay(), launch(), out, ownedIds(), processRows() (+5 more)

### Community 61 - "YouTube Request Lifecycle"
Cohesion: 0.21
Nodes (3): Active, RequestGuard, YoutubeGateway

### Community 62 - "Gpu"
Cohesion: 0.17
Nodes (3): Gpu, Mapping, Surface

### Community 63 - "Historical Lua Visual Tests"
Cohesion: 0.14
Nodes (10): capture, child, dir, harness, output, pipe, replies, results (+2 more)

### Community 64 - "Build TypeScript Options"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, lib, module, moduleDetection, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 65 - "Media Protocol Diagnostics"
Cohesion: 0.15
Nodes (9): client, replies, audio, child, dir, ffmpeg, root, run (+1 more)

### Community 66 - "PlaybackPlan"
Cohesion: 0.37
Nodes (3): PlaybackPlan, SourceCache, SourceKey

### Community 67 - "smoke.mjs"
Cohesion: 0.18
Nodes (8): children, delay(), out, results, root, run, until(), root

### Community 68 - "Normalization and IPC Diagnostics"
Cohesion: 0.18
Nodes (9): checks, child, dir, ffmpeg, mpv, render(), root, run (+1 more)

### Community 71 - "Mpv"
Cohesion: 0.22
Nodes (7): Callback, D3dObject, Mpv, Renderer, RenderParam, .END, update_ready()

### Community 73 - "Viewsical 0.1.18 release changes"
Cohesion: 0.18
Nodes (11): Translucent chapter and time preview in the bottom player, App-local download default and corrected Downloads subtitle, Full-width theater mode with optional queue and recommendations, Playback minimization and distinct fullscreen exit icon, Single View full playlist action, Selective replay cache content, Back to top on search results, Viewsical 0.1.18 release changes (+3 more)

### Community 74 - "Shared Controls Architecture"
Cohesion: 0.20
Nodes (11): Native mpv compatibility renderer, libmpv Direct3D 11 and WebView2 shared-buffer canvas, Final queue item EOF recovery, Native playback, DPI, and lifecycle verification, PlayerControls.tsx shared playback controls, PlayerOverlay.tsx controls-only presentation, Playback progress and control gesture lifecycle, Serialized five-point volume actions (+3 more)

### Community 75 - "WatchInfo"
Cohesion: 0.22
Nodes (8): SaveVideoDialog(), create(), save(), VideoDescription(), WatchActionMenu(), close(), menuKeys(), WatchInfo()

### Community 77 - "worker.py"
Cohesion: 0.24
Nodes (3): extract(), main(), RequestLog

### Community 78 - "Loudness Normalization Policy"
Cohesion: 0.27
Nodes (7): Audio normalization policy and historical 0.1.5 player changes, Historical 0.1.5 ASS/Lua controls, mpv volume-gain technical reference, mpv volume-gain, MediaItem.youtubeLoudnessDb metadata, Viewsical yt-dlp loudness plugin, yt-dlp plugin mechanism reference

### Community 79 - "MediaFailure"
Cohesion: 0.22
Nodes (8): MediaFailure, AudioMissing, Decoder, Network, Premature, Rejected, Unavailable, Unknown

### Community 80 - "Remembered Window State"
Cohesion: 0.40
Nodes (5): MainWindowState, remember(), remember_resize(), restore(), temporary_window_states_do_not_replace_the_normal_choice()

### Community 82 - "scripts"
Cohesion: 0.25
Nodes (8): scripts, build, check, dev, preview, tauri, test, test:e2e

### Community 83 - "Account Session Verification"
Cohesion: 0.39
Nodes (7): close(), delay(), invoke(), launch(), results, root, until()

### Community 84 - "super"
Cohesion: 0.32
Nodes (3): gain_db(), valid_loudness(), youtube_sign_and_amplitude_are_correct()

### Community 85 - "comment_translate.py"
Cohesion: 0.48
Nodes (4): bytes_field(), main(), translation_action(), varint()

### Community 86 - "Scrolling and Navigation Behavior"
Cohesion: 0.38
Nodes (6): Native clipping and navigation verification, Search submit and Back to top controls, Scrolling and navigation in Viewsical 0.1.7, Restricted overlay capability boundary, Retry controls overlay recovery, Reusable transparent controls WebView host

### Community 87 - "Historical Architecture Notes"
Cohesion: 0.43
Nodes (5): Historical 0.1.5 playback coordination query, Historical PlaybackPlan reference, Historical PlayerManager coordination reference, Historical tubedesk_osc.lua renderer reference, Historical Viewsical 0.1.5 Electron assessment

### Community 88 - "Dependency License Collection"
Cohesion: 0.29
Nodes (6): collect(), index, out, pkg, root, seen

### Community 89 - "Bundled Media Tool Setup"
Cohesion: 0.52
Nodes (6): CopyNotice(), CopyVerified(), Fetch(), FetchNotice(), Matches(), Verify()

### Community 90 - "Application Architecture and Release"
Cohesion: 0.33
Nodes (6): Remembered-session and shutdown checks, Scoped frameless window controls, Bounded main-window shutdown, Embedded Google sign-in limitation, Dedicated remembered Google sign-in, Isolated account WebView

### Community 91 - "Installer and portable delivery"
Cohesion: 0.33
Nodes (6): Launch-tested portable release layout, Latest GitHub release downloads, Pinned bundled media helpers, Persistent Python source worker and queue prefetch, Installer and portable delivery, Focused YouTube adapter modules

### Community 94 - "persistent-solver.js"
Cohesion: 0.40
Nodes (4): encode, prepared, reply(), write

### Community 95 - "Circular playback medallion"
Cohesion: 0.33
Nodes (6): Viewsical app artwork, Circular playback medallion, Concentric black, cream, and gold rims, Square mint-to-blue gradient background, Dark right-pointing playback triangle with lime edge, Coral-to-violet inner disk

### Community 96 - "Main Window Capabilities"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 97 - "Overlay Window Capabilities"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 98 - "Recovery"
Cohesion: 0.47
Nodes (4): Recovery, SourceRetry, Alternate, Refresh

### Community 99 - "Input"
Cohesion: 0.40
Nodes (5): Input, Inactive, Release, ResetFrame, Surface

### Community 100 - "Viewsical 0.1.7 release changes"
Cohesion: 0.50
Nodes (4): Retired Lua renderer upgrade cleanup, 0.1.7 verification record, Viewsical 0.1.7 release changes, Behavior-preserving YouTube adapter refactor

### Community 101 - "Output"
Cohesion: 0.50
Nodes (4): Output, Error, Frame, Ready

### Community 103 - "Seek Cat Sprite Sheet"
Cohesion: 0.67
Nodes (3): Open-Eye Cat Frame, Seek Cat Sprite Sheet, Winking Cat Frame

## Knowledge Gaps
- **107 isolated node(s):** `Remembered-session and shutdown checks`, `Scoped frameless window controls`, `Launch-tested portable release layout`, `Namida public orchestration reference`, `Native decoder and output evidence` (+102 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 710 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **31 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AppResult` connect `Player Commands and Presentation` to `Persistent Media Cache`, `Account Session Isolation`, `Download Job Lifecycle`, `Native Overlay and Geometry`, `video_surface.rs`, `Audio Readiness and Native Events`, `Comments and Data Models`, `Media Failure Recovery`, `process.rs`, `AppError`, `playback.rs`, `YouTube Adapter Regression`, `Native Playback Ownership`, `Local Persistent State`, `watch.rs`, `youtube/subtitles.rs`, `timeline.rs`, `pending.rs`, `Playback Source Lifecycle`, `media_item`, `Persistent Data Contracts`, `Stable YouTube Identity`, `player/subtitles.rs`, `YouTube Browse Metadata`, `local_playlists.rs`, `.resolve_source`, `local_playlists_survive_reopening_and_reimport_replaces_the_snapshot`, `.downloads`, `Local Watch History`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **Are the 117 inferred relationships involving `AppResult` (e.g. with `download_action()` and `.action()`) actually correct?**
  _`AppResult` has 117 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Remembered-session and shutdown checks`, `Scoped frameless window controls`, `Launch-tested portable release layout` to the rest of the system?**
  _107 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Persistent Media Cache` be split into smaller, more focused modules?**
  _Cohesion score 0.06558558558558558 - nodes in this community are weakly interconnected._
- **Why does `playwright` connect `Browser Interface Regression` to `verify-video-renderer.mjs`, `v017-browser-smoke.mjs`, `smoke.mjs`, `Release Package Verification`, `Frontend Dependencies`, `Cache Playback Integration`, `Desktop Window Integration`, `Account Session Verification`, `Native Scroll Regression`, `Native Controls Regression`, `Normalization App Regression`, `Live Media Regression`, `Application Lifecycle Regression`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Are the 6 inferred relationships involving `AppError` (e.g. with `download_error()` and `cancelled()`) actually correct?**
  _`AppError` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Should `Account Session Isolation` be split into smaller, more focused modules?**
  _Cohesion score 0.07256571640133284 - nodes in this community are weakly interconnected._

## Update audit

Viewsical 0.1.18 refreshed 98 changed files. 898 new nodes, 2441 new edges, 15 nodes removed, 174 edges removed. The final graph has zero missing or dangling endpoints.

Code extraction used no model calls. Documentation and image extraction used the host agents, whose token counts are unavailable. Zero token values indicate unmetered usage.
