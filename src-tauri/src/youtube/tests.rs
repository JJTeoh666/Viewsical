use super::{
    browse::{browse_target, decode_cursor, encode_cursor},
    identity::playlist_target,
    playback::{cdn_url, playback_from_json, source_expiry, source_fresh, source_selector},
};
use super::{canonical_video, classify_error, ensure_generation, media_item, normalize_video_ref};
use crate::models::MediaItem;
#[test]
fn loudness_metadata_survives_stable_media_storage() {
    let item = media_item(&serde_json::json!({
        "id":"dQw4w9WgXcQ", "title":"Fixture", "viewsical_loudness_db":6.0,
    }))
    .unwrap();
    assert_eq!(item.youtube_loudness_db, Some(6.));
    let restored: MediaItem = serde_json::from_str(&serde_json::to_string(&item).unwrap()).unwrap();
    assert_eq!(restored.youtube_loudness_db, Some(6.));
    let legacy = media_item(&serde_json::json!({"id":"dQw4w9WgXcQ"})).unwrap();
    assert_eq!(legacy.youtube_loudness_db, None);
    let invalid =
        media_item(&serde_json::json!({"id":"dQw4w9WgXcQ","viewsical_loudness_db":101})).unwrap();
    assert_eq!(invalid.youtube_loudness_db, None);
}
use serde_json::json;
#[test]
fn playback_heatmap_preserves_valid_normalized_replay_segments() {
    let response = json!({
        "id":"dQw4w9WgXcQ", "url":"https://rr.googlevideo.com/a?expire=500",
        "vcodec":"none", "acodec":"opus", "protocol":"https",
        "heatmap":[
            {"start_time":2.14, "end_time":4.28, "value":0.42},
            {"start_time":9.0, "end_time":10.0, "value":1.5},
            {"start_time":4.5, "end_time":3.0, "value":0.8},
            {"start_time":0.0, "end_time":2.14, "value":1.0},
            {"start_time":-1.0, "end_time":1.0, "value":0.7}
        ]
    });
    let video = playback_from_json(&response, 1).unwrap().video;
    let serialized = serde_json::to_value(&video).unwrap();
    assert_eq!(
        serialized["heatmap"],
        json!([
            {"startTime":0.0, "endTime":2.14, "value":1.0},
            {"startTime":2.14, "endTime":4.28, "value":0.42}
        ])
    );
    let restored: MediaItem = serde_json::from_value(serialized).unwrap();
    assert_eq!(restored.heatmap, video.heatmap);
    let legacy = serde_json::to_value(media_item(&json!({"id":"dQw4w9WgXcQ"})).unwrap()).unwrap();
    assert!(legacy.get("heatmap").is_none());
    assert!(serde_json::from_value::<MediaItem>(legacy)
        .unwrap()
        .heatmap
        .is_none());
}

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
    assert!(normalize_video_ref("https://youtube.com.attacker.test/watch?v=BaW_jenozKc").is_err());
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
    assert!(source_selector("video", 1080, false).starts_with("bv[protocol=https][height<=1080]"));
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
