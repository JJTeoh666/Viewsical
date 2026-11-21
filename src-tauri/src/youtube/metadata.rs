//! Convert provider metadata into the app's stable media model.
use super::{
    canonical_video,
    identity::{playlist_target, valid_channel_id, valid_video_id},
};
use crate::models::{MediaItem, ReplayHeatSegment, Storyboard, VideoChapter};
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

pub(crate) fn video_chapters(value: &Value) -> Option<Vec<VideoChapter>> {
    let chapters = value.get("chapters")?.as_array()?;
    if chapters.len() > 256 {
        return None;
    }
    let duration = value
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(f64::MAX);
    let mut chapters: Vec<_> = chapters
        .iter()
        .filter_map(|chapter| {
            let start_time = chapter.get("start_time")?.as_f64()?;
            let end_time = chapter.get("end_time")?.as_f64()?.min(duration);
            let title = chapter.get("title")?.as_str()?.trim();
            (start_time >= 0. && end_time > start_time && !title.is_empty()).then(|| {
                VideoChapter {
                    start_time,
                    end_time,
                    title: title.chars().take(256).collect(),
                }
            })
        })
        .collect();
    chapters.sort_by(|a, b| a.start_time.total_cmp(&b.start_time));
    chapters.dedup_by(|a, b| a.start_time == b.start_time);
    for i in 1..chapters.len() {
        chapters[i - 1].end_time = chapters[i - 1].end_time.min(chapters[i].start_time);
    }
    (!chapters.is_empty()).then_some(chapters)
}

pub(super) fn video_storyboard(value: &Value, video_id: &str) -> Option<Storyboard> {
    let duration = value.get("duration")?.as_f64()?;
    if duration <= 0. {
        return None;
    }
    value
        .get("formats")?
        .as_array()?
        .iter()
        .filter_map(|format| storyboard_format(format, duration, video_id))
        .max_by_key(|board| (board.frame_count, board.width))
}

fn storyboard_format(format: &Value, duration: f64, video_id: &str) -> Option<Storyboard> {
    if format.get("protocol")?.as_str()? != "mhtml" {
        return None;
    }
    let dimension = |key, max| {
        let size = format.get(key)?.as_u64()?;
        (1..=max).contains(&size).then_some(size as u32)
    };
    let width = dimension("width", 320)?;
    let height = dimension("height", 320)?;
    let columns = dimension("columns", 16)?;
    let rows = dimension("rows", 16)?;
    if width * columns > 4096 || height * rows > 4096 {
        return None;
    }
    let frame_count = (format.get("fps")?.as_f64()? * duration).round();
    let frames_per_sheet = rows * columns;
    if !(1. ..=f64::from(frames_per_sheet * 1024)).contains(&frame_count) {
        return None;
    }
    let frame_count = frame_count as u32;
    let sheet_count = frame_count.div_ceil(frames_per_sheet) as usize;
    let fragments = format.get("fragments")?.as_array()?;
    let template = format.get("url")?.as_str()?;
    let url = url::Url::parse(template).ok()?;
    if fragments.len() != sheet_count
        || template.len() > 2048
        || url.scheme() != "https"
        || url.host_str() != Some("i.ytimg.com")
        || !url.path().starts_with(&format!("/sb/{video_id}/"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || (sheet_count > 1 && !template.contains("$M"))
    {
        return None;
    }
    for (index, fragment) in fragments.iter().enumerate() {
        if fragment.get("url")?.as_str()? != template.replace("$M", &index.to_string()) {
            return None;
        }
    }
    Some(Storyboard {
        url_template: url.into(),
        width,
        height,
        rows,
        columns,
        frame_count,
        frame_duration: format
            .get("viewsical_frame_interval")
            .and_then(Value::as_f64)
            .filter(|interval| *interval > 0. && *interval <= duration)
            .unwrap_or(duration / f64::from(frame_count)),
    })
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
        channel_id: video_channel_id(value).map(str::to_owned),
        thumbnail,
        url,
        duration: value.get("duration").and_then(Value::as_f64),
        view_count: value.get("view_count").and_then(Value::as_u64),
        playlist_index: value.get("playlist_index").and_then(Value::as_u64),
        youtube_loudness_db: crate::normalization::valid_loudness(
            value.get("viewsical_loudness_db").and_then(Value::as_f64),
        ),
        heatmap: replay_heatmap(value),
        chapters: video_chapters(value),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub(super) fn video_channel_id(value: &Value) -> Option<&str> {
    ["channel_id", "uploader_id"]
        .iter()
        .filter_map(|key| value.get(key)?.as_str())
        .find(|id| valid_channel_id(id))
}
