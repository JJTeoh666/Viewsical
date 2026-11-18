use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn io(e: impl std::fmt::Display) -> Self {
        Self::new("io", e.to_string())
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}
pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoRef {
    pub video_id: String,
    pub playlist_id: Option<String>,
    pub start_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub channel: String,
    pub thumbnail: Option<String>,
    pub url: String,
    pub duration: Option<f64>,
    pub view_count: Option<u64>,
    pub description: Option<String>,
    #[serde(default)]
    pub playlist_index: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub youtube_loudness_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heatmap: Option<Vec<ReplayHeatSegment>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayHeatSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub value: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: String,
    pub title: String,
    pub owner: String,
    pub thumbnail: Option<String>,
    pub item_count: Option<u64>,
    pub description: Option<String>,
    pub is_mix: bool,
    pub url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePage {
    pub items: Vec<MediaItem>,
    pub next_cursor: Option<String>,
    pub collection: Option<CollectionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub generation: u64,
    pub status: String,
    pub label: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub download_directory: String,
    pub default_quality: u32,
    pub volume: f64,
    pub muted: bool,
    pub playback_rate: f64,
    #[serde(default)]
    pub always_audio_only: bool,
    #[serde(default = "crate::normalization::enabled_by_default")]
    pub normalize_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub status: String,
    pub video: Option<MediaItem>,
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
    pub speed: f64,
    pub quality: u32,
    pub qualities: Vec<u32>,
    pub error: Option<String>,
    pub load_id: u64,
    pub playback_mode: String,
    pub requested_quality: u32,
    pub buffered_seconds: f64,
    pub error_code: Option<String>,
}
impl Default for PlayerState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            video: None,
            position: 0.,
            duration: 0.,
            volume: 80.,
            muted: false,
            speed: 1.,
            quality: 1080,
            qualities: vec![],
            error: None,
            load_id: 0,
            playback_mode: "video".into(),
            requested_quality: 1080,
            buffered_seconds: 0.,
            error_code: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub video: MediaItem,
    pub mode: String,
    pub quality: u32,
    pub format: String,
    pub destination: String,
    pub status: String,
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub session_generation: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub item: MediaItem,
    pub mode: String,
    pub quality: u32,
    pub directory: Option<String>,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub viewport_top: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerUiContext {
    pub has_previous: bool,
    pub has_next: bool,
    pub mini: bool,
    pub theater: bool,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPresentation {
    pub revision: u64,
    pub player: PlayerState,
    pub ui: PlayerUiContext,
    pub paused_intent: bool,
    pub overlay_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub video: MediaItem,
    pub duration: f64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
}
