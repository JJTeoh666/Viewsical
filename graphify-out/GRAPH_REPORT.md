# Viewsical Codebase Graph Report - tubedesk  (2026-11-17)

## Corpus Check
- 76 files · ~54,395 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 32 file(s) not represented in the graph (top: .toml 25, .css 5, (none) 1)

## Summary
- 1059 nodes · 2585 edges · 46 communities (34 shown, 12 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 119 edges (avg confidence: 0.53)
- Token cost: AST 0 model tokens; host semantic token usage unavailable (see Token accounting).

## Community Hubs (Navigation)
- Native Playback Coordination
- Download Job Lifecycle
- YouTube Extraction Adapter
- Account Session Isolation
- Persistent Media Cache
- App State and Storage
- Read-only Comment Extraction
- Frontend Dependencies
- Browse and Queue UI
- Architecture and Evidence
- Browser Regression Fixtures
- UI Navigation Actions
- Desktop Bundle Configuration
- Frontend Contracts and Settings
- Native Video Controls
- Browse Metadata Cache
- Assets and Range Checks
- Comment Presentation and Sorting
- App TypeScript Options
- Cache Playback Integration Tests
- Desktop Window Integration Tests
- Media Protocol Diagnostics
- Lifecycle Regression Tests
- Persistent Player Layout
- Comment Request Cache
- Build TypeScript Options
- Release Package Verification
- Desktop Smoke Tests
- Account Session Verification
- Dependency License Collection
- Bundled Tool Setup
- Window Controls and IPC
- Main Window Capabilities
- Native IPC Diagnostics
- Viewsical Visual Identity
- Release Media Dependencies
- TypeScript Project References
- Rust Package Identity

## God Nodes (most connected - your core abstractions)
1. `AppResult` - 115 edges
2. `PlayerManager` - 65 edges
3. `Application()` - 44 edges
4. `AppState` - 39 edges
5. `SessionManager` - 30 edges
6. `MediaCache` - 25 edges
7. `Store` - 24 edges
8. `ToolPaths` - 22 edges
9. `YoutubeGateway` - 22 edges
10. `DownloadManager` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Session-generation invalidation` --semantically_similar_to--> `Session browse cache`  [INFERRED] [semantically similar]
  docs/CACHE_PLAYBACK.md → README.md
- `Pinned cache file leases` --shares_data_with--> `Embedded native playback`  [EXTRACTED]
  docs/CACHE_PLAYBACK.md → README.md
- `Current-load stale-work guard` --rationale_for--> `Embedded native playback`  [EXTRACTED]
  docs/CACHE_PLAYBACK.md → README.md
- `Background FFmpeg component copy` --implements--> `Persistent internal media cache`  [EXTRACTED]
  docs/CACHE_PLAYBACK.md → README.md
- `Disposable cache boundary` --rationale_for--> `Persistent internal media cache`  [EXTRACTED]
  docs/CACHE_PLAYBACK.md → README.md

## Import Cycles
- 2-file cycle: `src-tauri/src/downloads.rs -> src-tauri/src/lib.rs -> src-tauri/src/downloads.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/youtube.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 2-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/downloads.rs -> src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/downloads.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/youtube.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/youtube.rs -> src-tauri/src/lib.rs`
- 3-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/youtube.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 4-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/youtube.rs -> src-tauri/src/lib.rs`
- 4-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/youtube.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 4-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/youtube.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`
- 5-file cycle: `src-tauri/src/lib.rs -> src-tauri/src/player.rs -> src-tauri/src/media_cache.rs -> src-tauri/src/youtube.rs -> src-tauri/src/session.rs -> src-tauri/src/lib.rs`

## Hyperedges (group relationships)
- **Validated local playback lifecycle** — docs_cache_playback_local_first, docs_cache_playback_output_validation, docs_cache_playback_file_leases, readme_media_cache, readme_native_player [EXTRACTED 1.00]
- **Account-scoped state invalidation** — docs_cache_playback_session_generation, readme_media_cache, docs_cache_playback_comment_cursor, readme_browse_cache [INFERRED 0.95]

## Communities (46 total, 12 thin omitted)

### Community 0 - "Native Playback Coordination"
Cohesion: 0.06
Nodes (45): AppState, AppResult, audio_params_present(), audio_source_command(), AudioState, AudioTrack, classify_media_failure(), EntryTracker (+37 more)

### Community 1 - "Download Job Lifecycle"
Cohesion: 0.05
Nodes (22): download_action(), download_error(), DownloadManager, enqueue_download(), errors_do_not_expose_session_material(), format_selector(), hide_command(), identity_compatible() (+14 more)

### Community 2 - "YouTube Extraction Adapter"
Cohesion: 0.06
Nodes (36): VideoRef, Active, browse(), browse_target(), cancel_browse(), canonical_video(), cdn_url(), classifies_rejections_without_exposing_cookie_material() (+28 more)

### Community 3 - "Account Session Isolation"
Cohesion: 0.07
Nodes (33): allowed_cookie_domain(), allowed_navigation(), BLOCKED, complete_sign_in(), cookie_key(), cookie_line(), cookie_updates_reject_external_domains_and_preserve_expiry(), CookieKey (+25 more)

### Community 4 - "Persistent Media Cache"
Cohesion: 0.09
Nodes (25): cache_clear(), cache_configure(), cache_summary(), CachedPlayback, CacheEntry, CacheLease, CacheSummary, cancelled() (+17 more)

### Community 5 - "App State and Storage"
Cohesion: 0.06
Nodes (12): Bootstrap, bootstrap(), clear_history(), desktop_builder(), request_shutdown(), reveal_download(), run(), save_settings() (+4 more)

### Community 6 - "Read-only Comment Extraction"
Cohesion: 0.07
Nodes (36): bad_cursor(), bounded_text(), cancel_comments(), comment_from_json(), Cursor, cursors_are_bounded_and_scoped_to_video_sort_and_account_generation(), disabled_empty_and_missing_sections_are_distinct(), document() (+28 more)

### Community 7 - "Frontend Dependencies"
Cohesion: 0.06
Nodes (37): dependencies, @fontsource/roboto@^5.2.8, lucide-react@^0.577.0, react@^19.2.4, react-dom@^19.2.4, @tauri-apps/api@^2.10.1, @tauri-apps/plugin-dialog@^2.6.0, devDependencies (+29 more)

### Community 8 - "Browse and Queue UI"
Cohesion: 0.13
Nodes (31): lucide-react, react, isDesktop, accountPages, activeDownloads, browseContent(), openSignIn(), browseKinds (+23 more)

### Community 9 - "Architecture and Evidence"
Cohesion: 0.07
Nodes (20): Background FFmpeg component copy, Namida public orchestration reference, Selected HLS audio metadata fix, Remembered-session and shutdown checks, Native decoder and output evidence, Scoped frameless window controls, TubeDesk versioned verification evidence, Viewsical HTML application shell (+12 more)

### Community 10 - "Browser Regression Fixtures"
Cohesion: 0.09
Nodes (18): vite@^7.3.1, playwright, vite, output, results, root, output, results (+10 more)

### Community 11 - "UI Navigation Actions"
Cohesion: 0.11
Nodes (23): Application(), closePlayer(), completeSignIn(), playDownloaded(), startPlaylist(), bytes(), errorMessage(), progressPercent() (+15 more)

### Community 12 - "Desktop Bundle Configuration"
Cohesion: 0.06
Nodes (32): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+24 more)

### Community 13 - "Frontend Contracts and Settings"
Cohesion: 0.14
Nodes (22): api, active, cacheLimits, cacheUsage(), GiB, anonymousSession, AppSettings, Bootstrap (+14 more)

### Community 14 - "Native Video Controls"
Cohesion: 0.20
Nodes (22): activate(), add_hit(), append(), button(), circle(), clamp(), drag_value(), draw_menu() (+14 more)

### Community 15 - "Browse Metadata Cache"
Cohesion: 0.16
Nodes (8): BrowseCache, browseKey(), Fetcher, mergeBrowseItems(), RecordEntry, uniqueItems(), BrowseKind, BrowsePage

### Community 16 - "Assets and Range Checks"
Cohesion: 0.13
Nodes (3): check_resume(), main(), run()

### Community 17 - "Comment Presentation and Sorting"
Cohesion: 0.17
Nodes (14): COMMENT_LIMIT, CommentEntry, commentKey(), Fetcher, RecordEntry, CommentRow(), CommentSortMenu(), close() (+6 more)

### Community 18 - "App TypeScript Options"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+11 more)

### Community 19 - "Cache Playback Integration Tests"
Cohesion: 0.15
Nodes (15): children, close(), data, delay(), engine(), ipc(), launch(), out (+7 more)

### Community 20 - "Desktop Window Integration Tests"
Cohesion: 0.15
Nodes (15): children, close(), data, delay(), engine(), ipc(), launch(), out (+7 more)

### Community 21 - "Media Protocol Diagnostics"
Cohesion: 0.12
Nodes (11): child, executable, root, audio, child, dir, ffmpeg, root (+3 more)

### Community 22 - "Lifecycle Regression Tests"
Cohesion: 0.17
Nodes (13): children, closeMain(), data, delay(), launch(), out, ownedIds(), processRows() (+5 more)

### Community 23 - "Persistent Player Layout"
Cohesion: 0.24
Nodes (12): time(), PlayerHost(), renderControls(), update(), PlayerSettings(), close(), keys(), Props (+4 more)

### Community 25 - "Build TypeScript Options"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, lib, module, moduleDetection, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 26 - "Release Package Verification"
Cohesion: 0.25
Nodes (7): app, delay(), env, executable, results, root, until()

### Community 27 - "Desktop Smoke Tests"
Cohesion: 0.25
Nodes (7): children, delay(), out, results, root, run, until()

### Community 28 - "Account Session Verification"
Cohesion: 0.39
Nodes (7): close(), delay(), invoke(), launch(), results, root, until()

### Community 29 - "Dependency License Collection"
Cohesion: 0.29
Nodes (6): collect(), index, out, pkg, root, seen

### Community 30 - "Bundled Tool Setup"
Cohesion: 0.52
Nodes (6): CopyNotice(), CopyVerified(), Fetch(), FetchNotice(), Matches(), Verify()

### Community 31 - "Window Controls and IPC"
Cohesion: 0.40
Nodes (5): @tauri-apps/api, vitest, video, WindowControls(), run()

### Community 32 - "Main Window Capabilities"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 34 - "Viewsical Visual Identity"
Cohesion: 0.40
Nodes (5): Viewsical app artwork, Hand-drawn broken red ring, Layered cream brush strokes, Red outlined play symbol, Rounded square icon silhouette

### Community 35 - "Release Media Dependencies"
Cohesion: 0.67
Nodes (3): Launch-tested portable release layout, Pinned local media helpers, Installer and portable delivery

## Knowledge Gaps
- **23 isolated node(s):** `tubedesk`, `Rejected`, `Network`, `Decoder`, `Unavailable` (+18 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 337 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AppResult` connect `Native Playback Coordination` to `Download Job Lifecycle`, `YouTube Extraction Adapter`, `Account Session Isolation`, `Persistent Media Cache`, `App State and Storage`, `Read-only Comment Extraction`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Are the 101 inferred relationships involving `AppResult` (e.g. with `download_action()` and `.action()`) actually correct?**
  _`AppResult` has 101 INFERRED edges - model-reasoned connections that need verification._
- **What connects `tubedesk`, `Rejected`, `Network` to the rest of the system?**
  _23 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Native Playback Coordination` be split into smaller, more focused modules?**
  _Cohesion score 0.05798898071625344 - nodes in this community are weakly interconnected._
- **Why does `playwright` connect `Browser Regression Fixtures` to `Frontend Dependencies`, `Cache Playback Integration Tests`, `Desktop Window Integration Tests`, `Media Protocol Diagnostics`, `Lifecycle Regression Tests`, `Release Package Verification`, `Desktop Smoke Tests`, `Account Session Verification`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Should `Download Job Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.054945054945054944 - nodes in this community are weakly interconnected._
- **Why does `PlayerManager` connect `Native Playback Coordination` to `Download Job Lifecycle`, `Persistent Media Cache`, `App State and Storage`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
## Graph health warning

The installed extractor reports 144 unresolved/dangling endpoint edges, one self-loop and two exact duplicate edges in the raw extraction. The default undirected graph combines 101 same-endpoint relationships. It reports zero missing endpoint fields and 69 external-reference edges. Generated external placeholder nodes explain why the exported graph has more nodes than the raw extraction. Use source locations to verify a relationship before relying on it. Full diagnostic: HEALTH.md and health.json.

Twelve code/config files yielded no symbols; they remain file-level nodes. The parser does not establish every runtime, IPC, or data dependency.

## Token accounting

Structural AST extraction requires zero model tokens. Semantic extraction used two host agents without a provider API key. The collaboration API does not expose actual token counts, so semantic counts and costs are unavailable. Generated zero counters are placeholders, not a claim that semantic extraction was free. cost.json records usage_available=false.
