import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppSettings, Bootstrap, BrowseKind, BrowsePage, CommentPage, CommentSort, DownloadRequest, DownloadTask, MediaCacheKind, MediaCacheSummary, MediaItem, PlaybackMode, PlayerAction, PlayerBounds, PlayerState, PlayerUiContext, PlayerPresentation, PlayerOverlayAction, SessionSnapshot, VideoRendererMode } from './types';

export const isDesktop = '__TAURI_INTERNALS__' in window;

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) return Promise.reject(new Error('Open the Viewsical desktop app to use this feature.'));
  return invoke<T>(command, args);
}

export const api = {
  bootstrap: () => call<Bootstrap>('bootstrap'),
  browse: (kind: BrowseKind, query: string, cursor: string | null, requestId: string) => call<BrowsePage>('browse', { kind, query, cursor, requestId }),
  cancelBrowse: (requestId: string) => call<void>('cancel_browse', { requestId }),
  openSignIn: () => call<void>('open_sign_in'),
  completeSignIn: () => call<SessionSnapshot>('complete_sign_in'),
  session: () => call<SessionSnapshot>('session_state'),
  signOut: () => call<void>('sign_out'),
  playVideo: (item: MediaItem, quality: number, playbackMode?: PlaybackMode) => call<void>('play_video', { item, quality, playbackMode: playbackMode ?? null }),
  setPlaybackMode: (mode: PlaybackMode) => call<void>('set_playback_mode', { mode }),
  playerUiContext: (context: PlayerUiContext) => call<void>('player_ui_context', { context }),
  playLocal: (taskId: string) => call<void>('play_local', { taskId }),
  playerAction: (action: PlayerAction, value?: number) => call<void>('player_action', { action, value: value ?? null }),
  playerBounds: (bounds: PlayerBounds) => call<void>('player_bounds', {
    bounds,
    // The time origin keeps the ordering monotonic across document reloads.
    frame: Math.floor((performance.timeOrigin + performance.now()) * 1000),
  }),
  player: () => call<PlayerState>('player_state'),
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
  cancelComments: (requestId: string) => call<void>('cancel_comments', { requestId }),
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
