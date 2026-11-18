//! Replaceable protocol boundary. Only normalized metadata escapes this module;
//! resolved CDN URLs remain in Rust and are never persisted as video identity.
//!
//! The gateway owns request/session state; focused sibling modules implement
//! provider execution, browsing, playback resolution, identity, and metadata.
mod browse;
mod errors;
mod gateway;
mod identity;
mod metadata;
mod playback;
mod process;

pub use errors::classify_error;
pub use gateway::YoutubeGateway;
pub use identity::{canonical_video, ensure_generation, normalize_video_ref};
pub use metadata::media_item;
pub(crate) use metadata::replay_heatmap;
pub use playback::PlaybackPlan;

use crate::{
    models::{AppResult, BrowsePage},
    AppState,
};

#[tauri::command]
pub async fn browse(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    kind: String,
    query: String,
    cursor: Option<String>,
    request_id: String,
) -> AppResult<BrowsePage> {
    state
        .gateway
        .browse_page(&app, &kind, &query, cursor.as_deref(), &request_id)
        .await
}
#[tauri::command]
pub fn cancel_browse(state: tauri::State<'_, AppState>, request_id: String) {
    state.gateway.cancel(&request_id);
}

#[cfg(test)]
mod tests;
