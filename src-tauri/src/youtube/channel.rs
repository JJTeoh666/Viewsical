use super::{identity::safe_youtube_url, valid_channel_id};
use crate::models::{AppError, AppResult, ChannelProfile};
use serde_json::Value;

pub(super) fn tab_name(kind: &str) -> Option<&'static str> {
    match kind {
        "channel-home" => Some("featured"),
        "channel" => Some("videos"),
        "channel-live" => Some("streams"),
        "channel-playlists" => Some("playlists"),
        _ => None,
    }
}

pub(super) fn tab_url(query: &str, tab: &str) -> AppResult<String> {
    let url = if valid_channel_id(query) {
        format!("https://www.youtube.com/channel/{query}")
    } else if query.starts_with('@') && !query.contains(['/', '?', '#', ' ']) {
        format!("https://www.youtube.com/{query}")
    } else {
        safe_youtube_url(query)?.to_string()
    };
    let mut parsed = safe_youtube_url(&url)?;
    let mut parts = parsed.path().trim_start_matches('/').split('/');
    let base = match parts.next() {
        Some(handle) if handle.starts_with('@') => format!("/{handle}"),
        Some(prefix @ ("channel" | "user" | "c")) => match parts.next() {
            Some(id) if !id.is_empty() => format!("/{prefix}/{id}"),
            _ => return Err(invalid_channel()),
        },
        _ => return Err(invalid_channel()),
    };
    parsed.set_path(&format!("{base}/{tab}"));
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.into())
}

fn invalid_channel() -> AppError {
    AppError::new("invalid_input", "Choose a valid YouTube channel.")
}

pub(super) fn profile(document: &Value) -> Option<ChannelProfile> {
    let string = |field: &str, limit| {
        document[field]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(limit).collect::<String>())
    };
    let id = document["channel_id"]
        .as_str()
        .filter(|id| valid_channel_id(id))?;
    let thumbnails = document["thumbnails"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let image = |banner: bool| {
        thumbnails
            .iter()
            .filter_map(|entry| {
                let url = safe_image(entry["url"].as_str()?)?;
                let width = entry["width"].as_u64().unwrap_or(0);
                let height = entry["height"].as_u64().unwrap_or(0);
                let preference = entry["preference"].as_i64().unwrap_or(0);
                let id = entry["id"].as_str();
                let is_banner = preference < 0 || (height > 0 && width / height >= 3);
                let is_avatar = id == Some("avatar_uncropped") || (width > 0 && width == height);
                (if banner {
                    is_banner
                } else {
                    is_avatar && !is_banner
                })
                .then_some((width, url))
            })
            .max_by_key(|(width, _)| *width)
            .map(|(_, url)| url)
    };
    Some(ChannelProfile {
        id: id.into(),
        title: string("channel", 256).or_else(|| string("uploader", 256))?,
        handle: string("uploader_id", 128).filter(|handle| handle.starts_with('@')),
        avatar: image(false),
        banner: image(true),
        description: string("description", 4096),
        subscriber_count: document["channel_follower_count"].as_u64(),
        video_count: document["viewsical_channel_video_count"].as_u64(),
        is_verified: document["channel_is_verified"].as_bool(),
    })
}

pub(super) fn safe_image(value: &str) -> Option<String> {
    if value.len() > 2048 {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str()?;
    let allowed = ["googleusercontent.com", "ggpht.com", "ytimg.com"]
        .iter()
        .any(|domain| {
            host == *domain
                || host
                    .strip_suffix(domain)
                    .is_some_and(|prefix| prefix.ends_with('.'))
        });
    (allowed
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none())
    .then(|| url.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profile_separates_safe_header_images_and_ignores_shelf_counts() {
        let document = json!({
            "channel_id": "UCyUZg_cPAg1-QjPHKJu20ZA",
            "channel": "Creator",
            "title": "Creator - Home",
            "uploader_id": "@creator",
            "channel_follower_count": 1240000,
            "playlist_count": 5,
            "thumbnails": [
                {"url": "https://yt3.googleusercontent.com/banner", "width": 1707, "height": 283, "preference": -10},
                {"url": "https://yt3.googleusercontent.com/banner-small", "width": 1060, "height": 175, "preference": -10},
                {"url": "https://yt3.ggpht.com/avatar", "width": 900, "height": 900},
                {"url": "https://ytimg.com.attacker.test/avatar", "width": 1000, "height": 1000}
            ]
        });
        let info = profile(&document).unwrap();
        assert_eq!(info.title, "Creator");
        assert_eq!(info.handle.as_deref(), Some("@creator"));
        assert_eq!(info.avatar.as_deref(), Some("https://yt3.ggpht.com/avatar"));
        assert_eq!(
            info.banner.as_deref(),
            Some("https://yt3.googleusercontent.com/banner")
        );
        assert_eq!(info.subscriber_count, Some(1_240_000));
        assert_eq!(info.video_count, None);
    }
}
