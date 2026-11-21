//! Stream selection, session-bound source reuse, and playback plan parsing.
use super::{
    canonical_video, ensure_generation,
    gateway::YoutubeGateway,
    media_item,
    metadata::{text, video_storyboard},
    normalize_video_ref,
    pending::PrefetchLookup,
};
use crate::{
    models::{AppError, AppResult, MediaItem, Storyboard},
    runtime::now,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{atomic::Ordering, Arc},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub(crate) struct PlaybackSelection<'a> {
    pub(crate) generation: u64,
    pub(crate) mode: &'a str,
    pub(crate) quality: u32,
    pub(crate) exact_quality: bool,
    pub(crate) force_refresh: bool,
    pub(crate) prefer_hls: bool,
}

struct ResolveOptions<'a> {
    generation: u64,
    mode: &'a str,
    quality: u32,
    exact_quality: bool,
    force_refresh: bool,
    prefer_hls: bool,
    persistent: bool,
    cancellation: CancellationToken,
}

fn cancelled_lookup() -> AppError {
    AppError::new("cancelled", "The source lookup was cancelled.")
}

#[derive(Debug, Clone)]
pub struct PlaybackPlan {
    pub video_url: String,
    pub audio_url: Option<String>,
    pub headers: Vec<(String, String)>,
    pub selected_quality: u32,
    pub qualities: Vec<u32>,
    pub session_generation: u64,
    pub video: MediaItem,
    pub storyboard: Option<Storyboard>,
    pub mode: String,
    pub protocol: String,
    pub format_id: String,
    pub expires_at: Option<u64>,
    pub audio_headers: Vec<(String, String)>,
}

impl PlaybackPlan {
    pub(crate) fn is_reusable(&self) -> bool {
        source_fresh(self.expires_at, now())
    }

    pub(crate) fn same_source(&self, other: &Self) -> bool {
        self.session_generation == other.session_generation
            && self.video.id == other.video.id
            && self.mode == other.mode
            && self.video_url == other.video_url
            && self.audio_url == other.audio_url
            && self.headers == other.headers
            && self.audio_headers == other.audio_headers
    }
}

pub(crate) struct PlaybackCandidates {
    pub(crate) primary: PlaybackPlan,
    pub(crate) alternate: Option<PlaybackPlan>,
    pub(crate) cache_hit: bool,
}

const MAX_VIDEO_HEIGHT: u32 = 4320;
const MAX_CACHED_INVENTORIES: usize = 64;
const MAX_VARIANTS_PER_VIDEO: usize = 64;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct SourceKey {
    video_id: String,
    generation: u64,
    audio: bool,
    prefer_hls: bool,
}

impl SourceKey {
    pub(super) fn new(video_id: &str, generation: u64, mode: &str, prefer_hls: bool) -> Self {
        let audio = mode == "audio";
        Self {
            video_id: video_id.into(),
            generation,
            audio,
            prefer_hls: audio && prefer_hls,
        }
    }

    pub(super) fn background(video_id: &str, generation: u64, mode: &str) -> Self {
        Self::new(video_id, generation, mode, false)
    }
}

#[derive(Default)]
pub(super) struct SourceCache(VecDeque<(SourceKey, Vec<PlaybackPlan>)>);

impl SourceCache {
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }

    pub(super) fn lookup(
        &mut self,
        key: &SourceKey,
        quality: u32,
        exact_quality: bool,
        timestamp: u64,
    ) -> Option<PlaybackCandidates> {
        let index = self.0.iter().position(|(stored, _)| stored == key)?;
        let candidates =
            select_candidates(&self.0[index].1, quality, exact_quality, true, timestamp)?;
        if let Some(entry) = self.0.remove(index) {
            self.0.push_back(entry);
        }
        Some(candidates)
    }

    fn remove(&mut self, key: &SourceKey) {
        self.0.retain(|(stored, _)| stored != key);
    }

    fn plans_mut(&mut self, key: &SourceKey) -> Option<&mut Vec<PlaybackPlan>> {
        self.0
            .iter_mut()
            .find(|(stored, _)| stored == key)
            .map(|(_, plans)| plans)
    }

    pub(super) fn insert(
        &mut self,
        key: SourceKey,
        mut plans: Vec<PlaybackPlan>,
        timestamp: u64,
        replace: bool,
    ) {
        self.0.retain_mut(|(stored, plans)| {
            plans.retain(|plan| source_fresh(plan.expires_at, timestamp));
            stored.generation == key.generation && !plans.is_empty()
        });
        plans.retain(|plan| source_fresh(plan.expires_at, timestamp));
        if plans.is_empty() || (!replace && self.plans_mut(&key).is_some()) {
            return;
        }
        self.remove(&key);
        self.0.push_back((key, plans));
        if self.0.len() > MAX_CACHED_INVENTORIES {
            self.0.pop_front();
        }
    }
}

impl YoutubeGateway {
    pub async fn metadata(&self, app: &tauri::AppHandle, item: &MediaItem) -> AppResult<MediaItem> {
        let plan = self.resolve(app, item, 1080).await?;
        Ok(plan.video)
    }

    pub async fn resolve(
        &self,
        app: &tauri::AppHandle,
        item: &MediaItem,
        quality: u32,
    ) -> AppResult<PlaybackPlan> {
        self.resolve_candidates(
            app,
            item,
            PlaybackSelection {
                generation: self.sessions.snapshot().generation,
                mode: "video",
                quality,
                exact_quality: false,
                force_refresh: false,
                prefer_hls: false,
            },
            None,
        )
        .await
        .map(|candidates| candidates.primary)
    }

    pub(crate) async fn resolve_candidates(
        &self,
        app: &tauri::AppHandle,
        item: &MediaItem,
        selection: PlaybackSelection<'_>,
        prefetch: Option<PrefetchLookup>,
    ) -> AppResult<PlaybackCandidates> {
        let PlaybackSelection {
            generation,
            mode,
            quality,
            exact_quality,
            force_refresh,
            prefer_hls,
        } = selection;
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        let request = self.begin("playback-source");
        if let Some(prefetch) = prefetch.filter(|_| !force_refresh) {
            let video =
                normalize_video_ref(&item.url).or_else(|_| normalize_video_ref(&item.id))?;
            let key = SourceKey::new(&video.video_id, generation, mode, prefer_hls);
            if let Some(candidates) = self.cached_candidates(&key, quality, exact_quality) {
                return Ok(candidates);
            }
            tracing::info!(video_id = %video.video_id, mode, "Playback joined queue source lookup");
            let result = tokio::select! {
                biased;
                _ = request.token.cancelled() => return Err(cancelled_lookup()),
                result = prefetch.completion() => result,
            };
            if let Err(error) = result {
                if matches!(
                    error.code.as_str(),
                    "unavailable"
                        | "live_unsupported"
                        | "private_video"
                        | "age_restricted"
                        | "sign_in_required"
                        | "session_expired"
                ) {
                    return Err(error);
                }
            }
        }
        let _resolution = tokio::select! {
            biased;
            _ = request.token.cancelled() => return Err(cancelled_lookup()),
            lock = self.resolving.lock() => lock,
        };
        self.resolve_source(
            app,
            item,
            ResolveOptions {
                generation,
                mode,
                quality,
                exact_quality,
                force_refresh,
                prefer_hls,
                persistent: true,
                cancellation: request.token.clone(),
            },
        )
        .await
    }

    pub(crate) fn pending_prefetch(
        &self,
        item: &MediaItem,
        generation: u64,
        mode: &str,
    ) -> Option<PrefetchLookup> {
        let video = normalize_video_ref(&item.url)
            .or_else(|_| normalize_video_ref(&item.id))
            .ok()?;
        self.pending_prefetches
            .attach(&SourceKey::background(&video.video_id, generation, mode))
    }

    pub(crate) fn start_prefetch(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        id: String,
        quality: u32,
        mode: String,
        generation: u64,
    ) -> PrefetchLookup {
        let key = SourceKey::background(&id, generation, &mode);
        let (lookup, work) = self.pending_prefetches.reserve(key);
        if let Some(work) = work {
            let gateway = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let cancellation = work.token();
                let result = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(cancelled_lookup()),
                    result = gateway.prefetch(&app, id, quality, &mode, generation, cancellation.clone()) => result,
                };
                work.finish(result);
            });
        }
        lookup
    }

    async fn prefetch(
        &self,
        app: &tauri::AppHandle,
        id: String,
        quality: u32,
        mode: &str,
        generation: u64,
        cancellation: CancellationToken,
    ) -> AppResult<bool> {
        let _prefetch = self.prefetching.lock().await;
        tracing::info!(video_id = %id, mode, "Queue source lookup started");
        #[cfg(debug_assertions)]
        if let Some(delay) = std::env::var("VIEWSICAL_TEST_PREFETCH_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|delay| (1..=5000).contains(delay))
        {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        let item = MediaItem {
            id,
            ..Default::default()
        };
        self.resolve_source(
            app,
            &item,
            ResolveOptions {
                generation,
                mode,
                quality,
                exact_quality: false,
                force_refresh: false,
                prefer_hls: false,
                persistent: false,
                cancellation,
            },
        )
        .await
        .map(|candidates| {
            candidates.primary.is_reusable()
                || candidates.alternate.is_some_and(|plan| plan.is_reusable())
        })
    }

    pub(crate) fn remember_working_source(&self, plan: &PlaybackPlan) {
        if plan.mode != "video" || !plan.is_reusable() {
            return;
        }
        let key = SourceKey::new(&plan.video.id, plan.session_generation, &plan.mode, false);
        let mut cache = self.sources.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(candidates) = cache.plans_mut(&key) {
            if let Some(index) = candidates
                .iter()
                .position(|candidate| candidate.same_source(plan))
            {
                let first = candidates[..=index]
                    .iter()
                    .position(|candidate| candidate.selected_quality == plan.selected_quality)
                    .unwrap_or(index);
                candidates[first..=index].rotate_right(1);
            }
        }
    }

    pub(crate) fn reject_source(&self, plan: &PlaybackPlan) {
        if plan.mode != "video" {
            return;
        }
        let key = SourceKey::new(&plan.video.id, plan.session_generation, &plan.mode, false);
        let mut cache = self.sources.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(plans) = cache.plans_mut(&key) {
            plans.retain(|candidate| !candidate.same_source(plan));
            if plans.is_empty() {
                cache.remove(&key);
            }
        }
    }

    fn cached_candidates(
        &self,
        key: &SourceKey,
        quality: u32,
        exact_quality: bool,
    ) -> Option<PlaybackCandidates> {
        let candidates = self.sources
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .lookup(key, quality, exact_quality, now())?;
        Some(self.with_current_storyboard(key, candidates))
    }

    fn with_current_storyboard(&self, key: &SourceKey, mut candidates: PlaybackCandidates) -> PlaybackCandidates {
        let board = self.cached_storyboard(&key.video_id, key.generation);
        candidates.primary.storyboard = board.clone();
        if let Some(alternate) = &mut candidates.alternate {
            alternate.storyboard = board;
        }
        candidates
    }

    async fn resolve_source(
        &self,
        app: &tauri::AppHandle,
        item: &MediaItem,
        options: ResolveOptions<'_>,
    ) -> AppResult<PlaybackCandidates> {
        let ResolveOptions {
            generation,
            mode,
            quality,
            exact_quality,
            force_refresh,
            prefer_hls,
            persistent,
            cancellation,
        } = options;
        if !matches!(mode, "video" | "audio") {
            return Err(AppError::new(
                "invalid_mode",
                "Choose video or audio-only playback.",
            ));
        }
        let video = normalize_video_ref(&item.url).or_else(|_| normalize_video_ref(&item.id))?;
        let key = SourceKey::new(&video.video_id, generation, mode, prefer_hls);
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if cancellation.is_cancelled() || self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new("cancelled", "The request was cancelled."));
        }
        if force_refresh {
            let mut cache = self.sources.lock().unwrap_or_else(|p| p.into_inner());
            if mode == "audio" {
                cache.remove(&key);
                cache.remove(&SourceKey::background(&video.video_id, generation, mode));
            }
        } else if let Some(candidates) = self.cached_candidates(&key, quality, exact_quality) {
            return Ok(candidates);
        }
        let url = canonical_video(&video.video_id);
        let mut args = vec![
            "--no-playlist".into(),
            "-f".into(),
            source_selector(mode, MAX_VIDEO_HEIGHT, prefer_hls),
        ];
        if mode == "video" {
            args.extend(["--simulate", "--format-sort-force", "-S", "height"].map(String::from));
        }
        let anonymous = self
            .run_extraction(
                app,
                &url,
                args.clone(),
                None,
                generation,
                cancellation.clone(),
                persistent,
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
                self.run_extraction(
                    app,
                    &url,
                    args,
                    cookies.as_ref(),
                    generation,
                    cancellation.clone(),
                    persistent,
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
        let timestamp = now();
        self.cache_captions(&video.video_id, generation, &json, false);
        self.cache_watch_details(&video.video_id, generation, &json);
        let (plans, lowest_expired_height) = if mode == "audio" {
            let mut plan = playback_from_json(&json, generation)?;
            plan.mode = mode.into();
            plan.selected_quality = 0;
            plan.audio_url = None;
            (vec![plan], None)
        } else {
            video_inventory_from_json(&json, generation, timestamp)?
        };
        let candidates = select_extracted(&plans, quality, timestamp, lowest_expired_height);
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if let Some(plan) = plans.first() {
            self.remember_timeline(
                &plan.video.id, generation, (plan.video.chapters.clone(), plan.storyboard.clone())
            );
        }
        let mut cache = self.sources.lock().unwrap_or_else(|p| p.into_inner());
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if cancellation.is_cancelled() || self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new("cancelled", "The request was cancelled."));
        }
        if key.prefer_hls {
            // Preserve the normal audio replay path after its HLS retry.
            cache.insert(
                SourceKey::background(&video.video_id, generation, mode),
                plans.clone(),
                timestamp,
                true,
            );
        }
        cache.insert(key.clone(), plans, timestamp, persistent);
        drop(cache);
        let candidates = self.with_current_storyboard(&key, candidates?);
        let plan = &candidates.primary;
        tracing::info!(video_id=%video.video_id, mode, protocol=%plan.protocol, format=%plan.format_id, separate_audio=plan.audio_url.is_some(), alternates=usize::from(candidates.alternate.is_some()),
            quality=plan.selected_quality, "Playback source selected");
        Ok(candidates)
    }
}

pub(super) fn source_selector(mode: &str, cap: u32, prefer_hls: bool) -> String {
    if mode == "audio" {
        return if prefer_hls {
            "ba[protocol^=m3u8]/ba[protocol=https]/ba"
        } else {
            "ba[protocol=https]/ba"
        }
        .into();
    }
    format!(
        "bv[protocol^=m3u8][height<={cap}]+ba[protocol^=m3u8],b[protocol^=m3u8][height<={cap}],\
         bv[protocol=https][height<={cap}]+ba[protocol=https],b[protocol=https][height<={cap}]"
    )
}

pub(super) fn source_fresh(expiry: Option<u64>, timestamp: u64) -> bool {
    expiry.is_some_and(|value| value > timestamp.saturating_add(60))
}

pub(super) fn source_expiry<'a>(urls: impl Iterator<Item = &'a str>) -> Option<u64> {
    let mut earliest: Option<u64> = None;
    for raw in urls {
        let url = url::Url::parse(raw).ok()?;
        let query = url
            .query_pairs()
            .filter(|(key, _)| key == "expire")
            .filter_map(|(_, value)| value.parse::<u64>().ok());
        // YouTube's HLS manifests carry the signature and expiry in paired
        // path segments rather than in the direct stream's query parameters.
        let segments = url.path_segments()?;
        let path = segments
            .clone()
            .zip(segments.skip(1))
            .filter(|(key, _)| *key == "expire")
            .filter_map(|(_, value)| value.parse::<u64>().ok());
        let expiry = query.chain(path).min()?;
        earliest = Some(earliest.map_or(expiry, |prior| prior.min(expiry)));
    }
    earliest
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

fn no_stream() -> AppError {
    AppError::new(
        "no_stream",
        "YouTube did not return a playable stream. Try another quality.",
    )
}

pub(super) fn cdn_url(value: &Value) -> AppResult<String> {
    let raw = value
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(no_stream)?;
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

pub(super) fn playback_from_json(json: &Value, generation: u64) -> AppResult<PlaybackPlan> {
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
    let metadata = PlaybackMetadata::new(json, generation)?;
    let mut plan =
        playback_from_components(&metadata, text(json, "format_id"), video, audio, json)?;
    plan.qualities = json["formats"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|format| {
            format["vcodec"]
                .as_str()
                .is_some_and(|codec| codec != "none")
        })
        .filter_map(|format| {
            format["height"]
                .as_u64()
                .and_then(|height| u32::try_from(height).ok())
        })
        .filter(|height| *height > 0)
        .collect();
    if plan.selected_quality > 0 {
        plan.qualities.push(plan.selected_quality);
    }
    plan.qualities
        .sort_unstable_by(|left, right| right.cmp(left));
    plan.qualities.dedup();
    Ok(plan)
}

#[cfg(test)]
pub(super) fn video_candidates_from_json(
    json: &Value,
    generation: u64,
    cap: u32,
    timestamp: u64,
) -> AppResult<Vec<PlaybackPlan>> {
    let (inventory, lowest_expired_height) =
        video_inventory_from_json(json, generation, timestamp)?;
    let selected = select_extracted(&inventory, cap, timestamp, lowest_expired_height)?;
    Ok(std::iter::once(selected.primary)
        .chain(selected.alternate)
        .collect())
}

fn select_candidates(
    inventory: &[PlaybackPlan],
    cap: u32,
    exact_quality: bool,
    cache_hit: bool,
    timestamp: u64,
) -> Option<PlaybackCandidates> {
    let cap = cap.clamp(144, MAX_VIDEO_HEIGHT);
    let mut eligible = inventory.iter().filter(|plan| {
        plan.selected_quality <= cap && (!cache_hit || source_fresh(plan.expires_at, timestamp))
    });
    let primary = eligible.next()?;
    if exact_quality && primary.mode == "video" && primary.selected_quality != cap {
        return None;
    }
    let alternate = eligible.find(|plan| {
        is_hls(&plan.protocol) != is_hls(&primary.protocol)
            && source_fresh(plan.expires_at, timestamp)
    });
    Some(PlaybackCandidates {
        primary: primary.clone(),
        alternate: alternate.cloned(),
        cache_hit,
    })
}

fn select_extracted(
    plans: &[PlaybackPlan],
    cap: u32,
    timestamp: u64,
    lowest_expired_height: Option<u32>,
) -> AppResult<PlaybackCandidates> {
    select_candidates(plans, cap, false, false, timestamp).ok_or_else(|| {
        if lowest_expired_height.is_some_and(|height| height <= cap.clamp(144, MAX_VIDEO_HEIGHT)) {
            expired_source()
        } else {
            no_stream()
        }
    })
}

pub(super) fn video_inventory_from_json(
    json: &Value,
    generation: u64,
    timestamp: u64,
) -> AppResult<(Vec<PlaybackPlan>, Option<u32>)> {
    let metadata = PlaybackMetadata::new(json, generation)?;
    let selected = json["requested_downloads"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let formats = json["formats"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut candidates: BTreeMap<(u32, bool), PlaybackPlan> = BTreeMap::new();
    let mut first_error = None;
    let mut lowest_expired_height: Option<u32> = None;
    let mut expired = |plan: &PlaybackPlan| {
        if !has_expired_component(plan, timestamp) {
            return false;
        }
        let height = plan.selected_quality;
        lowest_expired_height =
            Some(lowest_expired_height.map_or(height, |older| older.min(height)));
        true
    };
    for (index, overlay) in selected.iter().enumerate() {
        // yt-dlp strips fields shared with the original response from each
        // selection, and the top-level stream fields describe the last one.
        let selection = if index + 1 == selected.len()
            && overlay["format_id"].is_null()
            && overlay["requested_formats"].is_null()
            && overlay["url"].is_null()
        {
            json
        } else {
            overlay
        };
        match video_candidate(json, selection, &metadata) {
            Ok(plan) if expired(&plan) => {}
            Ok(plan) => {
                candidates
                    .entry((plan.selected_quality, is_hls(&plan.protocol)))
                    .or_insert(plan);
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }

    // yt-dlp provides formats in preference order, best last. Keep its
    // simulated selections where available and fill the other heights from
    // the same response, using compatible audio for each split source.
    let audio_tracks: Vec<_> = formats
        .iter()
        .rev()
        .filter(|format| is_audio_track(format))
        .filter_map(|format| Some((format, transport(format)?, safe_headers(format))))
        .collect();
    for video in formats.iter().rev() {
        let Some(key) = video_format_key(video) else {
            continue;
        };
        if candidates
            .get(&key)
            .is_some_and(|plan| plan.expires_at.is_some())
            || (candidates.len() == MAX_VARIANTS_PER_VIDEO
                && candidates
                    .first_key_value()
                    .is_some_and(|(lowest, _)| key < *lowest))
        {
            continue;
        }
        let mut save = |outcome: AppResult<PlaybackPlan>| match outcome {
            Ok(plan) if expired(&plan) => false,
            Ok(plan) => {
                let reusable = plan.expires_at.is_some();
                if reusable || !candidates.contains_key(&key) {
                    candidates.insert(key, plan);
                }
                if candidates.len() > MAX_VARIANTS_PER_VIDEO {
                    candidates.pop_first();
                }
                reusable
            }
            Err(error) => {
                first_error.get_or_insert(error);
                false
            }
        };
        if video["acodec"]
            .as_str()
            .is_some_and(|codec| !codec.is_empty() && codec != "none")
        {
            save(make_video_plan(&metadata, video, None, video, ""));
        } else {
            let headers = safe_headers(video);
            let mut audio = audio_tracks.iter().filter(|(_, hls, audio_headers)| {
                *hls == key.1
                    && (audio_headers.is_empty() || matching_headers(&headers, audio_headers))
            });
            audio.any(|(track, _, _)| {
                save(make_video_plan(&metadata, video, Some(track), video, ""))
            });
        }
    }
    if candidates.is_empty() {
        return Err(if lowest_expired_height.is_some() {
            expired_source()
        } else {
            first_error.unwrap_or_else(no_stream)
        });
    }
    let mut plans: Vec<_> = candidates
        .into_values()
        .rev()
        .take(MAX_VARIANTS_PER_VIDEO)
        .collect();
    let mut qualities: Vec<_> = plans.iter().map(|plan| plan.selected_quality).collect();
    qualities.dedup();
    for plan in &mut plans {
        plan.qualities.clone_from(&qualities);
    }
    Ok((plans, lowest_expired_height))
}

fn is_hls(protocol: &str) -> bool {
    protocol.starts_with("m3u8")
}

fn transport(format: &Value) -> Option<bool> {
    let protocol = format["protocol"].as_str()?;
    (protocol == "https" || is_hls(protocol)).then(|| is_hls(protocol))
}

fn video_format_key(format: &Value) -> Option<(u32, bool)> {
    if !format["vcodec"]
        .as_str()
        .is_some_and(|codec| codec != "none")
    {
        return None;
    }
    let height = format["height"].as_u64()?;
    (1..=u64::from(MAX_VIDEO_HEIGHT))
        .contains(&height)
        .then_some((height as u32, transport(format)?))
}

fn is_audio_track(format: &Value) -> bool {
    format["vcodec"].as_str() == Some("none") && format["acodec"].as_str() != Some("none")
}

fn selected_format<'a>(json: &'a Value, selected: &'a Value) -> &'a Value {
    let Some(id) = selected["format_id"].as_str() else {
        return selected;
    };
    // The full format supplies track-specific headers when the selection is
    // an overlay. Never inherit headers from a different top-level choice.
    json["formats"]
        .as_array()
        .and_then(|formats| {
            formats
                .iter()
                .find(|format| format["format_id"].as_str() == Some(id))
        })
        .unwrap_or(selected)
}

fn video_candidate(
    json: &Value,
    selected: &Value,
    metadata: &PlaybackMetadata,
) -> AppResult<PlaybackPlan> {
    let (video, audio) = if let Some(formats) = selected["requested_formats"].as_array() {
        let [first, second] = formats.as_slice() else {
            return Err(no_stream());
        };
        let (first, second) = (selected_format(json, first), selected_format(json, second));
        let (video, audio) = if first["vcodec"].as_str() == Some("none") {
            (second, first)
        } else {
            (first, second)
        };
        (video, Some(audio))
    } else {
        (selected_format(json, selected), None)
    };
    make_video_plan(
        metadata,
        video,
        audio,
        selected,
        selected["format_id"].as_str().unwrap_or_default(),
    )
}

fn make_video_plan(
    metadata: &PlaybackMetadata,
    video: &Value,
    audio: Option<&Value>,
    header_context: &Value,
    selected_id: &str,
) -> AppResult<PlaybackPlan> {
    let (_, hls) = video_format_key(video).ok_or_else(no_stream)?;
    if audio.is_some_and(|track| !is_audio_track(track) || transport(track) != Some(hls))
        || (audio.is_none() && video["acodec"].as_str() == Some("none"))
    {
        return Err(no_stream());
    }
    let mut format_id = selected_id.to_owned();
    if format_id.is_empty() {
        format_id = text(video, "format_id");
        if let Some(audio) = audio {
            format_id.push('+');
            format_id.push_str(&text(audio, "format_id"));
        }
    }
    let plan = playback_from_components(metadata, format_id, video, audio, header_context)?;
    if !plan.audio_headers.is_empty() && !matching_headers(&plan.audio_headers, &plan.headers) {
        return Err(AppError::new(
            "source_context",
            "These audio and video sources require different request contexts. Try another quality.",
        ));
    }
    Ok(plan)
}

fn has_expired_component(plan: &PlaybackPlan, timestamp: u64) -> bool {
    match plan.expires_at {
        Some(expiry) => !source_fresh(Some(expiry), timestamp),
        None => std::iter::once(plan.video_url.as_str())
            .chain(plan.audio_url.as_deref())
            .any(|url| {
                source_expiry(std::iter::once(url))
                    .is_some_and(|expiry| !source_fresh(Some(expiry), timestamp))
            }),
    }
}

fn expired_source() -> AppError {
    AppError::new(
        "source_expired",
        "The video sources expired before playback could start.",
    )
}

fn matching_headers(left: &[(String, String)], right: &[(String, String)]) -> bool {
    left.len() == right.len()
        && left.iter().all(|(key, value)| {
            right
                .iter()
                .any(|(other, equivalent)| key.eq_ignore_ascii_case(other) && value == equivalent)
        })
}

struct PlaybackMetadata {
    generation: u64,
    video: MediaItem,
    storyboard: Option<Storyboard>,
}

impl PlaybackMetadata {
    fn new(json: &Value, generation: u64) -> AppResult<Self> {
        let video = media_item(json).ok_or_else(|| {
            AppError::new(
                "provider_changed",
                "YouTube did not return valid video metadata.",
            )
        })?;
        let storyboard = video_storyboard(json, &video.id);
        Ok(Self {
            generation,
            video,
            storyboard,
        })
    }
}

fn playback_from_components(
    metadata: &PlaybackMetadata,
    format_id: String,
    video: &Value,
    audio: Option<&Value>,
    header_context: &Value,
) -> AppResult<PlaybackPlan> {
    let video_url = cdn_url(video)?;
    let audio_url = audio.map(cdn_url).transpose()?;
    let selected_quality = video.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    let headers = safe_headers(if video.get("http_headers").is_some() {
        video
    } else {
        header_context
    });
    let protocol = text(video, "protocol");
    let expires_at = source_expiry(std::iter::once(video_url.as_str()).chain(audio_url.as_deref()));
    let audio_headers = audio
        .map(|a| {
            safe_headers(if a.get("http_headers").is_some() {
                a
            } else {
                header_context
            })
        })
        .unwrap_or_default();
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
        qualities: Vec::new(),
        session_generation: metadata.generation,
        storyboard: metadata.storyboard.clone(),
        video: metadata.video.clone(),
    })
}
