//! Stable YouTube identity and trusted video/library URL normalization.
use crate::models::{AppError, AppResult, VideoRef};

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

pub(super) fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub(super) fn valid_playlist_id(id: &str) -> bool {
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

pub(super) fn safe_youtube_url(input: &str) -> AppResult<url::Url> {
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

pub(super) fn playlist_target(id: &str, original: Option<&str>) -> AppResult<String> {
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
