//! Replaceable protocol boundary. Only normalized metadata escapes this module;
//! resolved CDN URLs remain in Rust and are never persisted as video identity.
use crate::{
    models::*,
    runtime::{now, ToolPaths},
    session::{CookieSnapshot, SessionManager},
    AppState,
};
use serde_json::Value;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

const PAGE_SIZE: usize = 24;
const MAX_JSON: u64 = 16 * 1024 * 1024;
type Active = Arc<Mutex<HashMap<String, (uuid::Uuid, CancellationToken)>>>;

#[derive(Debug, Clone)]
pub struct PlaybackPlan {
    pub video_url: String,
    pub audio_url: Option<String>,
    pub headers: Vec<(String, String)>,
    pub selected_quality: u32,
    pub qualities: Vec<u32>,
    pub session_generation: u64,
    pub video: MediaItem,
    pub mode: String,
    pub protocol: String,
    pub format_id: String,
    pub expires_at: Option<u64>,
    pub audio_headers: Vec<(String, String)>,
}

struct RequestGuard {
    id: String,
    nonce: uuid::Uuid,
    token: CancellationToken,
    active: Active,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if active
            .get(&self.id)
            .is_some_and(|(id, _)| *id == self.nonce)
        {
            active.remove(&self.id);
        }
    }
}

pub struct YoutubeGateway {
    tools: Arc<ToolPaths>,
    sessions: Arc<SessionManager>,
    active: Active,
    closing: AtomicBool,
    sources: Mutex<HashMap<String, PlaybackPlan>>,
    resolving: tokio::sync::Mutex<()>,
}
impl YoutubeGateway {
    pub fn new(tools: Arc<ToolPaths>, sessions: Arc<SessionManager>) -> Self {
        Self {
            tools,
            sessions,
            active: Arc::new(Mutex::new(HashMap::new())),
            closing: AtomicBool::new(false),
            sources: Mutex::new(HashMap::new()),
            resolving: tokio::sync::Mutex::new(()),
        }
    }
    fn begin(&self, request_id: &str) -> RequestGuard {
        let token = CancellationToken::new();
        let nonce = uuid::Uuid::new_v4();
        if let Some((_, old)) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(request_id.into(), (nonce, token.clone()))
        {
            old.cancel();
        }
        RequestGuard {
            id: request_id.into(),
            nonce,
            token,
            active: self.active.clone(),
        }
    }
    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.cancel_all();
    }
    pub fn cancel_all(&self) {
        self.sources
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        for (_, token) in active.values() {
            token.cancel();
        }
        active.clear();
    }
    pub fn cancel(&self, request_id: &str) {
        if let Some((_, token)) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(request_id)
        {
            token.cancel();
        }
    }

    async fn run(
        &self,
        app: &tauri::AppHandle,
        target: &str,
        extra: Vec<String>,
        cookies: Option<&CookieSnapshot>,
        generation: u64,
        cancellation: CancellationToken,
    ) -> AppResult<Value> {
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if self.closing.load(Ordering::SeqCst) || cancellation.is_cancelled() {
            return Err(AppError::new("cancelled", "The request was cancelled."));
        }
        let started = std::time::Instant::now();
        let operation = if target.starts_with(":ytsubs") {
            "subscriptions"
        } else if target.contains("ytsearch") {
            "search"
        } else if target.contains("list=") {
            "playlist"
        } else if target.contains("/watch?") {
            "video"
        } else {
            "browse"
        };
        let mut command = Command::new(self.tools.yt_dlp()?);
        command
            .args([
                "--ignore-config",
                "--no-plugin-dirs",
                "--no-update",
                "--no-warnings",
                "--skip-download",
                "--dump-single-json",
                "--socket-timeout",
                "20",
                "--retries",
                "2",
                "--extractor-retries",
                "1",
            ])
            .arg("--plugin-dirs")
            .arg(self.tools.youtube_plugins(app)?)
            .arg("--js-runtimes")
            .arg(format!("deno:{}", self.tools.deno()?.display()))
            .arg("--ffmpeg-location")
            .arg(
                self.tools
                    .ffmpeg()?
                    .parent()
                    .unwrap_or(std::path::Path::new(".")),
            );
        if let Some(cookies) = cookies {
            command.arg("--cookies").arg(cookies.path());
        }
        command
            .args(extra)
            .arg("--")
            .arg(target)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| AppError::new("tool_start", "Could not start the bundled YouTube engine. Check the installed tools in Settings."))?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let out = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_JSON + 1)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let err = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take(128 * 1024)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let status = tokio::select! {
            _ = cancellation.cancelled() => { terminate(&mut child).await; out.abort(); err.abort(); return Err(AppError::new("cancelled", "The request was cancelled.")); }
            _ = tokio::time::sleep(Duration::from_secs(90)) => { terminate(&mut child).await; out.abort(); err.abort(); return Err(AppError::new("timeout", "YouTube took too long to respond. Check your connection and retry.")); }
            result = child.wait() => result.map_err(AppError::io)?,
        };
        let stdout = out.await.map_err(AppError::io)?.map_err(AppError::io)?;
        let stderr = err.await.map_err(AppError::io)?.map_err(AppError::io)?;
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if let Some(cookies) = cookies {
            self.sessions.accept_cookie_updates(app, cookies).await?;
        }
        if !status.success() {
            let error = classify_error(&String::from_utf8_lossy(&stderr));
            tracing::warn!(operation, authenticated=cookies.is_some(), elapsed_ms=started.elapsed().as_millis() as u64,
                exit_code=status.code(), category=%error.code, "YouTube adapter operation failed");
            return Err(error);
        }
        tracing::info!(
            operation,
            authenticated = cookies.is_some(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "YouTube adapter completed"
        );
        if stdout.len() as u64 > MAX_JSON {
            return Err(AppError::new(
                "response_size",
                "YouTube returned too much data. Try a smaller playlist or another search.",
            ));
        }
        serde_json::from_slice(&stdout).map_err(|_| AppError::new("provider_changed", "The YouTube response could not be read. Retry or update the bundled YouTube engine."))
    }

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

    pub async fn metadata(&self, app: &tauri::AppHandle, item: &MediaItem) -> AppResult<MediaItem> {
        let plan = self.resolve(app, item, 1080).await?;
        Ok(plan.video)
    }

    pub(crate) async fn comments_document(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        sort: &str,
        limit: usize,
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
        let args = vec!["--write-comments".into(), "--ignore-no-formats-error".into(), "--no-playlist".into(),
            "--extractor-args".into(), format!("youtube:skip=hls,dash;player_skip=js;comment_sort={order};max_comments={limit},{limit},0,0,1")];
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

    pub async fn resolve(
        &self,
        app: &tauri::AppHandle,
        item: &MediaItem,
        quality: u32,
    ) -> AppResult<PlaybackPlan> {
        self.resolve_mode(app, item, quality, "video", false, false)
            .await
    }

    pub async fn resolve_mode(
        &self,
        app: &tauri::AppHandle,
        item: &MediaItem,
        quality: u32,
        mode: &str,
        force_refresh: bool,
        prefer_hls: bool,
    ) -> AppResult<PlaybackPlan> {
        if !matches!(mode, "video" | "audio") {
            return Err(AppError::new(
                "invalid_mode",
                "Choose video or audio-only playback.",
            ));
        }
        let video = normalize_video_ref(&item.url).or_else(|_| normalize_video_ref(&item.id))?;
        let generation = self.sessions.snapshot().generation;
        let cap = quality.clamp(144, 4320);
        let key = format!(
            "{}:{generation}:{mode}:{}:{prefer_hls}:2026.10.26",
            video.video_id,
            if mode == "audio" { 0 } else { cap }
        );
        let request = self.begin("playback-source");
        // One solver invocation at a time. A superseded request cannot commit a source.
        let _resolution = self.resolving.lock().await;
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if request.token.is_cancelled() || self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new("cancelled", "The request was cancelled."));
        }
        if force_refresh {
            let prefix = format!("{}:{generation}:{mode}:", video.video_id);
            self.sources
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .retain(|key, _| !key.starts_with(&prefix));
        }
        if !force_refresh {
            if let Some(plan) = self
                .sources
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&key)
                .filter(|p| source_fresh(p.expires_at, now()))
                .cloned()
            {
                return Ok(plan);
            }
        }
        let url = canonical_video(&video.video_id);
        let args = vec![
            "--no-playlist".into(),
            "-f".into(),
            source_selector(mode, cap, prefer_hls),
        ];
        let anonymous = self
            .run(
                app,
                &url,
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
                    &url,
                    args,
                    cookies.as_ref(),
                    generation,
                    request.token.clone(),
                )
                .await?
            }
            result => result?,
        };
        if json
            .get("is_live")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || json.get("live_status").and_then(Value::as_str) == Some("is_upcoming")
        {
            return Err(AppError::new(
                "live_unsupported",
                "Live and upcoming streams are not supported. Choose an on-demand video.",
            ));
        }
        let mut plan = playback_from_json(&json, generation)?;
        plan.mode = mode.into();
        if mode == "audio" {
            plan.selected_quality = 0;
            plan.audio_url = None;
        }
        tracing::info!(video_id=%video.video_id, mode, protocol=%plan.protocol, format=%plan.format_id, separate_audio=plan.audio_url.is_some(),
            quality=plan.selected_quality, "Playback source selected");
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if request.token.is_cancelled() {
            return Err(AppError::new("cancelled", "The request was cancelled."));
        }
        let mut cache = self.sources.lock().unwrap_or_else(|p| p.into_inner());
        cache
            .retain(|_, p| source_fresh(p.expires_at, now()) && p.session_generation == generation);
        if source_fresh(plan.expires_at, now()) {
            // After a transport fallback, normal replay should reuse the fresh
            // alternative instead of reopening the rejected direct variant.
            if prefer_hls {
                let regular = format!(
                    "{}:{generation}:{mode}:{}:false:2026.10.26",
                    video.video_id,
                    if mode == "audio" { 0 } else { cap }
                );
                cache.insert(regular, plan.clone());
            }
            cache.insert(key, plan.clone());
        }
        Ok(plan)
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
        let mut extra = vec![
            "--flat-playlist".into(),
            "--playlist-items".into(),
            format!("{}:{}", offset + 1, offset + PAGE_SIZE + 1),
        ];
        if kind == "search" && normalize_video_ref(query).is_ok() && !target.contains("list=") {
            extra.push("--no-playlist".into());
        }
        let request = self.begin(request_id);
        let public = matches!(kind, "search" | "channel");
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
        let json=result.map_err(|error| {
            if target.contains("list=RD") && matches!(error.code.as_str(),"extraction_failed"|"unsupported_library") {
                AppError::new("mix_context", "This Mix needs its original watch link. Paste a YouTube link containing both v= and list= to open it.")
            } else { error }
        })?;
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
                    if kind == "playlist" {
                        item.playlist_index =
                            Some(item.playlist_index.unwrap_or((offset + index + 1) as u64));
                    }
                    Some(item)
                })
                .collect()
        } else {
            media_item(&json).into_iter().collect()
        };
        items.truncate(PAGE_SIZE);
        let collection = if matches!(kind, "playlist" | "channel") {
            Some(collection_summary(&json, &target, &items))
        } else {
            None
        };
        Ok(BrowsePage {
            items,
            collection,
            next_cursor: has_more
                .then(|| encode_cursor(offset + PAGE_SIZE, kind, query, generation)),
        })
    }
}

fn source_selector(mode: &str, cap: u32, prefer_hls: bool) -> String {
    if mode == "audio" {
        return if prefer_hls {
            "ba[protocol^=m3u8]/ba[protocol=https]/ba"
        } else {
            "ba[protocol=https]/ba"
        }
        .into();
    }
    let direct = format!(
        "bv[protocol=https][height<={cap}]+ba[protocol=https]/b[protocol=https][height<={cap}]"
    );
    let hls = format!(
        "bv[protocol^=m3u8][height<={cap}]+ba[protocol^=m3u8]/b[protocol^=m3u8][height<={cap}]"
    );
    if prefer_hls {
        format!("{hls}/{direct}")
    } else {
        format!("{direct}/{hls}")
    }
}
fn source_fresh(expiry: Option<u64>, timestamp: u64) -> bool {
    expiry.is_some_and(|value| value > timestamp.saturating_add(60))
}
fn source_expiry<'a>(urls: impl Iterator<Item = &'a str>) -> Option<u64> {
    let times: Option<Vec<u64>> = urls
        .map(|raw| {
            url::Url::parse(raw)
                .ok()?
                .query_pairs()
                .find(|(k, _)| k == "expire")?
                .1
                .parse()
                .ok()
        })
        .collect();
    times?.into_iter().min()
}
fn safe_headers(value: &Value) -> Vec<(String, String)> {
    value
        .get("http_headers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(k, _)| {
            matches!(
                k.to_ascii_lowercase().as_str(),
                "user-agent" | "referer" | "origin" | "accept-language"
            )
        })
        .filter_map(|(k, v)| {
            v.as_str()
                .filter(|v| !v.contains(['\r', '\n']))
                .map(|v| (k.clone(), v.to_owned()))
        })
        .collect()
}
fn playlist_target(id: &str, original: Option<&str>) -> AppResult<String> {
    if !valid_playlist_id(id) {
        return Err(AppError::new(
            "invalid_input",
            "Choose a valid YouTube playlist.",
        ));
    }
    if let Some(original) = original.filter(|v| v.contains("://")) {
        let parsed = safe_youtube_url(original)?;
        if let Some(seed) = parsed
            .query_pairs()
            .find(|(k, _)| k == "v")
            .map(|(_, v)| v.into_owned())
            .filter(|v| valid_video_id(v))
        {
            return Ok(format!("https://www.youtube.com/watch?v={seed}&list={id}"));
        }
    }
    // Standard per-video radio lists expose their seed as RD + the video ID.
    if id.starts_with("RD") && id.len() == 13 && valid_video_id(&id[2..]) {
        return Ok(format!(
            "https://www.youtube.com/watch?v={}&list={id}",
            &id[2..]
        ));
    }
    Ok(format!("https://www.youtube.com/playlist?list={id}"))
}
fn collection_summary(json: &Value, target: &str, items: &[MediaItem]) -> CollectionSummary {
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

async fn terminate(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    {
        if child.try_wait().ok().flatten().is_none() {
            if let Some(pid) = child.id() {
                let mut taskkill = Command::new("taskkill.exe");
                taskkill
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let _ = taskkill.status().await;
            }
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub fn ensure_generation(expected: u64, actual: u64) -> AppResult<()> {
    if expected == actual {
        Ok(())
    } else {
        Err(AppError::new(
            "cancelled",
            "The video or account changed. Please retry.",
        ))
    }
}

pub fn normalize_video_ref(input: &str) -> AppResult<VideoRef> {
    let input = input.trim();
    if valid_video_id(input) {
        return Ok(VideoRef {
            video_id: input.into(),
            ..Default::default()
        });
    }
    let with_scheme = if input.starts_with("www.youtube.com/")
        || input.starts_with("youtube.com/")
        || input.starts_with("youtu.be/")
    {
        format!("https://{input}")
    } else {
        input.into()
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|_| {
        AppError::new(
            "invalid_video",
            "Choose a valid YouTube video or paste its link.",
        )
    })?;
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(AppError::new(
            "invalid_video",
            "This is not a supported YouTube link.",
        ));
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let segments: Vec<_> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    let id = match host.as_str() {
        "youtu.be" | "www.youtu.be" => segments.first().map(|s| s.to_string()),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            if parsed.path() == "/watch" {
                parsed
                    .query_pairs()
                    .find(|(k, _)| k == "v")
                    .map(|(_, v)| v.into_owned())
            } else if matches!(segments.first().copied(), Some("shorts" | "embed" | "live")) {
                segments.get(1).map(|s| s.to_string())
            } else {
                None
            }
        }
        _ => None,
    }
    .filter(|id| valid_video_id(id))
    .ok_or_else(|| {
        AppError::new(
            "invalid_video",
            "This is not a supported YouTube video link.",
        )
    })?;
    let playlist_id = parsed
        .query_pairs()
        .find(|(k, _)| k == "list")
        .map(|(_, v)| v.into_owned())
        .filter(|v| valid_playlist_id(v));
    let start_seconds = parsed
        .query_pairs()
        .find(|(k, _)| k == "t" || k == "start")
        .and_then(|(_, v)| parse_timestamp(&v));
    Ok(VideoRef {
        video_id: id,
        playlist_id,
        start_seconds,
    })
}
pub fn canonical_video(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}
fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn valid_playlist_id(id: &str) -> bool {
    (2..=128).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn parse_timestamp(input: &str) -> Option<f64> {
    if let Ok(seconds) = input.parse::<f64>() {
        return (seconds.is_finite() && seconds >= 0.).then_some(seconds);
    }
    let mut total = 0u64;
    let mut number = String::new();
    for c in input.chars() {
        if c.is_ascii_digit() {
            number.push(c);
        } else {
            let multiplier = match c {
                'h' => 3600,
                'm' => 60,
                's' => 1,
                _ => return None,
            };
            total = total.checked_add(number.parse::<u64>().ok()?.checked_mul(multiplier)?)?;
            number.clear();
        }
    }
    if !number.is_empty() {
        total = total.checked_add(number.parse::<u64>().ok()?)?;
    }
    Some(total as f64)
}

fn browse_target(kind: &str, query: &str, search_count: usize) -> AppResult<String> {
    let query = query.trim();
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
        "channel" => {
            let url = if query.starts_with("UC")
                && query.len() == 24
                && query
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            {
                format!("https://www.youtube.com/channel/{query}")
            } else if query.starts_with('@') && !query.contains(['/', '?', '#', ' ']) {
                format!("https://www.youtube.com/{query}")
            } else {
                safe_youtube_url(query)?.to_string()
            };
            let mut parsed = safe_youtube_url(&url)?;
            let path = parsed.path().trim_end_matches('/');
            let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
            let base = if parts.first().is_some_and(|s| s.starts_with('@')) {
                format!("/{}", parts[0])
            } else if parts.len() >= 2 && matches!(parts[0], "channel" | "user" | "c") {
                format!("/{}/{}", parts[0], parts[1])
            } else {
                return Err(AppError::new(
                    "invalid_input",
                    "Choose a valid YouTube channel.",
                ));
            };
            parsed.set_path(&format!("{base}/videos"));
            parsed.set_query(None);
            parsed.set_fragment(None);
            Ok(parsed.to_string())
        }
        _ => Err(AppError::new(
            "invalid_input",
            "This library view is not supported.",
        )),
    }
}
fn safe_youtube_url(input: &str) -> AppResult<url::Url> {
    let url = url::Url::parse(input)
        .map_err(|_| AppError::new("invalid_input", "Choose a valid YouTube link."))?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(
            url.host_str(),
            Some("www.youtube.com" | "youtube.com" | "m.youtube.com")
        )
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::new(
            "invalid_input",
            "Only YouTube library links are supported.",
        ));
    }
    let mut url = url;
    let _ = url.set_scheme("https");
    let _ = url.set_host(Some("www.youtube.com"));
    let _ = url.set_port(None);
    Ok(url)
}

fn cursor_hash(kind: &str, query: &str, generation: u64) -> u64 {
    let mut h = DefaultHasher::new();
    (kind, query, generation).hash(&mut h);
    h.finish()
}
fn encode_cursor(offset: usize, kind: &str, query: &str, generation: u64) -> String {
    format!("{offset}:{:x}", cursor_hash(kind, query, generation))
}
fn decode_cursor(
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

fn text(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
pub fn media_item(value: &Value) -> Option<MediaItem> {
    let id = value.get("id")?.as_str()?.to_string();
    let source_url = value
        .get("webpage_url")
        .or_else(|| value.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let kind = if source_url.contains("/playlist?")
        || (!valid_video_id(&id) && (id.starts_with("RD") || id.starts_with("PL")))
        || matches!(id.as_str(), "WL" | "LL")
        || value.get("_type").and_then(Value::as_str) == Some("playlist")
    {
        "playlist"
    } else if id.starts_with("UC") && id.len() == 24
        || source_url.contains("/channel/")
        || (source_url.contains("/@") && !valid_video_id(&id))
    {
        "channel"
    } else if valid_video_id(&id) {
        "video"
    } else {
        return None;
    };
    let url = match kind {
        "video" => canonical_video(&id),
        "playlist" => playlist_target(&id, Some(source_url)).ok()?,
        _ => format!("https://www.youtube.com/channel/{id}"),
    };
    let thumbnail = value
        .get("thumbnail")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("thumbnails")
                .and_then(Value::as_array)
                .and_then(|ts| {
                    ts.iter()
                        .rev()
                        .find_map(|v| v.get("url").and_then(Value::as_str))
                })
        })
        .filter(|url| url.starts_with("https://"))
        .map(str::to_string);
    let title = text(value, "title");
    let channel = ["channel", "uploader", "creator"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    Some(MediaItem {
        id,
        kind: kind.into(),
        title: if title.is_empty() {
            "Untitled video".into()
        } else {
            title
        },
        channel,
        thumbnail,
        url,
        duration: value.get("duration").and_then(Value::as_f64),
        view_count: value.get("view_count").and_then(Value::as_u64),
        playlist_index: value.get("playlist_index").and_then(Value::as_u64),
        youtube_loudness_db: crate::normalization::valid_loudness(
            value.get("viewsical_loudness_db").and_then(Value::as_f64),
        ),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn cdn_url(value: &Value) -> AppResult<String> {
    let raw = value.get("url").and_then(Value::as_str).ok_or_else(|| {
        AppError::new(
            "no_stream",
            "YouTube did not return a playable stream. Try another quality.",
        )
    })?;
    let url = url::Url::parse(raw)
        .map_err(|_| AppError::new("no_stream", "YouTube returned an invalid media source."))?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !(host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::new(
            "unsupported_source",
            "YouTube returned an unsupported media source.",
        ));
    }
    Ok(raw.to_string())
}
fn playback_from_json(json: &Value, generation: u64) -> AppResult<PlaybackPlan> {
    let selected = json.get("requested_formats").and_then(Value::as_array);
    let video = selected
        .and_then(|formats| {
            formats.iter().find(|v| {
                v.get("vcodec")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s != "none")
            })
        })
        .unwrap_or(json);
    let audio = selected.and_then(|formats| {
        formats.iter().find(|v| {
            v.get("vcodec").and_then(Value::as_str) == Some("none")
                // yt-dlp's selected YouTube HLS audio (e.g. format 234)
                // can omit acodec until the media is demuxed. vcodec=none
                // still identifies that selected component as audio-only.
                && v.get("acodec").and_then(Value::as_str) != Some("none")
        })
    });
    let video_url = cdn_url(video)?;
    let audio_url = audio.map(cdn_url).transpose()?;
    let selected_quality = video.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    let mut qualities: Vec<u32> = json
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|f| {
            f.get("vcodec")
                .and_then(Value::as_str)
                .is_some_and(|c| c != "none")
        })
        .filter_map(|f| f.get("height").and_then(Value::as_u64).map(|h| h as u32))
        .filter(|h| *h > 0)
        .collect();
    if selected_quality > 0 {
        qualities.push(selected_quality);
    }
    qualities.sort_unstable();
    qualities.dedup();
    qualities.reverse();
    let headers: Vec<_> = video
        .get("http_headers")
        .or_else(|| json.get("http_headers"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(key, _)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "user-agent" | "referer" | "origin" | "accept-language"
            )
        })
        .filter_map(|(k, v)| {
            v.as_str()
                .filter(|s| !s.contains(['\r', '\n']))
                .map(|s| (k.clone(), s.to_string()))
        })
        .collect();
    let protocol = text(video, "protocol");
    let video = media_item(json).ok_or_else(|| {
        AppError::new(
            "provider_changed",
            "YouTube did not return valid video metadata.",
        )
    })?;
    let expires_at = source_expiry(std::iter::once(video_url.as_str()).chain(audio_url.as_deref()));
    let audio_headers = audio
        .map(|a| {
            safe_headers(if a.get("http_headers").is_some() {
                a
            } else {
                json
            })
        })
        .unwrap_or_default();
    let format_id = text(json, "format_id");
    Ok(PlaybackPlan {
        mode: "video".into(),
        protocol,
        format_id,
        expires_at,
        audio_headers,
        video_url,
        audio_url,
        headers,
        selected_quality,
        qualities,
        session_generation: generation,
        video,
    })
}

pub fn classify_error(stderr: &str) -> AppError {
    let lower = stderr.to_ascii_lowercase();
    let (code, message) = if lower.contains("cookies are no longer valid")
        || lower.contains("cookies have expired")
    {
        (
            "session_expired",
            "Your YouTube session has expired. Sign in again in the app.",
        )
    } else if lower.contains("not a bot") || lower.contains("po token") {
        ("youtube_challenge", "YouTube requires a browser verification or a playback token for this request. Reconnect in the app and retry. Some videos may remain unavailable.")
    } else if lower.contains("login required")
        || lower.contains("login details are needed")
        || lower.contains("sign in")
        || lower.contains("requires authentication")
    {
        (
            "sign_in_required",
            "YouTube requires a signed-in account for this request. Sign in in the app and retry.",
        )
    } else if lower.contains("private video") {
        (
            "private_video",
            "This video is private. Connect an account that has access, or choose another video.",
        )
    } else if lower.contains("age") && (lower.contains("restrict") || lower.contains("confirm")) {
        (
            "age_restricted",
            "This video requires age verification in a supported YouTube session.",
        )
    } else if lower.contains("requested format") || lower.contains("no video formats") {
        ("format_unavailable", "The requested quality is unavailable. Try another quality or update the YouTube engine.")
    } else if lower.contains("403") || lower.contains("forbidden") {
        ("access_denied", "YouTube rejected this media source. Retry to resolve a fresh source, or choose another video.")
    } else if lower.contains("unavailable")
        || lower.contains("removed")
        || lower.contains("not available")
    {
        (
            "unavailable",
            "This video or library is unavailable to the current session or region.",
        )
    } else if lower.contains("unsupported url") {
        ("unsupported_library", "This YouTube library is not supported by the installed engine. Update the engine or try a direct playlist link.")
    } else if lower.contains("timed out")
        || lower.contains("unable to download")
        || lower.contains("connection")
        || lower.contains("name resolution")
    {
        (
            "network",
            "Could not reach YouTube. Check your connection and retry.",
        )
    } else {
        ("extraction_failed", "The YouTube engine could not read this request. Retry or update the bundled engine from a trusted release.")
    };
    AppError::new(code, message)
}

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
mod tests {
    use super::*;
    #[test]
    fn loudness_metadata_survives_stable_media_storage() {
        let item = media_item(&serde_json::json!({
            "id":"dQw4w9WgXcQ", "title":"Fixture", "viewsical_loudness_db":6.0,
        }))
        .unwrap();
        assert_eq!(item.youtube_loudness_db, Some(6.));
        let restored: MediaItem =
            serde_json::from_str(&serde_json::to_string(&item).unwrap()).unwrap();
        assert_eq!(restored.youtube_loudness_db, Some(6.));
        let legacy = media_item(&serde_json::json!({"id":"dQw4w9WgXcQ"})).unwrap();
        assert_eq!(legacy.youtube_loudness_db, None);
        let invalid =
            media_item(&serde_json::json!({"id":"dQw4w9WgXcQ","viewsical_loudness_db":101}))
                .unwrap();
        assert_eq!(invalid.youtube_loudness_db, None);
    }
    use serde_json::json;
    #[test]
    fn normalizes_identity_without_retaining_tracking_parameters() {
        let reference =
            normalize_video_ref("https://youtu.be/BaW_jenozKc?t=1m2s&list=PLabc123&si=tracking")
                .unwrap();
        assert_eq!(reference.video_id, "BaW_jenozKc");
        assert_eq!(reference.start_seconds, Some(62.));
        assert_eq!(reference.playlist_id.as_deref(), Some("PLabc123"));
        assert_eq!(
            canonical_video(&reference.video_id),
            "https://www.youtube.com/watch?v=BaW_jenozKc"
        );
        assert!(
            normalize_video_ref("https://youtube.com.attacker.test/watch?v=BaW_jenozKc").is_err()
        );
        assert!(normalize_video_ref("file:///cookies").is_err());
    }
    #[test]
    fn page_cursor_is_bound_to_query_and_session() {
        let cursor = encode_cursor(24, "search", "rust", 7);
        assert_eq!(
            decode_cursor(Some(&cursor), "search", "rust", 7).unwrap(),
            24
        );
        assert!(decode_cursor(Some(&cursor), "search", "music", 7).is_err());
        assert!(decode_cursor(Some(&cursor), "search", "rust", 8).is_err());
        assert!(ensure_generation(7, 8).is_err());
    }
    #[test]
    fn separates_audio_video_and_strips_account_headers() {
        let response = json!({ "id":"BaW_jenozKc", "title":"Fixture", "formats":[{"height":360,"vcodec":"avc1"},{"height":1080,"vcodec":"vp9"}],
            "requested_formats":[{"url":"https://rr1.googlevideo.com/video?expire=1","vcodec":"vp9","height":1080,"http_headers":{"User-Agent":"Fixture","Cookie":"secret","Authorization":"secret"}},
            {"url":"https://rr1.googlevideo.com/audio?expire=1","vcodec":"none","acodec":"opus"}] });
        let plan = playback_from_json(&response, 9).unwrap();
        assert!(plan.audio_url.is_some());
        assert_eq!(plan.selected_quality, 1080);
        assert_eq!(plan.qualities, vec![1080, 360]);
        assert_eq!(plan.headers, vec![("User-Agent".into(), "Fixture".into())]);
    }
    #[test]
    fn rejects_untrusted_stream_hosts_and_line_breaks() {
        assert!(cdn_url(&json!({"url":"https://googlevideo.com.attacker.test/a"})).is_err());
        assert!(cdn_url(&json!({"url":"http://rr1.googlevideo.com/a"})).is_err());
    }
    #[test]
    fn classifies_rejections_without_exposing_cookie_material() {
        let error = classify_error(
            "ERROR HTTP Error 403 forbidden https://signed-url/?secret=token Cookie: SID=secret",
        );
        assert_eq!(error.code, "access_denied");
        assert!(!error.message.contains("secret"));
    }
    #[test]
    fn canonicalizes_library_targets() {
        assert_eq!(
            browse_target("channel", "@rustlang", 25).unwrap(),
            "https://www.youtube.com/@rustlang/videos"
        );
        assert!(browse_target("playlist", "https://attacker.test/?list=PLabc", 25).is_err());
        assert_eq!(
            browse_target("search", "--execute evil", 25).unwrap(),
            "ytsearch25:--execute evil"
        );
    }
    #[test]
    fn preserves_mix_seed_and_discards_tracking() {
        assert_eq!(
            browse_target(
                "playlist",
                "https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM&si=tracking",
                25
            )
            .unwrap(),
            "https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM"
        );
        assert_eq!(
            browse_target(
                "search",
                "https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM",
                25
            )
            .unwrap(),
            "https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM"
        );
        let item=media_item(&json!({"id":"RDMM","title":"Mix","url":"https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM"})).unwrap();
        assert_eq!(item.kind, "playlist");
        assert!(item.url.contains("v=fzQ6gRAEoy0"));
        assert!(playlist_target(
            "PLtest",
            Some("https://attacker.invalid/watch?v=fzQ6gRAEoy0")
        )
        .is_err());
    }
    #[test]
    fn source_cache_requires_all_expiries_and_skew() {
        assert_eq!(
            source_expiry(
                [
                    "https://rr.googlevideo.com/v?expire=500",
                    "https://rr.googlevideo.com/a?expire=400"
                ]
                .into_iter()
            ),
            Some(400)
        );
        assert_eq!(
            source_expiry(
                [
                    "https://rr.googlevideo.com/v?expire=500",
                    "https://rr.googlevideo.com/a"
                ]
                .into_iter()
            ),
            None
        );
        assert!(source_fresh(Some(400), 339));
        assert!(!source_fresh(Some(400), 340));
        assert!(!source_fresh(None, 0));
    }
    #[test]
    fn direct_first_and_audio_selection_do_not_require_video_in_audio_mode() {
        assert!(
            source_selector("video", 1080, false).starts_with("bv[protocol=https][height<=1080]")
        );
        assert!(source_selector("video", 720, true).starts_with("bv[protocol^=m3u8]"));
        assert!(source_selector("video", 720, true).contains("+ba[protocol^=m3u8]"));
        assert!(source_selector("audio", 720, true).starts_with("ba[protocol^=m3u8]"));
        assert_eq!(
            source_selector("audio", 1080, false),
            "ba[protocol=https]/ba"
        );
        let plan=playback_from_json(&json!({"id":"fzQ6gRAEoy0","title":"Audio","url":"https://rr.googlevideo.com/a?expire=500","vcodec":"none","acodec":"opus","protocol":"https"}),3).unwrap();
        assert_eq!(plan.selected_quality, 0);
        assert!(plan.audio_url.is_none());
    }
    #[test]
    fn prefix_like_video_ids_and_short_mix_links_keep_correct_identity() {
        for id in ["RD123456789", "PL123456789"] {
            assert_eq!(
                media_item(&json!({"id":id,"title":"Video","url":canonical_video(id)}))
                    .unwrap()
                    .kind,
                "video"
            );
        }
        assert_eq!(
            browse_target(
                "search",
                "https://youtu.be/fzQ6gRAEoy0?list=RDMM&si=tracking",
                25
            )
            .unwrap(),
            "https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM"
        );
    }
    #[test]
    fn audio_inherits_only_root_headers_and_retains_own_override() {
        let mut response = json!({"id":"fzQ6gRAEoy0","title":"Fixture","http_headers":{"User-Agent":"root","Cookie":"secret"},
            "requested_formats":[{"url":"https://rr.googlevideo.com/v","vcodec":"avc1","height":1080,"http_headers":{"User-Agent":"video"}},
            {"url":"https://rr.googlevideo.com/a","vcodec":"none","acodec":"opus"}]});
        assert_eq!(
            playback_from_json(&response, 1).unwrap().audio_headers,
            vec![("User-Agent".into(), "root".into())]
        );
        response["requested_formats"][1]["http_headers"] = json!({"User-Agent":"audio"});
        assert_eq!(
            playback_from_json(&response, 1).unwrap().audio_headers,
            vec![("User-Agent".into(), "audio".into())]
        );
    }
    #[test]
    fn selected_hls_audio_without_codec_metadata_is_not_dropped() {
        // Actual format 234 shape observed on Shelter: vcodec=none,
        // protocol=m3u8_native, but no acodec until the source is opened.
        let response = json!({"id":"fzQ6gRAEoy0","title":"HLS fixture","format_id":"616+234",
        "requested_formats":[
            {"format_id":"616","url":"https://rr.googlevideo.com/video?expire=500","vcodec":"vp09.00.40.08","acodec":"none","height":1080,"protocol":"m3u8_native"},
            {"format_id":"234","url":"https://rr.googlevideo.com/audio?expire=450","vcodec":"none","protocol":"m3u8_native"}
        ]});
        let plan = playback_from_json(&response, 7).unwrap();
        assert_eq!(plan.selected_quality, 1080);
        assert_eq!(
            plan.audio_url.as_deref(),
            Some("https://rr.googlevideo.com/audio?expire=450")
        );
        assert_eq!(plan.expires_at, Some(450));
    }
}
