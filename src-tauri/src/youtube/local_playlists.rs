use super::{
    browse::collection_summary, ensure_generation, gateway::YoutubeGateway,
    identity::{valid_playlist_id, valid_video_id}, media_item,
};
use crate::{
    models::{AppError, AppResult, BrowsePage, CollectionSummary, MediaItem},
    AppState,
};
use serde_json::Value;

pub(crate) const MAX_PLAYLIST_ITEMS: usize = 5_000;

#[tauri::command]
pub fn save_local_playlist_video(
    state: tauri::State<'_, AppState>,
    item: MediaItem,
    playlist_id: Option<String>,
    title: Option<String>,
) -> AppResult<()> {
    if item.kind != "video" || !valid_video_id(&item.id) {
        return Err(AppError::new("invalid_video", "Choose a YouTube video to save."));
    }
    let mut item = item;
    item.url = super::canonical_video(&item.id);
    if let Some(id) = playlist_id {
        return state.store.append_local_playlist_video(&id, item);
    }
    let title = title.as_deref().unwrap_or("").trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(AppError::new("invalid_playlist_title", "Enter a playlist name of up to 120 characters."));
    }
    let summary = CollectionSummary {
        id: format!("local:{}", uuid::Uuid::new_v4()),
        title: title.into(),
        owner: String::new(),
        thumbnail: item.thumbnail.clone(),
        item_count: Some(1),
        description: None,
        is_mix: false,
        url: String::new(),
    };
    item.playlist_index = Some(1);
    state.store.save_local_playlist(&summary, &[item])
}

#[tauri::command]
pub fn local_playlists(state: tauri::State<'_, AppState>) -> AppResult<Vec<CollectionSummary>> {
    state.store.local_playlists()
}

#[tauri::command]
pub fn local_playlist(state: tauri::State<'_, AppState>, id: String) -> AppResult<BrowsePage> {
    state.store.local_playlist(&id)
}

#[tauri::command]
pub fn remove_local_playlist(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.remove_local_playlist(&id)
}

#[tauri::command]
pub async fn import_local_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    link: String,
) -> AppResult<CollectionSummary> {
    // Resolve the list without the account's cookies since it will remain available after sign-out.
    let (id, target) = import_target(&link)?;
    let generation = state.sessions.snapshot().generation;
    let (summary, items) = state
        .gateway
        .extract_local_playlist(&app, &id, &target, generation)
        .await?;
    ensure_generation(generation, state.sessions.snapshot().generation)?;
    state.store.save_local_playlist(&summary, &items)?;
    Ok(summary)
}

impl YoutubeGateway {
    async fn extract_local_playlist(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        target: &str,
        generation: u64,
    ) -> AppResult<(CollectionSummary, Vec<MediaItem>)> {
        let request = self.begin(&uuid::Uuid::new_v4().to_string());
        let result = self
            .run(
                app,
                target,
                vec![
                    "--flat-playlist".into(),
                    "--compat-options".into(),
                    "no-youtube-unavailable-videos".into(),
                    "--playlist-end".into(),
                    (MAX_PLAYLIST_ITEMS + 1).to_string(),
                ],
                None,
                generation,
                request.token.clone(),
            )
            .await?;
        imported_playlist(&result, id, target)
    }
}

fn import_target(link: &str) -> AppResult<(String, String)> {
    let invalid = || AppError::new("invalid_playlist_link", "Paste a YouTube playlist link.");
    let link = link.trim();
    let parsed = url::Url::parse(link).map_err(|_| invalid())?;
    if link.len() > 2048
        || !matches!(parsed.scheme(), "https" | "http")
        || !matches!(
            parsed.host_str(),
            Some(
                "youtube.com"
                    | "www.youtube.com"
                    | "m.youtube.com"
                    | "music.youtube.com"
                    | "youtu.be"
            )
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(invalid());
    }
    let (_, id) = parsed
        .query_pairs()
        .find(|(key, _)| key == "list")
        .ok_or_else(invalid)?;
    if !valid_playlist_id(&id) {
        return Err(invalid());
    }
    if id.starts_with("RD") {
        return Err(AppError::new(
            "mix_playlist",
            "Choose a saved playlist link. YouTube Mixes change over time.",
        ));
    }
    Ok((
        id.to_string(),
        format!("https://www.youtube.com/playlist?list={id}"),
    ))
}

fn imported_playlist(
    json: &Value,
    id: &str,
    target: &str,
) -> AppResult<(CollectionSummary, Vec<MediaItem>)> {
    let unavailable = || {
        AppError::new(
            "playlist_unavailable",
            "No playable videos were found in this playlist.",
        )
    };
    let entries = json
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(unavailable)?;
    if entries.len() > MAX_PLAYLIST_ITEMS
        || json
            .get("playlist_count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > MAX_PLAYLIST_ITEMS as u64)
    {
        return Err(AppError::new(
            "playlist_too_large",
            "Choose a playlist with 5,000 videos or fewer.",
        ));
    }
    let items: Vec<_> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let mut item = media_item(entry)?;
            if item.kind != "video"
                || matches!(
                    entry.get("availability").and_then(Value::as_str),
                    Some("private")
                )
            {
                return None;
            }
            item.playlist_index = Some(item.playlist_index.unwrap_or(index as u64 + 1));
            Some(item)
        })
        .collect();
    if items.is_empty() {
        return Err(unavailable());
    }
    let mut summary = collection_summary(json, target, &items);
    summary.id = id.to_string();
    summary.item_count = Some(items.len() as u64);
    summary.is_mix = false;
    if summary.title.is_empty() {
        summary.title = "YouTube playlist".into();
    }
    Ok((summary, items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_links_and_discards_watch_and_tracking_context() {
        let expected = (
            "PLtest".into(),
            "https://www.youtube.com/playlist?list=PLtest".into(),
        );
        for link in [
            "https://www.youtube.com/playlist?list=PLtest&si=abc",
            "https://music.youtube.com/playlist?list=PLtest",
            "https://youtu.be/dQw4w9WgXcQ?list=PLtest&t=1",
        ] {
            assert_eq!(import_target(link).unwrap(), expected);
        }
        for link in [
            "https://not-youtube.com/playlist?list=PLtest",
            "https://x@www.youtube.com/playlist?list=PLtest",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/playlist?list=RDtest",
        ] {
            assert!(import_target(link).is_err(), "{link}");
        }
    }

    #[test]
    fn preserves_order_and_duplicates_and_skips_private_entries() {
        let video = json!({"id":"dQw4w9WgXcQ","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","title":"A video"});
        let result = json!({"title":"Playlist","entries":[video.clone(), null,
            {"id":"jNQXAC9IVRw","title":"Private video","availability":"private"}, video]});
        let (summary, items) = imported_playlist(
            &result,
            "PLtest",
            "https://www.youtube.com/playlist?list=PLtest",
        )
        .unwrap();
        assert_eq!(summary.item_count, Some(2));
        assert_eq!(items[0].id, items[1].id);
        assert_eq!(items[0].playlist_index, Some(1));
        assert_eq!(items[1].playlist_index, Some(4));
    }
}
