import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { VideoRating, WatchDetails, YouTubePlaylistOption } from './types';
import type { AppSettings, Bootstrap, BrowseKind, BrowsePage, CommentPage, CommentSort, DownloadRequest, DownloadTask, MediaCacheKind, MediaCacheSummary, MediaItem, PlaybackMode, PlayerAction, PlayerBounds, PlayerState, PlayerUiContext, PlayerPresentation, PlayerOverlayAction, SessionSnapshot, SubtitleTrack, VideoRendererMode } from './types';

export const isDesktop = '__TAURI_INTERNALS__' in window;

type QueuePrefetch = {
  queueId: string;
  selectedEntryId: string;
  nextEntryId: string;
  videoId: string;
  quality: number;
  mode: PlaybackMode;
};

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) return Promise.reject(new Error('Open the Viewsical desktop app to use this feature.'));
  return invoke<T>(command, args);
}

export const api = {
  bootstrap: () => call<Bootstrap>('bootstrap'),
  localPlaylists: () => call<import('./types').CollectionSummary[]>('local_playlists'),
  localPlaylist: (id: string) => call<BrowsePage>('local_playlist', { id }),
  importLocalPlaylist: (link: string) => call<import('./types').CollectionSummary>('import_local_playlist', { link }),
  removeLocalPlaylist: (id: string) => call<void>('remove_local_playlist', { id }),
  saveLocalPlaylistVideo: (item: MediaItem, playlistId: string | null, title: string | null) =>
    call<void>('save_local_playlist_video', { item, playlistId, title }),
  youtubePlaylistOptions: (videoId: string, generation: number) =>
    call<YouTubePlaylistOption[]>('youtube_playlist_save', { videoId, generation, playlistId: null }),
  saveYouTubePlaylistVideo: (videoId: string, generation: number, playlistId: string) =>
    call<void>('youtube_playlist_save', { videoId, generation, playlistId }),
  browse: (kind: BrowseKind, query: string, cursor: string | null, requestId: string) => call<BrowsePage>('browse', { kind, query, cursor, requestId }),
  cancelBrowse: (requestId: string) => call<void>('cancel_browse', { requestId }),
  openSignIn: () => call<void>('open_sign_in'),
  completeSignIn: () => call<SessionSnapshot>('complete_sign_in'),
  session: () => call<SessionSnapshot>('session_state'),
  watchDetails: (videoId: string, generation: number) => call<WatchDetails>('watch_details', { videoId, generation }),
  videoChannel: (videoId: string, generation: number) => call<string>('video_channel', { videoId, generation }),
  rateVideo: (videoId: string, generation: number, rating: VideoRating) => call<void>('rate_video', { videoId, generation, rating }),
  channelSubscription: (channelId: string, generation: number, videoId?: string) =>
    call<boolean>('channel_subscription', { channelId, generation, videoId }),
  setChannelSubscription: (channelId: string, generation: number, subscribed: boolean, videoId?: string) =>
    call<boolean>('set_channel_subscription', { channelId, generation, subscribed, videoId }),
  signOut: () => call<void>('sign_out'),
  playVideo: (item: MediaItem, quality: number, playbackMode?: PlaybackMode) => call<void>('play_video', { item, quality, playbackMode: playbackMode ?? null }),
  setPlaybackMode: (mode: PlaybackMode) => call<void>('set_playback_mode', { mode }),
  playerUiContext: (context: PlayerUiContext) => call<void>('player_ui_context', { context }),
  playerQueuePrefetch: (loadId: number, next: QueuePrefetch | null) => call<void>('player_queue_prefetch', { loadId, next }),
  playLocal: (taskId: string) => call<void>('play_local', { taskId }),
  playerAction: (action: PlayerAction, value?: number) => call<void>('player_action', { action, value: value ?? null }),
  playerBounds: (bounds: PlayerBounds) => call<void>('player_bounds', {
    bounds,
    // The time origin keeps the ordering monotonic across document reloads.
    frame: Math.floor((performance.timeOrigin + performance.now()) * 1000),
  }),
  player: () => call<PlayerState>('player_state'),
  subtitleTracks: (loadId: number) => call<SubtitleTrack[]>('player_subtitle_tracks', { loadId }),
  setSubtitle: (loadId: number, trackId: string | null) => call<void>('set_player_subtitle', { loadId, trackId }),
  videoRendererMode: () => call<VideoRendererMode>('video_renderer_mode'),
  videoSurfaceConfigure: (width: number, height: number) => call<void>('video_surface_configure', { width, height }),
  videoSurfaceRelease: (generation: number, sequence: number) => call<void>('video_surface_release', { generation, sequence }),
  videoSurfaceFailed: (generation: number) => call<void>('video_surface_failed', { generation }),
  playerPresentation: () => call<PlayerPresentation>('player_overlay_snapshot'),
  overlayAction: (loadId: number, action: PlayerOverlayAction, value?: number, mode?: PlaybackMode) => call<void>('player_overlay_action', { loadId, action, value: value ?? null, mode: mode ?? null }),
  retryPlayerOverlay: () => call<void>('retry_player_overlay'),
  enqueueDownload: (request: DownloadRequest) => call<DownloadTask>('enqueue_download', { request }),
  downloadAction: (taskId: string, action: 'pause' | 'resume' | 'cancel') => call<void>('download_action', { taskId, action }),
  saveSettings: (settings: AppSettings) => call<AppSettings>('save_settings', { settings }),
  clearHistory: () => call<void>('clear_history'),
  cacheSummary: () => call<MediaCacheSummary>('cache_summary'),
  cacheConfigure: (enabled: boolean, maxBytes: number) => call<MediaCacheSummary>('cache_configure', { enabled, maxBytes }),
  cacheClear: (kind: MediaCacheKind, entryId?: string) => call<MediaCacheSummary>('cache_clear', { kind, entryId: entryId ?? null }),
  comments: (videoId: string, cursor: string | null, sort: CommentSort, requestId: string) => call<CommentPage>('video_comments', { videoId, cursor, sort, requestId }),
  commentReplies: (videoId: string, parentId: string, cursor: string | null, sort: CommentSort, requestId: string) =>
    call<CommentPage>('video_comments', { videoId, parentId, cursor, sort, requestId }),
  cancelComments: (requestId: string) => call<void>('cancel_comments', { requestId }),
  translateComment: (generation: number, text: string) => call<string>('translate_comment', { generation, text }),
  revealDownload: (taskId: string) => call<void>('reveal_download', { taskId }),
  selectDirectory: async (): Promise<string | null> => {
    if (!isDesktop) throw new Error('Choose a folder from the Viewsical desktop app.');
    const result = await open({ directory: true, multiple: false, title: 'Choose download folder' });
    return typeof result === 'string' ? result : null;
  },
  on: <T,>(event: string, callback: (value: T) => void) => isDesktop
    ? listen<T>(event, ({ payload }) => callback(payload))
    : Promise.resolve(() => {}),
};
