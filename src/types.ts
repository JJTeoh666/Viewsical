export interface ReplayHeatmapInterval {
  startTime: number;
  endTime: number;
  value: number;
}

export interface VideoChapter {
  startTime: number;
  endTime: number;
  title: string;
}

export interface Storyboard {
  urlTemplate: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  frameCount: number;
  frameDuration: number;
}

export interface MediaItem {
  id: string;
  kind: string;
  title: string;
  channel: string;
  channelId?: string | null;
  thumbnail: string | null;
  url: string;
  duration: number | null;
  viewCount: number | null;
  description: string | null;
  playlistIndex?: number | null;
  youtubeLoudnessDb?: number | null;
  heatmap?: ReplayHeatmapInterval[];
  chapters?: VideoChapter[];
}

export interface CollectionSummary { id: string; title: string; owner: string; thumbnail: string | null; itemCount: number | null; description: string | null; isMix: boolean; url: string }
export type VideoRating = 'like' | 'dislike' | 'none';
export interface WatchDetails {
  description: string | null;
  uploadDate: string | null;
  viewCount: number | null;
  likeCount: number | null;
  rating: VideoRating | null;
  channelId?: string | null;
  channelName?: string | null;
  channelAvatar?: string | null;
  subscriberCount?: number | null;
}
export interface YouTubePlaylistOption { id: string; title: string; saved: boolean }
export interface ChannelSummary {
  id: string;
  title: string;
  handle?: string | null;
  avatar?: string | null;
  banner?: string | null;
  description?: string | null;
  subscriberCount?: number | null;
  videoCount?: number | null;
  isVerified?: boolean | null;
}
export interface BrowsePage { items: MediaItem[]; nextCursor: string | null; collection?: CollectionSummary | null; channel?: ChannelSummary | null }
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
  rememberPlaybackMode: boolean;
  normalizeAudio: boolean;
  closeToTray: boolean;
}
export interface SubtitleTrack {
  id: string;
  label: string;
  language: string;
  automatic: boolean;
}

export interface PlayerState {
  status: string;
  video: MediaItem | null;
  storyboard?: Storyboard;
  subtitleTrackId?: string | null;
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
  preferredPlaybackMode?: PlaybackMode;
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
export interface HistoryItem { video: MediaItem; duration: number; updatedAt: number }
export interface ToolStatus { name: string; available: boolean; version: string | null }
export interface MediaCacheEntry { id: string; videoId: string; title: string; mode: string; quality: number; bytes: number; lastAccessed: number; pinned: boolean }
export type MediaCacheContent = 'both' | 'audio' | 'video';
export interface MediaCacheSummary { enabled: boolean; content: MediaCacheContent; maxBytes: number; totalBytes: number; audioBytes: number; videoBytes: number; pendingBytes: number; entryCount: number; activeCount: number; entries: MediaCacheEntry[] }
export type MediaCacheKind = 'all' | 'audio' | 'video';
export type CommentSort = 'top' | 'newest';
export interface VideoComment { id: string; author: string; authorChannelId?: string | null; authorThumbnail: string | null; text: string; likeCount: number | null; replyCount: number | null; hasReplies?: boolean; published: string | null; authorIsUploader: boolean; isPinned: boolean }
export interface CommentPage { videoId: string; parentId?: string | null; items: VideoComment[]; nextCursor: string | null; totalCount: number | null; disabled: boolean; sort: CommentSort; limited?: boolean }
export interface Bootstrap {
  session: SessionSnapshot;
  settings: AppSettings;
  downloads: DownloadTask[];
  history: HistoryItem[];
  tools: ToolStatus[];
}
export interface PlayerBounds { x: number; y: number; width: number; height: number; visible: boolean; radius?: number; viewportTop?: number }
export type VideoRendererMode = 'canvas' | 'native';
export interface PlayerUiContext { hasPrevious: boolean; hasNext: boolean; mini: boolean; theater: boolean; fullscreen: boolean }
export interface PlayerPresentation { revision: number; player: PlayerState; ui: PlayerUiContext; pausedIntent: boolean; overlayError: string | null }
type PlayerUiAction = 'next' | 'previous' | 'fullscreen' | 'theater' | 'minimize' | 'focus-controls' | 'scroll';
export type PlayerOverlayAction = PlayerAction | 'mode' | PlayerUiAction;
export interface PlayerUiRequest { loadId: number; action: PlayerUiAction; value?: number }
export type ChannelTab = 'home' | 'videos' | 'live' | 'playlists';
export type BrowseKind = 'home' | 'search' | 'subscriptions' | 'channels' | 'playlists' | 'playlist' | 'channel' | 'channel-home' | 'channel-live' | 'channel-playlists';
export type PlayerAction = 'pause' | 'resume' | 'toggle' | 'seek' | 'volume' | 'mute' | 'speed' | 'stop' | 'quality' | 'adjust-volume';
export type Page = { kind: BrowseKind | 'downloads' | 'history' | 'settings' | 'watch' | 'localPlaylists' | 'localPlaylist'; query?: string; title?: string; collection?: CollectionSummary; channelTab?: ChannelTab; channelThumbnail?: string | null };

export const defaultSettings: AppSettings = {
  theme: 'system', downloadDirectory: '', defaultQuality: 1080,
  volume: 80, muted: false, playbackRate: 1, alwaysAudioOnly: false, rememberPlaybackMode: false, normalizeAudio: true, closeToTray: false,
};
export const defaultPlayer: PlayerState = {
  status: 'idle', video: null, position: 0, duration: 0, volume: 80,
  muted: false, speed: 1, quality: 1080, qualities: [], error: null, loadId: 0, playbackMode: 'video', requestedQuality: 1080, bufferedSeconds: 0, errorCode: null,
};
export const anonymousSession: SessionSnapshot = { generation: 0, status: 'anonymous', label: null, message: null };
