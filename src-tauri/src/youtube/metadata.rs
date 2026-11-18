//! Convert provider metadata into the app's stable media model.
use super::{
    canonical_video,
    identity::{playlist_target, valid_video_id},
};
use crate::models::{MediaItem, ReplayHeatSegment};
use serde_json::Value;

pub(super) fn text(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(crate) fn replay_heatmap(value: &Value) -> Option<Vec<ReplayHeatSegment>> {
    let markers = value.get("heatmap")?.as_array()?;
    // yt-dlp normally exposes 100 markers. Keep metadata bounded for storage and player IPC.
    if markers.len() > 256 {
        return None;
    }
    let mut segments: Vec<_> = markers
        .iter()
        .filter_map(|marker| {
            let start_time = marker.get("start_time")?.as_f64()?;
            let end_time = marker.get("end_time")?.as_f64()?;
            let value = marker.get("value")?.as_f64()?;
            (start_time >= 0.
                && end_time.is_finite()
                && end_time > start_time
                && (0. ..=1.).contains(&value))
            .then_some(ReplayHeatSegment {
                start_time,
                end_time,
                value,
            })
        })
        .collect();
    segments.sort_by(|a, b| a.start_time.total_cmp(&b.start_time));
    (!segments.is_empty()).then_some(segments)
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
        heatmap: replay_heatmap(value),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}
