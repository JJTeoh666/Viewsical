export interface MediaItem {
  id: string;
  kind: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  url: string;
  duration: number | null;
  viewCount: number | null;
  description: string | null;
  playlistIndex?: number | null;
  youtubeLoudnessDb?: number | null;
}

export interface CollectionSummary { id: string; title: string; owner: string; thumbnail: string | null; itemCount: number | null; description: string | null; isMix: boolean; url: string }
export interface BrowsePage { items: MediaItem[]; nextCursor: string | null; collection?: CollectionSummary | null }
export type PlaybackMode = 'video' | 'audio';
export interface SessionSnapshot {
  generation: number;
  status: string;
  label: string | null;
  message: string | null;
}
export interface AppSettings {
  theme: string;
  downloadDirectory: string;
  defaultQuality: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  alwaysAudioOnly: boolean;
  normalizeAudio: boolean;
}
export interface PlayerState {
  status: string;
  video: MediaItem | null;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  speed: number;
  quality: number;
  qualities: number[];
  error: string | null;
  loadId: number;
  playbackMode: PlaybackMode;
  requestedQuality: number;
  bufferedSeconds: number;
  errorCode: string | null;
}
export interface DownloadTask {
  id: string;
  video: MediaItem;
  mode: string;
  quality: number;
  format: string;
  destination: string;
  status: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  speed: string | null;
  eta: string | null;
  outputPath: string | null;
  error: string | null;
  createdAt: number;
  sessionGeneration: number;
}
export interface DownloadRequest {
  item: MediaItem;
  mode: string;
  quality: number;
  directory: string | null;
  format: string;
}
export interface HistoryItem { video: MediaItem; position: number; duration: number; updatedAt: number }
export interface ToolStatus { name: string; available: boolean; version: string | null }
export interface MediaCacheEntry { id: string; videoId: string; title: string; mode: string; quality: number; bytes: number; lastAccessed: number; pinned: boolean }
export interface MediaCacheSummary { enabled: boolean; maxBytes: number; totalBytes: number; audioBytes: number; videoBytes: number; pendingBytes: number; entryCount: number; activeCount: number; entries: MediaCacheEntry[] }
export type MediaCacheKind = 'all' | 'audio' | 'video';
export type CommentSort = 'top' | 'newest';
export interface VideoComment { id: string; author: string; authorThumbnail: string | null; text: string; likeCount: number | null; replyCount: number | null; published: string | null; authorIsUploader: boolean; isPinned: boolean }
export interface CommentPage { videoId: string; items: VideoComment[]; nextCursor: string | null; totalCount: number | null; disabled: boolean; sort: CommentSort; limited?: boolean }
export interface Bootstrap {
  session: SessionSnapshot;
  settings: AppSettings;
  downloads: DownloadTask[];
  history: HistoryItem[];
  tools: ToolStatus[];
}
export interface PlayerBounds { x: number; y: number; width: number; height: number; visible: boolean; radius?: number }
export interface PlayerUiContext { hasPrevious: boolean; hasNext: boolean; mini: boolean; theater: boolean; fullscreen: boolean }
export interface PlayerPresentation { revision: number; player: PlayerState; ui: PlayerUiContext; pausedIntent: boolean; overlayError: string | null }
export type PlayerOverlayAction = PlayerAction | 'mode' | 'next' | 'previous' | 'fullscreen' | 'theater' | 'focus-controls' | 'scroll';
export interface PlayerUiRequest { loadId: number; action: 'next' | 'previous' | 'fullscreen' | 'theater' | 'focus-controls' | 'scroll'; value?: number }
export type BrowseKind = 'home' | 'search' | 'subscriptions' | 'channels' | 'playlists' | 'playlist' | 'channel';
export type PlayerAction = 'pause' | 'resume' | 'toggle' | 'seek' | 'volume' | 'mute' | 'speed' | 'stop' | 'quality' | 'adjust-volume';
export type Page = { kind: BrowseKind | 'downloads' | 'history' | 'settings' | 'watch'; query?: string; title?: string; collection?: CollectionSummary };

export const defaultSettings: AppSettings = {
  theme: 'system', downloadDirectory: '', defaultQuality: 1080,
  volume: 80, muted: false, playbackRate: 1, alwaysAudioOnly: false, normalizeAudio: true,
};
export const defaultPlayer: PlayerState = {
  status: 'idle', video: null, position: 0, duration: 0, volume: 80,
  muted: false, speed: 1, quality: 1080, qualities: [], error: null, loadId: 0, playbackMode: 'video', requestedQuality: 1080, bufferedSeconds: 0, errorCode: null,
};
export const anonymousSession: SessionSnapshot = { generation: 0, status: 'anonymous', label: null, message: null };
