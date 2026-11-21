//! Subtitle metadata reuses the playback extraction. Only a selected track is downloaded.
use super::{ensure_generation, gateway::YoutubeGateway};
use crate::{
    downloads::ProcessJob,
    models::{AppError, AppResult, SubtitleTrack},
    runtime::now,
};
use serde_json::Value;
use std::{collections::VecDeque, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

const CAPTION_TTL: u64 = 10 * 60;
const MAX_CAPTION_BYTES: usize = 4 * 1024 * 1024;
const CAPTION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
struct CaptionSource {
    track: SubtitleTrack,
    url: Url,
    expires_at: u64,
}

struct Catalog {
    video_id: String,
    generation: u64,
    expires_at: u64,
    tracks: Vec<CaptionSource>,
}

#[derive(Default)]
pub(super) struct CaptionCache(VecDeque<Catalog>);

impl CaptionCache {
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }

    fn get(&self, video_id: &str, generation: u64) -> Option<Vec<CaptionSource>> {
        let timestamp = now();
        self.0
            .iter()
            .find(|entry| {
                entry.video_id == video_id
                    && entry.generation == generation
                    && entry.expires_at > timestamp
            })
            .map(|entry| entry.tracks.clone())
    }

    fn insert(&mut self, video_id: &str, generation: u64, tracks: Vec<CaptionSource>) {
        let timestamp = now();
        let expires_at = tracks
            .iter()
            .map(|source| source.expires_at)
            .min()
            .unwrap_or(timestamp + CAPTION_TTL);
        self.0.retain(|entry| {
            entry.generation == generation
                && entry.expires_at > timestamp
                && entry.video_id != video_id
        });
        self.0.push_back(Catalog {
            video_id: video_id.into(),
            generation,
            expires_at,
            tracks,
        });
        while self.0.len() > 32 {
            self.0.pop_front();
        }
    }
}

fn provider_track(value: &Value, video_id: &str, timestamp: u64) -> Option<(Url, u64)> {
    if value["ext"] != "vtt" {
        return None;
    }
    let raw = value["url"].as_str().filter(|url| url.len() <= 4096)?;
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.youtube.com")
        || url.path() != "/api/timedtext"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut video_matches = false;
    let mut vtt = false;
    let mut expiry = timestamp + CAPTION_TTL;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "tlang" => return None, // List source tracks without synthetic translations.
            "v" => video_matches = value == video_id,
            "fmt" => vtt = value == "vtt",
            "expire" => expiry = expiry.min(value.parse::<u64>().ok()?.saturating_sub(30)),
            _ => {}
        }
    }
    (video_matches && vtt && expiry > timestamp).then_some((url, expiry))
}

fn source_tracks(json: &Value, video_id: &str, timestamp: u64) -> Vec<CaptionSource> {
    let mut result: Vec<CaptionSource> = Vec::new();
    for (field, automatic) in [("subtitles", false), ("automatic_captions", true)] {
        let Some(languages) = json[field].as_object() else {
            continue;
        };
        for (code, formats) in languages {
            let language = if automatic {
                code.strip_suffix("-orig").unwrap_or(code)
            } else {
                code
            };
            if language.is_empty()
                || language.len() > 32
                || !language
                    .bytes()
                    .all(|letter| letter.is_ascii_alphanumeric() || letter == b'-')
            {
                continue;
            }
            let Some((format, url, expires_at)) =
                formats.as_array().into_iter().flatten().find_map(|format| {
                    provider_track(format, video_id, timestamp)
                        .map(|(url, expires)| (format, url, expires))
                })
            else {
                continue;
            };
            let id = format!("{}:{language}", if automatic { "auto" } else { "manual" });
            if result.iter().any(|source| source.track.id == id) {
                continue;
            }
            let label = format["name"]
                .as_str()
                .map(|name| {
                    if automatic {
                        name.strip_suffix(" (Original)").unwrap_or(name)
                    } else {
                        name
                    }
                })
                .map(str::trim)
                .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
                .unwrap_or(language)
                .chars()
                .take(100)
                .collect();
            result.push(CaptionSource {
                track: SubtitleTrack {
                    id,
                    label,
                    language: language.into(),
                    automatic,
                },
                url,
                expires_at,
            });
            if result.len() >= 64 {
                return result;
            }
        }
    }
    result.sort_by(|a, b| {
        (a.track.automatic, a.track.label.to_lowercase())
            .cmp(&(b.track.automatic, b.track.label.to_lowercase()))
    });
    result
}

fn cancelled() -> AppError {
    AppError::new("cancelled", "Subtitle request cancelled.")
}

fn download_failed() -> AppError {
    AppError::new(
        "subtitle_download",
        "Couldn’t download those subtitles. Try again.",
    )
}

impl YoutubeGateway {
    pub(super) fn cache_captions(
        &self,
        video_id: &str,
        generation: u64,
        json: &Value,
        allow_empty: bool,
    ) {
        if json["id"].as_str() != Some(video_id) {
            return;
        }
        let tracks = source_tracks(json, video_id, now());
        let mut cache = self.captions.lock().unwrap_or_else(|p| p.into_inner());
        if self.sessions.snapshot().generation == generation && (allow_empty || !tracks.is_empty())
        {
            cache.insert(video_id, generation, tracks);
        }
    }

    async fn caption_sources(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        generation: u64,
    ) -> AppResult<Vec<CaptionSource>> {
        let _lookup = self.watch_metadata_lookup.lock().await;
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        let cached = || {
            self.captions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(video_id, generation)
        };
        if let Some(tracks) = cached() {
            return Ok(tracks);
        }

        self.fetch_watch_metadata(app, video_id, generation, "playback-watch-metadata").await?;
        Ok(cached().unwrap_or_default())
    }

    pub(crate) async fn subtitle_tracks(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        generation: u64,
    ) -> AppResult<Vec<SubtitleTrack>> {
        Ok(self
            .caption_sources(app, video_id, generation)
            .await?
            .into_iter()
            .map(|source| source.track)
            .collect())
    }

    pub(crate) async fn download_subtitle(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        generation: u64,
        track_id: &str,
    ) -> AppResult<(SubtitleTrack, Vec<u8>)> {
        let source = self
            .caption_sources(app, video_id, generation)
            .await?
            .into_iter()
            .find(|source| source.track.id == track_id)
            .ok_or_else(|| {
                AppError::new(
                    "subtitle_track",
                    "That subtitle track is no longer available.",
                )
            })?;
        let request = self.begin("playback-caption-download");
        let download = self.read_subtitle(app, &source.url);
        let result = tokio::select! {
            biased;
            _ = request.token.cancelled() => return Err(cancelled()),
            result = tokio::time::timeout(CAPTION_TIMEOUT, download) => {
                result.unwrap_or_else(|_| Err(download_failed()))
            }
        };
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        let bytes = result.map_err(|error| {
            // The next attempt can obtain a new signed track URL.
            self.captions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .0
                .retain(|entry| entry.video_id != video_id || entry.generation != generation);
            error
        })?;
        Ok((source.track, bytes))
    }

    async fn read_subtitle(&self, app: &tauri::AppHandle, url: &Url) -> AppResult<Vec<u8>> {
        let mut command = self.tools.youtube_python()?;
        command
            .arg(self.tools.youtube_plugins(app)?.join("caption_download.py"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| download_failed())?;
        let _job = ProcessJob::attach(&child)?;
        let mut stdin = child.stdin.take().ok_or_else(download_failed)?;
        stdin
            .write_all(url.as_str().as_bytes())
            .await
            .map_err(|_| download_failed())?;
        drop(stdin);
        let mut output = child
            .stdout
            .take()
            .ok_or_else(download_failed)?
            .take((MAX_CAPTION_BYTES + 1) as u64);
        let mut bytes = Vec::new();
        output
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| download_failed())?;
        if !valid_vtt(&bytes) || !child.wait().await.map_err(|_| download_failed())?.success() {
            return Err(download_failed());
        }
        Ok(bytes)
    }
}

fn valid_vtt(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_CAPTION_BYTES
        && std::str::from_utf8(bytes).is_ok_and(|text| {
            text.trim_start_matches('\u{feff}')
                .lines()
                .next()
                .is_some_and(|header| {
                    header == "WEBVTT"
                        || header.starts_with("WEBVTT ")
                        || header.starts_with("WEBVTT\t")
                })
                && !text.contains('\0')
                && text.contains(" --> ")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subtitle_metadata_keeps_manual_and_distinct_original_automatic_tracks() {
        let id = "dQw4w9WgXcQ";
        let source = |query: &str, name: &str| {
            json!({
                "ext": "vtt", "name": name,
                "url": format!("https://www.youtube.com/api/timedtext?v={id}&fmt=vtt&expire=3600{query}")
            })
        };
        let parsed = source_tracks(
            &json!({
                "subtitles": {
                    "en": [source("&lang=en", "English")],
                    "evil": [{"ext":"vtt","url":"https://attacker.invalid/api/timedtext?v=dQw4w9WgXcQ&fmt=vtt"}],
                    "wrong": [{"ext":"vtt","url":"https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&fmt=vtt"}]
                },
                "automatic_captions": {
                    "en": [source("&lang=en&kind=asr", "English")],
                    "en-orig": [source("&lang=en&kind=asr", "English (Original)")],
                    "fr": [source("&lang=en&tlang=fr", "French")]
                }
            }),
            id,
            1200,
        );
        assert_eq!(
            parsed
                .iter()
                .map(|entry| entry.track.id.as_str())
                .collect::<Vec<_>>(),
            ["manual:en", "auto:en"]
        );
        assert_eq!(parsed[1].track.label, "English");
        assert_eq!(parsed[0].expires_at, 1800);
    }

    #[test]
    fn subtitles_require_cues_and_a_valid_vtt_header() {
        assert!(valid_vtt(
            b"WEBVTT\r\n\r\n00:00.000 --> 00:02.000\r\nHello\r\n"
        ));
        assert!(!valid_vtt(b"WEBVTT\n\n"));
        assert!(!valid_vtt(b"<html>00:00.000 --> 00:02.000</html>"));
    }
}
