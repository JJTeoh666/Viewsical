//! Read-only library/comment extraction, pagination, and account validation.
use super::{
    canonical_video, channel, ensure_generation,
    gateway::YoutubeGateway,
    identity::{playlist_target, safe_youtube_url, valid_playlist_id, valid_video_id},
    media_item,
    metadata::text,
    normalize_video_ref,
};
use crate::{
    models::{AppError, AppResult, BrowsePage, CollectionSummary, MediaItem},
    session::CookieSnapshot,
};
use serde_json::Value;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

const PAGE_SIZE: usize = 24;

impl YoutubeGateway {
    pub async fn validate_session(
        &self,
        app: &tauri::AppHandle,
        cookies: &CookieSnapshot,
    ) -> AppResult<()> {
        let request = self.begin(&format!("validate:{}", uuid::Uuid::new_v4()));
        // :ytsubs enforces yt-dlp's authenticated-feed check. An empty but valid
        // feed is a connected account; mere presence of a cookie is not enough.
        self.run(
            app,
            ":ytsubs",
            vec![
                "--flat-playlist".into(),
                "--playlist-end".into(),
                "1".into(),
            ],
            Some(cookies),
            cookies.generation,
            request.token.clone(),
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn comments_document(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        sort: &str,
        limit: usize,
        parent_id: Option<&str>,
        request_id: &str,
    ) -> AppResult<Value> {
        if !valid_video_id(video_id)
            || !matches!(sort, "top" | "newest")
            || !(1..=301).contains(&limit)
        {
            return Err(AppError::new(
                "invalid_input",
                "Choose a valid video and comment order.",
            ));
        }
        let generation = self.sessions.snapshot().generation;
        let request = self.begin(&format!("comments:{request_id}"));
        let order = if sort == "newest" { "new" } else { "top" };
        let comment_args = match parent_id {
            Some(parent) => format!("viewsical_reply_parent={parent};max_comments={total},300,{limit},{limit},2", total = 300 + limit),
            None => format!("max_comments={limit},{limit},0,0,1"),
        };
        let args = vec!["--write-comments".into(), "--ignore-no-formats-error".into(), "--no-playlist".into(),
            "--extractor-args".into(), format!("youtube:skip=hls,dash;player_skip=js;comment_sort={order};{comment_args}")];
        let target = canonical_video(video_id);
        let anonymous = self
            .run(
                app,
                &target,
                args.clone(),
                None,
                generation,
                request.token.clone(),
            )
            .await;
        let json = match anonymous {
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "sign_in_required" | "private_video" | "age_restricted" | "youtube_challenge"
                ) && self.sessions.snapshot().status == "connected" =>
            {
                let cookies = self.sessions.cookie_snapshot(app).await?;
                self.run(
                    app,
                    &target,
                    args,
                    cookies.as_ref(),
                    generation,
                    request.token.clone(),
                )
                .await?
            }
            result => result?,
        };
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if request.token.is_cancelled() {
            return Err(AppError::new(
                "cancelled",
                "The comments request was cancelled.",
            ));
        }
        Ok(json)
    }

    pub async fn browse_page(
        &self,
        app: &tauri::AppHandle,
        kind: &str,
        query: &str,
        cursor: Option<&str>,
        request_id: &str,
    ) -> AppResult<BrowsePage> {
        if request_id.len() > 128 || request_id.is_empty() {
            return Err(AppError::new(
                "invalid_input",
                "The browse request is invalid. Please retry.",
            ));
        }
        let generation = self.sessions.snapshot().generation;
        let account_required = matches!(kind, "subscriptions" | "channels" | "playlists");
        if account_required && self.sessions.snapshot().status != "connected" {
            return Err(AppError::new(
                "sign_in_required",
                "Sign in to YouTube in the app to view this library.",
            ));
        }
        let offset = decode_cursor(cursor, kind, query, generation)?;
        let target = browse_target(kind, query, offset + PAGE_SIZE + 1)?;
        let channel_tab = channel::tab_name(kind);
        let mut extra = vec![
            "--flat-playlist".into(),
            "--playlist-items".into(),
            format!("{}:{}", offset + 1, offset + PAGE_SIZE + 1),
        ];
        if kind == "search" && normalize_video_ref(query).is_ok() && !target.contains("list=") {
            extra.push("--no-playlist".into());
        }
        if channel_tab.is_some() {
            extra.extend(["--extractor-args".into(), "youtubetab:viewsical_profile=1".into()]);
        }
        let request = self.begin(request_id);
        let public = kind == "search" || channel_tab.is_some();
        let cookies = if public {
            None
        } else {
            self.sessions.cookie_snapshot(app).await?
        };
        let result = self
            .run(
                app,
                &target,
                extra.clone(),
                cookies.as_ref(),
                generation,
                request.token.clone(),
            )
            .await;
        let result = match result {
            Err(error)
                if public
                    && self.sessions.snapshot().status == "connected"
                    && matches!(
                        error.code.as_str(),
                        "sign_in_required"
                            | "private_video"
                            | "age_restricted"
                            | "youtube_challenge"
                    ) =>
            {
                let cookies = self.sessions.cookie_snapshot(app).await?;
                self.run(
                    app,
                    &target,
                    extra,
                    cookies.as_ref(),
                    generation,
                    request.token.clone(),
                )
                .await
            }
            result => result,
        };
        let json = match result {
            Err(error) if channel_tab.is_some() && error.code == "channel_tab_missing" => Value::Null,
            Err(error) if target.contains("list=RD")
                && matches!(error.code.as_str(), "extraction_failed" | "unsupported_library") => {
                return Err(AppError::new("mix_context", "This Mix needs its original watch link. Paste a YouTube link containing both v= and list= to open it."));
            }
            result => result?,
        };
        let entries = json.get("entries").and_then(Value::as_array);
        let has_more = entries.is_some_and(|e| e.len() > PAGE_SIZE)
            || (kind == "playlist"
                && json
                    .get("playlist_count")
                    .and_then(Value::as_u64)
                    .is_some_and(|total| total > (offset + PAGE_SIZE) as u64));
        let mut items: Vec<MediaItem> = if let Some(entries) = entries {
            entries
                .iter()
                .take(PAGE_SIZE)
                .enumerate()
                .filter_map(|(index, value)| {
                    let mut item = media_item(value)?;
                    if !includes_item(kind, &item) {
                        return None;
                    }
                    if kind == "playlist" {
                        item.playlist_index =
                            Some(item.playlist_index.unwrap_or((offset + index + 1) as u64));
                    }
                    Some(item)
                })
                .collect()
        } else {
            media_item(&json).into_iter().filter(|item| includes_item(kind, item)).collect()
        };
        items.truncate(PAGE_SIZE);
        let collection = if !json.is_null() && (kind == "playlist" || channel_tab.is_some()) {
            Some(collection_summary(&json, &target, &items))
        } else {
            None
        };
        let mut profile = channel_tab.and_then(|_| channel::profile(&json));
        if kind == "channel-home" {
            let mut seen = std::collections::HashSet::new();
            items.retain(|item| seen.insert(item.id.clone()));
            if items.is_empty() {
                let uploads_url = channel::tab_url(query.trim(), "videos")?;
                let uploads = self.run(
                    app,
                    &uploads_url,
                    vec![
                        "--flat-playlist".into(),
                        "--playlist-items".into(),
                        "1:12".into(),
                        "--extractor-args".into(),
                        "youtubetab:viewsical_profile=1".into(),
                    ],
                    None,
                    generation,
                    request.token.clone(),
                ).await;
                match uploads {
                    Ok(uploads) => {
                        if profile.is_none() {
                            profile = channel::profile(&uploads);
                        }
                        if let Some(entries) = uploads["entries"].as_array() {
                            items = entries.iter().filter_map(media_item)
                                .filter(|item| item.kind == "video").collect();
                        }
                    }
                    Err(error) if error.code == "channel_tab_missing" => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(BrowsePage {
            items,
            collection,
            channel: profile,
            next_cursor: (has_more && kind != "channel-home")
                .then(|| encode_cursor(offset + PAGE_SIZE, kind, query, generation)),
        })
    }
}

fn includes_item(kind: &str, item: &MediaItem) -> bool {
    match kind {
        "channel" | "channel-live" => item.kind == "video",
        "channel-playlists" => item.kind == "playlist",
        "channel-home" => matches!(item.kind.as_str(), "video" | "playlist"),
        _ => true,
    }
}

pub(super) fn collection_summary(json: &Value, target: &str, items: &[MediaItem]) -> CollectionSummary {
    let id = text(json, "id");
    let thumbnail = json
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .rev()
                .find_map(|v| v.get("url").and_then(Value::as_str))
        })
        .filter(|v| v.starts_with("https://"))
        .map(str::to_owned)
        .or_else(|| items.first().and_then(|v| v.thumbnail.clone()));
    CollectionSummary {
        is_mix: id.starts_with("RD") || target.contains("list=RD"),
        id,
        title: text(json, "title"),
        owner: json
            .get("channel")
            .or_else(|| json.get("uploader"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        thumbnail,
        item_count: json
            .get("playlist_count")
            .or_else(|| json.get("n_entries"))
            .and_then(Value::as_u64),
        description: json
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        url: target.into(),
    }
}

pub(super) fn browse_target(kind: &str, query: &str, search_count: usize) -> AppResult<String> {
    let query = query.trim();
    if let Some(tab) = channel::tab_name(kind) {
        return channel::tab_url(query, tab);
    }
    match kind {
        "home" => Ok("https://www.youtube.com/".into()),
        "subscriptions" => Ok(":ytsubs".into()),
        "channels" => Ok("https://www.youtube.com/feed/channels".into()),
        "playlists" => Ok("https://www.youtube.com/feed/playlists".into()),
        "search" => {
            if query.is_empty() || query.chars().count() > 500 {
                return Err(AppError::new(
                    "invalid_input",
                    "Enter a search of 1–500 characters.",
                ));
            }
            if let Ok(parsed) = safe_youtube_url(query) {
                if let Some(id) = parsed
                    .query_pairs()
                    .find(|(k, _)| k == "list")
                    .map(|(_, v)| v.into_owned())
                    .filter(|v| valid_playlist_id(v))
                {
                    return playlist_target(&id, Some(query));
                }
            }
            if let Ok(video) = normalize_video_ref(query) {
                if let Some(playlist) = video.playlist_id {
                    return Ok(format!(
                        "https://www.youtube.com/watch?v={}&list={playlist}",
                        video.video_id
                    ));
                }
                return Ok(canonical_video(&video.video_id));
            }
            if query.contains("://") || query.starts_with("www.") {
                return Err(AppError::new(
                    "invalid_input",
                    "Paste a YouTube video link, or enter words to search.",
                ));
            }
            Ok(format!("ytsearch{search_count}:{query}"))
        }
        "playlist" => {
            let id = if valid_playlist_id(query) {
                query.into()
            } else {
                let url = safe_youtube_url(query)?;
                url.query_pairs()
                    .find(|(k, _)| k == "list")
                    .map(|(_, v)| v.into_owned())
                    .filter(|v| valid_playlist_id(v))
                    .ok_or_else(|| {
                        AppError::new("invalid_input", "Choose a valid YouTube playlist.")
                    })?
            };
            playlist_target(&id, Some(query))
        }
        _ => Err(AppError::new(
            "invalid_input",
            "This library view is not supported.",
        )),
    }
}

fn cursor_hash(kind: &str, query: &str, generation: u64) -> u64 {
    let mut h = DefaultHasher::new();
    (kind, query, generation).hash(&mut h);
    h.finish()
}

pub(super) fn encode_cursor(offset: usize, kind: &str, query: &str, generation: u64) -> String {
    format!("{offset}:{:x}", cursor_hash(kind, query, generation))
}

pub(super) fn decode_cursor(
    cursor: Option<&str>,
    kind: &str,
    query: &str,
    generation: u64,
) -> AppResult<usize> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let error = || {
        AppError::new(
            "stale_cursor",
            "This page is no longer current. Refresh the list.",
        )
    };
    let (offset, hash) = cursor.split_once(':').ok_or_else(error)?;
    let offset: usize = offset.parse().map_err(|_| error())?;
    if offset > 10_000
        || !offset.is_multiple_of(PAGE_SIZE)
        || hash != format!("{:x}", cursor_hash(kind, query, generation))
    {
        return Err(error());
    }
    Ok(offset)
}
