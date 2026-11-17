# TubeDesk 0.1.2 cache and player design

Namida's public app source informed the responsibilities here: use stable video identities, keep cached media separate from expiring extraction metadata, prefer a usable local source, cancel stale work, and guard updates by the currently selected video. No private youtipie implementation is used or copied.

References reviewed at public commit `17fed4f6bbc4acf2a91c7a1d138cc59274c0fea0`:

- [Audio cache controller](https://github.com/namidaco/namida/blob/17fed4f6bbc4acf2a91c7a1d138cc59274c0fea0/lib/controller/audio_cache_controller.dart): selects existing media files separately from stream metadata.
- [Audio handler](https://github.com/namidaco/namida/blob/17fed4f6bbc4acf2a91c7a1d138cc59274c0fea0/lib/base/audio_handler.dart): cached audio/video source selection and playback orchestration.
- [Storage cache manager](https://github.com/namidaco/namida/blob/17fed4f6bbc4acf2a91c7a1d138cc59274c0fea0/lib/controller/storage_cache_manager.dart): app-owned cache accounting and cleanup.
- [Current video information](https://github.com/namidaco/namida/blob/17fed4f6bbc4acf2a91c7a1d138cc59274c0fea0/lib/youtube/controller/youtube_current_info.dart): per-video comment cache, current-video checks, sort and continuation.

The supplied workflow.md was engineering reference material. Its proposed designs and inferred private protocol details do not override the user's requirements. The shared ChatGPT link could not be fetched during this update.

## TubeDesk media lifecycle

1. A play request gets a new load identity. Stale extraction, entry events and recovery attempts cannot commit to a newer selection.
2. Completed explicit downloads are checked, then internal complete cache components, then online extraction. An explicit quality choice can request a fresh online source rather than being trapped at an existing cached quality.
3. Native readiness requires the selected expected audio track, decoder parameters and active output in addition to the video restart event. Intentional mute/volume remain user choices. Separate audio is assigned as a typed source list before loading the main source; empty lists clear it without creating an empty filename. Selected HLS audio may omit its codec metadata until demuxing, which does not make it an absent source.
4. Network playback keeps mpv's in-memory prebuffer/read-ahead. Once ready, a single background FFmpeg job copies the resolved audio/video into separate internal components. This is a full-source background transfer, not Namida's private HTTP segment-cache implementation. It consumes extra bandwidth, can be disabled, and never blocks initial extraction on cache completion.
5. Components stay unpublished partial files until FFprobe confirms the expected track and full duration. Unknown duration, a transfer/size limit failure, missing audio, cancellation or validation failure cannot publish an offline entry. No transcoding is used.
6. Complete entries persist under the app-owned media-cache directory with a metadata index. Signed source URLs, request headers and cookies are absent from that index. Audio can be reused independently of its video component.
7. Playback leases pin exact files. Clearing them retires entries immediately and removes bytes after the native player closes the files. Limits evict older unpinned entries; working partial bytes count toward usage. Cancellation cleans partials and startup sweeps interrupted UUID component files.
8. Account-scoped media is invalidated on account generation changes; private cached metadata is scrubbed immediately. Guest media is separate. Normal app closure retains complete media and remembered sign-in.

## Read-only comments

The pinned yt-dlp adapter supplies top-level comments. Each request has a cancellation namespace, bounded output, and a cursor scoped to video ID, sort order and session generation. As the CLI does not expose persistent provider continuations, later pages re-extract a bounded prefix and locate the previous final comment ID. The UI deduplicates IDs when YouTube's ordering shifts. A removed anchor asks for refresh instead of silently skipping rows.

Pages contain 20 comments, with a 300-comment limit per video/sort. yt-dlp's extracted comment_count is not presented as the total number on YouTube. Comment text renders as text; no HTML is executed. Comment requests contain no posting/editing actions and do not intentionally report watch history.

## Limits

Internal cache is disposable and may evict media. It does not promise permanent offline availability; use Downloads for that. Caching an entire selected video can consume more data than the watched portion. Seeking does not make an incomplete cache file look complete. Live streams remain deferred. Network/provider restrictions can still make a source unavailable; recovery is bounded and a final failure stops the native source rather than leaving silent video running.
