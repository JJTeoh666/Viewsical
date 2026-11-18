//! Stream selection, session-bound source reuse, and playback plan parsing.
use super::{
    canonical_video, ensure_generation, gateway::YoutubeGateway, media_item, metadata::text,
    normalize_video_ref,
};
use crate::{
    models::{AppError, AppResult, MediaItem},
    runtime::now,
};
use serde_json::Value;
use std::sync::atomic::Ordering;

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

pub(super) fn source_fresh(expiry: Option<u64>, timestamp: u64) -> bool {
    expiry.is_some_and(|value| value > timestamp.saturating_add(60))
}

pub(super) fn source_expiry<'a>(urls: impl Iterator<Item = &'a str>) -> Option<u64> {
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

pub(super) fn cdn_url(value: &Value) -> AppResult<String> {
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
