use super::{
    ensure_generation, gateway::YoutubeGateway, identity::{valid_playlist_id, valid_video_id},
    valid_channel_id,
};
use crate::{
    downloads::ProcessJob,
    models::{AppError, AppResult},
    AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{process::Stdio, sync::atomic::Ordering, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ACTION_TIMEOUT: Duration = Duration::from_secs(20);
const RESPONSE_LIMIT: u64 = 256 * 1024;

fn cancelled() -> AppError {
    AppError::new("cancelled", "The account changed. Try again.")
}

impl YoutubeGateway {
    pub(super) async fn account_action(
        &self,
        app: &tauri::AppHandle,
        generation: u64,
        mut request: Value,
        sign_in_required: fn() -> AppError,
        unavailable: fn() -> AppError,
    ) -> AppResult<Value> {
        let _lock = self.account_operation.lock().await;
        let session = self.sessions.snapshot();
        ensure_generation(generation, session.generation)?;
        if session.status != "connected" {
            return Err(sign_in_required());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let guard = self.begin("youtube-account-action");
        let operation = async {
            let cookies = self
                .sessions
                .cookie_snapshot(app)
                .await?
                .ok_or_else(sign_in_required)?;
            ensure_generation(generation, cookies.generation)?;
            ensure_generation(generation, self.sessions.snapshot().generation)?;
            request["cookiePath"] = json!(cookies.path());
            let response = self.call_account_helper(app, &request, unavailable).await?;
            ensure_generation(generation, self.sessions.snapshot().generation)?;
            if response["error"].as_str() == Some("sign_in_required") {
                return Err(sign_in_required());
            }
            // A failed cookie refresh cannot reverse a confirmed YouTube action.
            let _ = self.sessions.accept_cookie_updates(app, &cookies).await;
            ensure_generation(generation, self.sessions.snapshot().generation)?;
            Ok(response)
        };
        tokio::select! {
            biased;
            _ = guard.token.cancelled() => Err(cancelled()),
            result = tokio::time::timeout(ACTION_TIMEOUT, operation) => {
                result.unwrap_or_else(|_| Err(unavailable()))
            }
        }
    }

    async fn call_account_helper(
        &self,
        app: &tauri::AppHandle,
        request: &Value,
        unavailable: fn() -> AppError,
    ) -> AppResult<Value> {
        let mut command = self.tools.youtube_python()?;
        command
            .arg(self.tools.youtube_plugins(app)?.join("account_actions.py"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| unavailable())?;
        let _job = ProcessJob::attach(&child)?;
        let mut input = child.stdin.take().ok_or_else(unavailable)?;
        input
            .write_all(&serde_json::to_vec(request).map_err(|_| unavailable())?)
            .await
            .map_err(|_| unavailable())?;
        drop(input);
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(unavailable)?
            .take(RESPONSE_LIMIT);
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| unavailable())?;
        if bytes.len() as u64 == RESPONSE_LIMIT
            || !child.wait().await.map_err(|_| unavailable())?.success()
        {
            return Err(unavailable());
        }
        serde_json::from_slice(&bytes).map_err(|_| unavailable())
    }

    async fn subscription(
        &self,
        app: &tauri::AppHandle,
        generation: u64,
        channel_id: String,
        subscribed: Option<bool>,
    ) -> AppResult<bool> {
        if !valid_channel_id(&channel_id) {
            return Err(AppError::new(
                "invalid_input",
                "Open a valid YouTube channel.",
            ));
        }
        let response = self
            .account_action(
                app,
                generation,
                json!({ "channelId": channel_id, "subscribed": subscribed }),
                subscription_sign_in,
                subscription_unavailable,
            )
            .await?;
        response["subscribed"]
            .as_bool()
            .filter(|result| subscribed.is_none_or(|expected| *result == expected))
            .ok_or_else(subscription_unavailable)
    }
}

fn subscription_sign_in() -> AppError {
    AppError::new(
        "sign_in_required",
        "Sign in to YouTube to manage channel subscriptions.",
    )
}

fn subscription_unavailable() -> AppError {
    AppError::new(
        "subscription_unavailable",
        "YouTube couldn't confirm this subscription. Try again.",
    )
}

#[tauri::command]
pub async fn channel_subscription(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel_id: String,
    generation: u64,
) -> AppResult<bool> {
    state
        .gateway
        .subscription(&app, generation, channel_id, None)
        .await
}

#[tauri::command]
pub async fn set_channel_subscription(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel_id: String,
    generation: u64,
    subscribed: bool,
) -> AppResult<bool> {
    state
        .gateway
        .subscription(&app, generation, channel_id, Some(subscribed))
        .await
}

fn playlist_save_unavailable() -> AppError {
    AppError::new("playlist_save_unavailable", "YouTube couldn't confirm the playlist request. Try again.")
}

fn playlist_sign_in() -> AppError {
    AppError::new("sign_in_required", "Sign in to YouTube to save to your YouTube playlists.")
}

#[derive(Deserialize, Serialize)]
pub struct YouTubePlaylistOption {
    id: String,
    title: String,
    saved: bool,
}

#[tauri::command]
pub async fn youtube_playlist_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    video_id: String,
    generation: u64,
    playlist_id: Option<String>,
) -> AppResult<Option<Vec<YouTubePlaylistOption>>> {
    if !valid_video_id(&video_id) || playlist_id.as_deref().is_some_and(|id| !valid_playlist_id(id)) {
        return Err(AppError::new("invalid_input", "Choose a valid YouTube video and playlist."));
    }
    let result = state.gateway.account_action(
        &app,
        generation,
        json!({ "videoId": video_id, "playlistId": playlist_id }),
        playlist_sign_in,
        playlist_save_unavailable,
    ).await?;
    if playlist_id.is_some() {
        return (result["saved"].as_bool() == Some(true))
            .then_some(None)
            .ok_or_else(playlist_save_unavailable);
    }
    let playlists = serde_json::from_value::<Vec<YouTubePlaylistOption>>(result["playlists"].clone())
        .map_err(|_| playlist_save_unavailable())?;
    Ok(Some(playlists))
}
