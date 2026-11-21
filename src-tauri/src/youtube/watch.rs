//! Watch details and the connected account's rating for one video.
use super::{channel::safe_image, ensure_generation, gateway::YoutubeGateway, identity::valid_video_id, metadata::video_channel_id};
use crate::{
    models::{AppError, AppResult},
    runtime::now,
    AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::atomic::Ordering};

const DETAILS_TTL: u64 = 10 * 60;
const MAX_DETAILS: usize = 64;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchDetails {
    description: Option<String>,
    upload_date: Option<String>,
    view_count: Option<u64>,
    like_count: Option<u64>,
    channel_id: Option<String>,
    channel_name: Option<String>,
    channel_avatar: Option<String>,
    subscriber_count: Option<u64>,
    rating: Option<VideoRating>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VideoRating {
    Like,
    Dislike,
    None,
}

struct CachedDetails {
    video_id: String,
    generation: u64,
    expiry: u64,
    details: WatchDetails,
}

#[derive(Default)]
pub(super) struct WatchCache(VecDeque<CachedDetails>);

impl WatchCache {
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }

    fn get(&self, video_id: &str, generation: u64, timestamp: u64) -> Option<WatchDetails> {
        self.0
            .iter()
            .find(|entry| {
                entry.video_id == video_id
                    && entry.generation == generation
                    && entry.expiry > timestamp
            })
            .map(|entry| entry.details.clone())
    }
}

fn upload_date(value: &str) -> Option<String> {
    if value.len() != 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year = value[..4].parse().ok()?;
    let month = time::Month::try_from(value[4..6].parse::<u8>().ok()?).ok()?;
    let day = value[6..].parse().ok()?;
    (year > 0)
        .then(|| time::Date::from_calendar_date(year, month, day))?
        .ok()
        .map(|date| date.to_string())
}

impl WatchDetails {
    fn from_json(value: &Value) -> Self {
        Self {
            description: value["description"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .map(|text| text.chars().take(20_000).collect()),
            upload_date: value["upload_date"].as_str().and_then(upload_date),
            view_count: value["view_count"].as_u64(),
            like_count: value["like_count"].as_u64(),
            channel_id: video_channel_id(value).map(str::to_owned),
            channel_name: ["channel", "uploader"].iter()
                .filter_map(|key| value.get(key)?.as_str())
                .map(str::trim)
                .find(|name| !name.is_empty())
                .map(|name| name.chars().take(256).collect()),
            channel_avatar: value["viewsical_channel_avatar"].as_str().and_then(safe_image),
            subscriber_count: value["channel_follower_count"].as_u64(),
            rating: None,
        }
    }
}

fn validate_video(video_id: &str) -> AppResult<()> {
    valid_video_id(video_id)
        .then_some(())
        .ok_or_else(|| AppError::new("invalid_video", "Open a YouTube video first."))
}

fn sign_in_required() -> AppError {
    AppError::new("sign_in_required", "Sign in to YouTube to rate this video.")
}

fn rating_unavailable() -> AppError {
    AppError::new(
        "rating_unavailable",
        "YouTube couldn't confirm this video rating. Try again.",
    )
}

fn cancelled() -> AppError {
    AppError::new("cancelled", "The account changed. Try again.")
}

impl YoutubeGateway {
    pub(super) fn cache_watch_details(&self, video_id: &str, generation: u64, value: &Value) {
        if value["id"].as_str() != Some(video_id) {
            return;
        }
        let mut cache = self.watch_details.lock().unwrap_or_else(|p| p.into_inner());
        if self.closing.load(Ordering::SeqCst) || self.sessions.snapshot().generation != generation
        {
            return;
        }
        let timestamp = now();
        let mut details = WatchDetails::from_json(value);
        if let Some(previous) = cache.get(video_id, generation, timestamp) {
            details.description = details.description.or(previous.description);
            details.upload_date = details.upload_date.or(previous.upload_date);
            details.like_count = details.like_count.or(previous.like_count);
            details.view_count = details.view_count.or(previous.view_count);
            details.channel_id = details.channel_id.or(previous.channel_id);
            details.channel_name = details.channel_name.or(previous.channel_name);
            details.channel_avatar = details.channel_avatar.or(previous.channel_avatar);
            details.subscriber_count = details.subscriber_count.or(previous.subscriber_count);
        }
        cache.0.retain(|entry| {
            entry.generation == generation && entry.video_id != video_id && entry.expiry > timestamp
        });
        cache.0.push_back(CachedDetails {
            video_id: video_id.into(),
            generation,
            expiry: timestamp + DETAILS_TTL,
            details,
        });
        if cache.0.len() > MAX_DETAILS {
            cache.0.pop_front();
        }
    }

    async fn lookup_watch_details(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        generation: u64,
        request_id: &str,
    ) -> AppResult<WatchDetails> {
        let cached = || {
            self.watch_details
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(video_id, generation, now())
        };
        if let Some(details) = cached() {
            return Ok(details);
        }
        let _lock = self.watch_metadata_lookup.lock().await;
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if let Some(details) = cached() {
            return Ok(details);
        }
        self.fetch_watch_metadata(app, video_id, generation, request_id).await?;
        cached().ok_or_else(cancelled)
    }

    async fn change_or_read_rating(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        generation: u64,
        rating: Option<VideoRating>,
    ) -> AppResult<VideoRating> {
        let response = self
            .account_action(
                app,
                generation,
                json!({ "videoId": video_id, "rating": rating }),
                sign_in_required,
                rating_unavailable,
            )
            .await?;
        serde_json::from_value(response["rating"].clone()).map_err(|_| rating_unavailable())
    }
}

#[tauri::command]
pub async fn watch_details(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    video_id: String,
    generation: u64,
) -> AppResult<WatchDetails> {
    validate_video(&video_id)?;
    let session = state.sessions.snapshot();
    ensure_generation(generation, session.generation)?;
    let gateway = &state.gateway;
    let metadata = gateway.lookup_watch_details(&app, &video_id, generation, "playback-watch-metadata");
    let rating = async {
        if session.status == "connected" {
            gateway
                .change_or_read_rating(&app, &video_id, generation, None)
                .await
                .ok()
        } else {
            None
        }
    };
    let (details, rating) = tokio::join!(metadata, rating);
    ensure_generation(generation, state.sessions.snapshot().generation)?;
    let mut details = match (details, rating) {
        (Ok(details), _) => details,
        (Err(_), Some(_)) => WatchDetails::default(),
        (Err(error), None) => return Err(error),
    };
    details.rating = rating;
    Ok(details)
}

#[tauri::command]
pub async fn video_channel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    video_id: String,
    generation: u64,
) -> AppResult<String> {
    validate_video(&video_id)?;
    ensure_generation(generation, state.sessions.snapshot().generation)?;
    let details = state.gateway.lookup_watch_details(&app, &video_id, generation, "recommendation-channel").await?;
    ensure_generation(generation, state.sessions.snapshot().generation)?;
    details.channel_id.ok_or_else(|| AppError::new("channel_unavailable", "This video's channel is unavailable."))
}

#[tauri::command]
pub async fn rate_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    video_id: String,
    generation: u64,
    rating: VideoRating,
) -> AppResult<()> {
    validate_video(&video_id)?;
    let confirmed = state
        .gateway
        .change_or_read_rating(&app, &video_id, generation, Some(rating))
        .await?;
    if confirmed != rating {
        return Err(rating_unavailable());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_details_validate_calendar_dates_and_do_not_infer_counts() {
        let details = WatchDetails::from_json(&json!({
            "upload_date": "20240229",
            "view_count": 1234567,
            "description": "Description\nNext line",
            "dislike_count": 200,
            "channel_id": "UC1234567890123456789012",
            "channel": "Fixture channel",
            "channel_follower_count": 42000,
            "viewsical_channel_avatar": "https://yt3.ggpht.com/fixture",
        }));
        assert_eq!(
            details.description.as_deref(),
            Some("Description\nNext line")
        );
        assert_eq!(details.upload_date.as_deref(), Some("2024-02-29"));
        assert_eq!(details.view_count, Some(1234567));
        assert_eq!(details.like_count, None);
        assert_eq!(details.rating, None);
        assert_eq!(details.channel_id.as_deref(), Some("UC1234567890123456789012"));
        assert_eq!(details.channel_name.as_deref(), Some("Fixture channel"));
        assert_eq!(details.subscriber_count, Some(42000));
        assert!(details.channel_avatar.is_some());
        let invalid = WatchDetails::from_json(&json!({ "channel_id": "invalid", "viewsical_channel_avatar": "https://example.com/avatar" }));
        assert!(invalid.channel_id.is_none() && invalid.channel_avatar.is_none() && invalid.subscriber_count.is_none());
        assert_eq!(upload_date("20230229"), None);
        assert_eq!(upload_date("2024-02-29"), None);
    }
}
