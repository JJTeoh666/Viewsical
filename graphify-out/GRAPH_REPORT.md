# Graph Report - tubedesk  (2026-11-18)

## Corpus Check
- 115 files · ~69,809 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 33 file(s) not represented in the graph (top: .toml 25, .css 5, (none) 1)

## Summary
- 1389 nodes · 3289 edges · 75 communities (59 shown, 16 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 161 edges (avg confidence: 0.67)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `83f64b59`
- This graph includes the prepared release changes. Check manifest.json content hashes; the baseline commit alone is not a freshness check.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Browse Metadata Cache
- Comment Request Cache
- Queue and Browse Interface
- Frontend Data Contracts
- Adapter and Range Checks
- Read Only Comment Interface
- Keyboard and Viewport Rules
- Shared Playback Controls
- Reusable Interface Components
- Media Protocol Diagnostics
- Native Controls Regression
- Cache Playback Integration
- Desktop Window Integration
- Native Scroll Regression
- Normalization and IPC Diagnostics
- Application Navigation Actions
- Normalization App Regression
- Live Media Regression
- Application Lifecycle Regression
- Browser Interface Regression
- Historical Lua Visual Tests
- Release Package Verification
- Account Session Verification
- Dependency License Collection
- Account Session Isolation
- Native Overlay and Geometry
- Player Commands and Presentation
- Comments and Data Models
- Media Failure Recovery
- Local Persistent State
- Playback Source Lifecycle
- Provider Execution and Errors
- Native Playback Ownership
- Media Tool Discovery
- Scoped Overlay Actions
- Persistent Media Cache
- Persistent Data Contracts
- Application Startup and Shutdown
- YouTube Request Lifecycle
- Stable YouTube Identity
- Remembered Window State
- Download Job Lifecycle
- Playback Source Selection
- Bootstrap Data Presentation
- Audio Readiness and Native Events
- Windows Bundle Configuration
- YouTube Adapter Regression
- YouTube Browse Metadata
- Application TypeScript Options
- Build TypeScript Options
- Bundled Media Tool Setup
- Main Window Capabilities
- Overlay Window Capabilities
- YouTube Command Boundary
- TypeScript Project References
- Rust Package Identity
- Frontend Dependencies
- Application Architecture and Release
- Offline Media Orchestration
- Loudness Normalization Policy
- Shared Controls Architecture
- Historical Architecture Notes
- Scrolling and Navigation Behavior
- Viewsical Visual Identity
- Cached Browsing and Comments
- HTML Desktop Entrypoint

## God Nodes (most connected - your core abstractions)
1. `AppResult` - 131 edges
2. `PlayerManager` - 69 edges
3. `Application()` - 46 edges
4. `AppState` - 44 edges
5. `SessionManager` - 30 edges
6. `Viewsical 0.1.7` - 28 edges
7. `Store` - 26 edges
8. `MediaCache` - 25 edges
9. `ToolPaths` - 23 edges
10. `IconButton()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `Watch scrolling and Back to top` --semantically_similar_to--> `Scrolling and navigation in Viewsical 0.1.7`  [INFERRED] [semantically similar]
  README.md → docs/SCROLL_NAVIGATION.md
- `Five-point volume keyboard shortcuts` --semantically_similar_to--> `Serialized five-point volume actions`  [INFERRED] [semantically similar]
  README.md → docs/SHARED_PLAYER.md
- `Remembered main-window maximization` --semantically_similar_to--> `Independent main-window maximization state`  [INFERRED] [semantically similar]
  README.md → docs/AUDIO_NORMALIZATION.md
- `Session-generation invalidation` --semantically_similar_to--> `In-memory browsing pages`  [INFERRED] [semantically similar]
  docs/CACHE_PLAYBACK.md → README.md
- `Viewsical 0.1.7` --conceptually_related_to--> `Scrolling and navigation in Viewsical 0.1.7`  [INFERRED]
  README.md → docs/SCROLL_NAVIGATION.md

## Import Cycles
- 2-file cycle: `src-tauri/src/youtube/gateway.rs -> src-tauri/src/youtube/playback.rs -> src-tauri/src/youtube/gateway.rs`
- 2-file cycle: `src-tauri/src/downloads.rs -> src-tauri/src/lib.rs -> src-tauri/src/downloads.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/downloads.rs -> src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/downloads.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/youtube/gateway.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/lib.rs`
- 5-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/youtube/playback.rs -> src-tauri/src/youtube/gateway.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 5-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/youtube/playback.rs -> src-tauri/src/youtube/gateway.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`

## Hyperedges (group relationships)
- **Validated local playback lifecycle** — docs_cache_playback_local_first, docs_cache_playback_output_validation, docs_cache_playback_file_leases, readme_media_cache, readme_native_player [EXTRACTED 1.00]
- **Account-scoped state invalidation** — docs_cache_playback_session_generation, readme_media_cache, docs_cache_playback_comment_cursor, readme_browse_cache [INFERRED 0.95]

## Communities (75 total, 16 thin omitted)

### Community 16 - "Browse Metadata Cache"
Cohesion: 0.14
Nodes (11): BrowseCache, BrowseEntry, Fetcher, RecordEntry, QueueSource, BrowseKind, BrowsePage, CollectionSummary (+3 more)

### Community 11 - "Queue and Browse Interface"
Cohesion: 0.14
Nodes (21): QueueEntry, QueueState, Props, MediaItem, BackToTop(), appendQueuePage(), boundMix(), needsQueuePage() (+13 more)

### Community 17 - "Frontend Data Contracts"
Cohesion: 0.14
Nodes (18): Bootstrap, DownloadRequest, HistoryItem, MediaCacheEntry, MediaCacheKind, MediaCacheSummary, Page, PlayerBounds (+10 more)

### Community 2 - "Adapter and Range Checks"
Cohesion: 0.06
Nodes (8): _ViewsicalYoutubeIE, LoudnessPluginTests, _YoutubeIE, _loudness_for_video(), check_resume(), main(), run(), response()

### Community 27 - "Read Only Comment Interface"
Cohesion: 0.17
Nodes (14): CommentEntry, Fetcher, RecordEntry, CommentPage, CommentSort, VideoComment, commentKey(), CommentRow() (+6 more)

### Community 47 - "Keyboard and Viewport Rules"
Cohesion: 0.24
Nodes (7): ShortcutContext, ShortcutIntent, ShortcutKey, playerShortcut(), normal, rect, vitest

### Community 8 - "Shared Playback Controls"
Cohesion: 0.13
Nodes (27): ControlsProps, SettingsProps, Props, PlaybackMode, PlayerAction, PlayerOverlayAction, PlayerPresentation, PlayerState (+19 more)

### Community 9 - "Reusable Interface Components"
Cohesion: 0.16
Nodes (29): AppSettings, DownloadTask, browseContent(), completeSignIn(), openSignIn(), bytes(), errorMessage(), progressPercent() (+21 more)

### Community 14 - "Media Protocol Diagnostics"
Cohesion: 0.09
Nodes (18): delay(), until(), child, executable, root, audio, child, dir (+10 more)

### Community 23 - "Native Controls Regression"
Cohesion: 0.14
Nodes (16): verify(), delay(), invoke(), ipc(), native(), playing(), until(), webviewMemory() (+8 more)

### Community 30 - "Cache Playback Integration"
Cohesion: 0.15
Nodes (15): close(), delay(), engine(), ipc(), launch(), playing(), until(), children (+7 more)

### Community 31 - "Desktop Window Integration"
Cohesion: 0.15
Nodes (15): close(), delay(), engine(), ipc(), launch(), playing(), until(), children (+7 more)

### Community 33 - "Native Scroll Regression"
Cohesion: 0.16
Nodes (14): delay(), invoke(), ipc(), native(), playing(), until(), webviewMemory(), children (+6 more)

### Community 34 - "Normalization and IPC Diagnostics"
Cohesion: 0.12
Nodes (11): render(), client, replies, checks, child, dir, ffmpeg, mpv (+3 more)

### Community 35 - "Application Navigation Actions"
Cohesion: 0.15
Nodes (8): Application(), closePlayer(), playDownloaded(), startPlaylist(), emptyQueue(), WindowControls(), run(), @tauri-apps/api

### Community 36 - "Normalization App Regression"
Cohesion: 0.17
Nodes (14): close(), delay(), ipc(), launch(), native(), playing(), until(), children (+6 more)

### Community 37 - "Live Media Regression"
Cohesion: 0.17
Nodes (14): close(), delay(), ipc(), launch(), native(), playing(), until(), children (+6 more)

### Community 39 - "Application Lifecycle Regression"
Cohesion: 0.17
Nodes (13): closeMain(), delay(), launch(), ownedIds(), processRows(), until(), children, data (+5 more)

### Community 4 - "Browser Interface Regression"
Cohesion: 0.06
Nodes (31): check(), scaledOverlayChecks(), check(), scaledOverlayChecks(), vite@^7.3.1, output, results, root (+23 more)

### Community 43 - "Historical Lua Visual Tests"
Cohesion: 0.14
Nodes (10): capture, child, dir, harness, output, pipe, replies, results (+2 more)

### Community 49 - "Release Package Verification"
Cohesion: 0.25
Nodes (7): delay(), until(), app, env, executable, results, root

### Community 52 - "Account Session Verification"
Cohesion: 0.39
Nodes (7): close(), delay(), invoke(), launch(), until(), results, root

### Community 54 - "Dependency License Collection"
Cohesion: 0.29
Nodes (6): collect(), index, out, pkg, root, seen

### Community 0 - "Account Session Isolation"
Cohesion: 0.07
Nodes (34): AppPaths, CookieKey, CookieSnapshot, RememberedCookie, RememberedCookies, SessionManager, allowed_cookie_domain(), allowed_navigation() (+26 more)

### Community 1 - "Native Overlay and Geometry"
Cohesion: 0.07
Nodes (40): Desired, Failure, Geometry, Inner, OverlayManager, ClipRect, gain_db(), valid_loudness() (+32 more)

### Community 12 - "Player Commands and Presentation"
Cohesion: 0.16
Nodes (20): AppState, AppResult, bootstrap(), clear_history(), reveal_download(), save_settings(), ensure_control_load(), ensure_control_window() (+12 more)

### Community 13 - "Comments and Data Models"
Cohesion: 0.16
Nodes (23): Cursor, VideoComment, VideoCommentsPage, bad_cursor(), bounded_text(), cancel_comments(), comment_from_json(), cursors_are_bounded_and_scoped_to_video_sort_and_account_generation() (+15 more)

### Community 18 - "Media Failure Recovery"
Cohesion: 0.17
Nodes (10): MediaFailure, classify_media_failure(), AudioMissing, Decoder, Network, Premature, Rejected, Unavailable (+2 more)

### Community 19 - "Local Persistent State"
Cohesion: 0.15
Nodes (3): Store, history_and_settings_survive_reopening(), maximized_state_survives_reopening_and_stale_settings_saves()

### Community 20 - "Playback Source Lifecycle"
Cohesion: 0.27
Nodes (3): LoadOptions, options_quality(), valid_start()

### Community 21 - "Provider Execution and Errors"
Cohesion: 0.11
Nodes (8): AppError, cancelled(), is_auth_rejection(), classify_error(), MAX_JSON, terminate(), YoutubeGateway, classifies_rejections_without_exposing_cookie_material()

### Community 25 - "Native Playback Ownership"
Cohesion: 0.13
Nodes (7): CacheLease, LocalSource, PlayerManager, Recovery, PipeWriter, player_bounds(), premature_eof()

### Community 28 - "Scoped Overlay Actions"
Cohesion: 0.10
Nodes (17): OverlayAction, AdjustVolume, FocusControls, Fullscreen, Mode, Mute, Next, Pause (+9 more)

### Community 3 - "Persistent Media Cache"
Cohesion: 0.10
Nodes (20): CacheEntry, CacheSummary, Index, Inner, MediaCache, PartialFiles, Record, cache_clear() (+12 more)

### Community 32 - "Persistent Data Contracts"
Cohesion: 0.18
Nodes (13): AppSettings, BrowsePage, CollectionSummary, DownloadRequest, DownloadTask, HistoryItem, MediaItem, PlayerBounds (+5 more)

### Community 40 - "Application Startup and Shutdown"
Cohesion: 0.18
Nodes (5): ShutdownSignals, desktop_builder(), request_shutdown(), run(), simultaneous_close_routes_start_exactly_one_cleanup()

### Community 42 - "YouTube Request Lifecycle"
Cohesion: 0.22
Nodes (3): Active, RequestGuard, YoutubeGateway

### Community 46 - "Stable YouTube Identity"
Cohesion: 0.36
Nodes (9): VideoRef, browse_target(), normalize_video_ref(), parse_timestamp(), playlist_target(), safe_youtube_url(), valid_playlist_id(), valid_video_id() (+1 more)

### Community 48 - "Remembered Window State"
Cohesion: 0.40
Nodes (5): MainWindowState, remember(), remember_resize(), restore(), temporary_window_states_do_not_replace_the_normal_choice()

### Community 5 - "Download Job Lifecycle"
Cohesion: 0.10
Nodes (21): DownloadManager, ProcessJob, RunningDownload, download_action(), download_error(), enqueue_download(), errors_do_not_expose_session_material(), format_selector() (+13 more)

### Community 50 - "Playback Source Selection"
Cohesion: 0.44
Nodes (4): CachedPlayback, PlaybackPlan, source_fresh(), YoutubeGateway

### Community 6 - "Audio Readiness and Native Events"
Cohesion: 0.08
Nodes (15): AudioState, AudioTrack, EntryTracker, SourceToken, audio_params_present(), audio_source_command(), fresh_play_commands_use_latest_saved_preferences(), intended_external_audio_wins_over_a_selected_internal_track() (+7 more)

### Community 10 - "Windows Bundle Configuration"
Cohesion: 0.06
Nodes (33): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+25 more)

### Community 15 - "YouTube Adapter Regression"
Cohesion: 0.15
Nodes (13): canonical_video(), media_item(), text(), cdn_url(), playback_from_json(), safe_headers(), source_expiry(), source_selector() (+5 more)

### Community 24 - "YouTube Browse Metadata"
Cohesion: 0.15
Nodes (6): collection_summary(), decode_cursor(), encode_cursor(), PAGE_SIZE, YoutubeGateway, page_cursor_is_bound_to_query_and_session()

### Community 29 - "Application TypeScript Options"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+11 more)

### Community 45 - "Build TypeScript Options"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, lib, module, moduleDetection, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 55 - "Bundled Media Tool Setup"
Cohesion: 0.52
Nodes (6): CopyNotice(), CopyVerified(), Fetch(), FetchNotice(), Matches(), Verify()

### Community 56 - "Main Window Capabilities"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 57 - "Overlay Window Capabilities"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 7 - "Frontend Dependencies"
Cohesion: 0.06
Nodes (37): dependencies, @fontsource/roboto@^5.2.8, lucide-react@^0.577.0, react@^19.2.4, react-dom@^19.2.4, @tauri-apps/api@^2.10.1, @tauri-apps/plugin-dialog@^2.6.0, devDependencies (+29 more)

### Community 22 - "Application Architecture and Release"
Cohesion: 0.15
Nodes (14): Viewsical 0.1.7 release changes, Persistent audio-only default, Dedicated remembered Google sign-in, Installer and portable delivery, Watch scrolling and Back to top, Retired Lua renderer upgrade cleanup, TubeDesk former product name, Viewsical 0.1.7 (+6 more)

### Community 38 - "Offline Media Orchestration"
Cohesion: 0.17
Nodes (8): Validated persistent media cache, Embedded native playback, Persistent resumable downloads, Background FFmpeg component copy, Namida public orchestration reference, Selected HLS audio metadata fix, Native decoder and output evidence, TubeDesk versioned verification evidence

### Community 41 - "Loudness Normalization Policy"
Cohesion: 0.16
Nodes (8): Audio normalization policy and historical 0.1.5 player changes, Historical 0.1.5 ASS/Lua controls, mpv volume-gain, Viewsical yt-dlp loudness plugin, MediaItem.youtubeLoudnessDb metadata, Five-point volume keyboard shortcuts, mpv volume-gain technical reference, yt-dlp plugin mechanism reference

### Community 51 - "Shared Controls Architecture"
Cohesion: 0.43
Nodes (4): Shared React playback controls in Viewsical 0.1.6, PlayerOverlay.tsx controls-only presentation, PlayerControls.tsx shared playback controls, Reusable transparent controls WebView host

### Community 53 - "Historical Architecture Notes"
Cohesion: 0.43
Nodes (5): Historical Viewsical 0.1.5 Electron assessment, Historical PlayerManager coordination reference, Historical PlaybackPlan reference, Historical 0.1.5 playback coordination query, Historical tubedesk_osc.lua renderer reference

### Community 60 - "Scrolling and Navigation Behavior"
Cohesion: 0.60
Nodes (4): Native clipping and navigation verification, Search submit and Back to top controls, 0.1.7 verification record, Scrolling and navigation in Viewsical 0.1.7

### Community 61 - "Viewsical Visual Identity"
Cohesion: 0.40
Nodes (5): Hand-drawn broken red ring, Layered cream brush strokes, Red outlined play symbol, Rounded square icon silhouette, Viewsical app artwork

### Community 63 - "HTML Desktop Entrypoint"
Cohesion: 0.67
Nodes (3): Tauri Rust React stack, React main entrypoint reference, Viewsical HTML application shell

## Knowledge Gaps
- **44 isolated node(s):** `Closed`, `Creation`, `Renderer`, `StartupTimeout`, `AudioMissing` (+39 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 448 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `playwright` connect `Browser Interface Regression` to `Native Scroll Regression`, `Normalization App Regression`, `Live Media Regression`, `Frontend Dependencies`, `Application Lifecycle Regression`, `Media Protocol Diagnostics`, `Release Package Verification`, `Account Session Verification`, `Native Controls Regression`, `Cache Playback Integration`, `Desktop Window Integration`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **Are the 95 inferred relationships involving `AppResult` (e.g. with `download_action()` and `.action()`) actually correct?**
  _`AppResult` has 95 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Closed`, `Creation`, `Renderer` to the rest of the system?**
  _44 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Browse Metadata Cache` be split into smaller, more focused modules?**
  _Cohesion score 0.13846153846153847 - nodes in this community are weakly interconnected._
- **Why does `AppResult` connect `Player Commands and Presentation` to `Persistent Data Contracts`, `Native Overlay and Geometry`, `Account Session Isolation`, `Persistent Media Cache`, `Local Watch History`, `Download Job Lifecycle`, `Comments and Data Models`, `Stable YouTube Identity`, `YouTube Adapter Regression`, `Playback Source Selection`, `Media Failure Recovery`, `Playback Source Lifecycle`, `Provider Execution and Errors`, `Local Persistent State`, `YouTube Browse Metadata`, `Native Playback Ownership`, `Media Tool Discovery`, `YouTube Command Boundary`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Should `Queue and Browse Interface` be split into smaller, more focused modules?**
  _Cohesion score 0.14112903225806453 - nodes in this community are weakly interconnected._
- **Why does `AppState` connect `Player Commands and Presentation` to `Account Session Isolation`, `Native Overlay and Geometry`, `Persistent Media Cache`, `Download Job Lifecycle`, `Audio Readiness and Native Events`, `Application Startup and Shutdown`, `YouTube Request Lifecycle`, `Comments and Data Models`, `Remembered Window State`, `Local Persistent State`, `Native Playback Ownership`, `Media Tool Discovery`, `YouTube Command Boundary`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._

## Release Audit

Viewsical 0.1.7 includes a 45-line YouTube facade with focused Rust modules. All 51 moved function bodies retain identical syntax tokens. Verification: 61 Rust tests, 26 frontend unit tests and 10 isolated live checks including real YouTube video/audio playback, normalization, cache replay and completed audio download.

README and CHANGELOG were fully read for semantic extraction. All 18 prior README concept IDs were preserved. 12 new nodes, 31 new edges. No missing or dangling endpoints remain. The two recursive-call self loops are intentional.

Host semantic-agent token usage is unavailable; zero counters are placeholders. AST code extraction uses no LLM/API calls. `graphify-out/` is tracked in the working tree; extraction caches and host-specific interpreter/root state are excluded from Git.
