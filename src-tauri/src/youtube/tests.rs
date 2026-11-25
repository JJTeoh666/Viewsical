use super::{
    browse::{browse_target, decode_cursor, encode_cursor},
    identity::playlist_target,
    playback::{
        cdn_url, playback_from_json, source_expiry, source_fresh, source_selector,
        video_candidates_from_json, video_inventory_from_json, SourceCache, SourceKey,
    },
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
fn timeline_extracts_chapters_and_keeps_storyboard_urls_out_of_saved_media() {
    let response = json!({
        "id":"dQw4w9WgXcQ", "duration":39, "url":"https://rr.googlevideo.com/a?expire=500",
        "vcodec":"none", "acodec":"opus", "protocol":"https",
        "chapters":[
            {"start_time":14.5, "end_time":45, "title":" Main section "},
            {"start_time":0, "end_time":18, "title":"Intro"},
            {"start_time":39, "end_time":40, "title":"Past the end"},
            {"start_time":8, "end_time":11, "title":" "}
        ],
        "formats":[{
            "protocol":"mhtml", "width":160, "height":90, "rows":2, "columns":2,
            "fps":8.0/39.0, "viewsical_frame_interval":5.0,
            "url":"https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg?sigh=fixture",
            "fragments":[
                {"url":"https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M0.jpg?sigh=fixture"},
                {"url":"https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M1.jpg?sigh=fixture"}
            ]
        }]
    });
    let plan = playback_from_json(&response, 1).unwrap();
    let board = plan.storyboard.unwrap();
    assert_eq!((board.frame_count, board.frame_duration), (8, 5.0));
    assert!(board.url_template.contains("M$M.jpg"));
    let saved = serde_json::to_value(&plan.video).unwrap();
    assert!(!saved.to_string().contains("sigh"));
    assert_eq!(
        saved["chapters"],
        json!([
            {"startTime":0.0, "endTime":14.5, "title":"Intro"},
            {"startTime":14.5, "endTime":39.0, "title":"Main section"}
        ])
    );
    assert_eq!(
        serde_json::from_value::<MediaItem>(saved).unwrap().chapters,
        plan.video.chapters
    );
    let legacy = serde_json::to_value(media_item(&json!({"id":"dQw4w9WgXcQ"})).unwrap()).unwrap();
    assert!(serde_json::from_value::<MediaItem>(legacy)
        .unwrap()
        .chapters
        .is_none());

    for (field, bad_value) in [
        (
            "url",
            json!("https://i.ytimg.com.other.test/sb/dQw4w9WgXcQ/M$M.jpg"),
        ),
        ("rows", json!(0)),
        ("fps", json!(500)),
        (
            "fragments",
            json!([{"url":"https://i.ytimg.com/sb/dQw4w9WgXcQ/M0.jpg"}]),
        ),
    ] {
        let mut invalid = response.clone();
        invalid["formats"][0][field] = bad_value;
        assert!(
            playback_from_json(&invalid, 1)
                .unwrap()
                .storyboard
                .is_none(),
            "{field}"
        );
    }
    let mut without_interval = response;
    without_interval["formats"][0]["viewsical_frame_interval"] = json!(null);
    assert_eq!(
        playback_from_json(&without_interval, 1)
            .unwrap()
            .storyboard
            .unwrap()
            .frame_duration,
        39.0 / 8.0
    );
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
    for (kind, tab) in [("channel-home", "featured"), ("channel-live", "streams"), ("channel-playlists", "playlists")] {
        assert_eq!(
            browse_target(kind, "https://www.youtube.com/@rustlang/videos?si=tracking", 25).unwrap(),
            format!("https://www.youtube.com/@rustlang/{tab}")
        );
    }
    assert!(browse_target("channel-live", "https://attacker.test/@rustlang", 25).is_err());
    assert_eq!(classify_error("This channel does not have a streams tab").code, "channel_tab_missing");
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
fn reconstructs_seeded_mix_links_from_browse_cards_and_pasted_urls() {
    for id in ["RDfzQ6gRAEoy0", "RDMMfzQ6gRAEoy0", "RDAMVMfzQ6gRAEoy0"] {
        let playlist_url = format!("https://www.youtube.com/playlist?list={id}");
        let expected = format!("https://www.youtube.com/watch?v=fzQ6gRAEoy0&list={id}");
        let item = media_item(&json!({"id":id,"title":"Mix","url":playlist_url})).unwrap();
        assert_eq!(item.url, expected);
        assert_eq!(browse_target("playlist", &playlist_url, 25).unwrap(), expected);
    }
    let expected = "https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM";
    let item = media_item(&json!({
        "id":"RDMM","title":"Mix",
        "webpage_url":"https://www.youtube.com/playlist?list=RDMM",
        "url":"https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDMM",
    })).unwrap();
    assert_eq!(item.url, expected);
    assert_eq!(
        browse_target("playlist", "https://youtu.be/fzQ6gRAEoy0?list=RDMM&si=tracking", 25).unwrap(),
        expected
    );
    assert_eq!(
        playlist_target("RDMM", Some("https://www.youtube.com/watch?v=fzQ6gRAEoy0&list=RDother")).unwrap(),
        "https://www.youtube.com/playlist?list=RDMM"
    );
    assert_eq!(
        browse_target("playlist", "RDCLAK5uy_Fixture_Without_Seed", 25).unwrap(),
        "https://www.youtube.com/playlist?list=RDCLAK5uy_Fixture_Without_Seed"
    );
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
                "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/350/video?expire=400",
                "https://rr.googlevideo.com/a?expire=500",
            ]
            .into_iter()
        ),
        Some(350)
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
fn video_requests_both_transports_and_audio_keeps_its_own_selector() {
    assert_eq!(
        source_selector("video", 1080, false),
        "bv[protocol^=m3u8][height<=1080]+ba[protocol^=m3u8],b[protocol^=m3u8][height<=1080],\
         bv[protocol=https][height<=1080]+ba[protocol=https],b[protocol=https][height<=1080]"
    );
    assert!(source_selector("audio", 720, true).starts_with("ba[protocol^=m3u8]"));
    assert_eq!(
        source_selector("audio", 1080, false),
        "ba[protocol=https]/ba"
    );
    let plan=playback_from_json(&json!({"id":"fzQ6gRAEoy0","title":"Audio","url":"https://rr.googlevideo.com/a?expire=500","vcodec":"none","acodec":"opus","protocol":"https"}),3).unwrap();
    assert_eq!(plan.selected_quality, 0);
    assert!(plan.audio_url.is_none());
}

fn candidate_fixture() -> serde_json::Value {
    json!({
        "id":"fzQ6gRAEoy0", "title":"Candidate fixture", "format_id":"18",
        "url":"https://rr.googlevideo.com/direct?expire=550",
        "http_headers":{"User-Agent":"root-selected-direct"},
        "formats":[
            {"format_id":"617", "url":"https://manifest.googlevideo.com/expire/500/video",
                "protocol":"m3u8_native", "vcodec":"vp9", "acodec":"none", "height":1080,
                "http_headers":{"User-Agent":"hls", "Cookie":"secret"}},
            {"format_id":"234", "url":"https://manifest.googlevideo.com/expire/450/audio",
                "protocol":"m3u8_native", "vcodec":"none", "http_headers":{"user-agent":"hls"}},
            {"format_id":"18", "url":"https://rr.googlevideo.com/direct?expire=550",
                "protocol":"https", "vcodec":"avc1", "acodec":"aac", "height":1080,
                "http_headers":{"User-Agent":"direct"}},
            {"format_id":"hls-mux", "url":"https://manifest.googlevideo.com/expire/510/muxed",
                "protocol":"m3u8_native", "vcodec":"avc1", "acodec":"aac", "height":720}
        ],
        "requested_downloads":[
            {"requested_formats":[{"format_id":"617"},{"format_id":"234"}]},
            {"format_id":"hls-mux"},
            {"format_id":"18"}
        ]
    })
}

#[test]
fn simulated_video_selections_keep_exact_tracks_and_prefer_hls_at_equal_height() {
    let response = candidate_fixture();
    let plans = video_candidates_from_json(&response, 7, 1080, 0).unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(plans[0].selected_quality, 1080);
    assert_eq!(plans[0].format_id, "617+234");
    assert_eq!(plans[0].protocol, "m3u8_native");
    assert_eq!(plans[0].expires_at, Some(450));
    assert_eq!(plans[0].headers, vec![("User-Agent".into(), "hls".into())]);
    assert_eq!(
        plans[0].audio_headers,
        vec![("user-agent".into(), "hls".into())]
    );
    assert_eq!(plans[1].protocol, "https");
    assert!(plans[1].audio_url.is_none());
    assert_eq!(
        plans[1].headers,
        vec![("User-Agent".into(), "direct".into())]
    );
}

#[test]
fn video_quality_precedes_transport_and_unsafe_pairs_are_skipped() {
    let mut response = candidate_fixture();
    response["formats"][0]["height"] = json!(720);
    let plans = video_candidates_from_json(&response, 7, 1080, 0).unwrap();
    assert_eq!(
        (plans[0].selected_quality, plans[0].protocol.as_str()),
        (1080, "https")
    );
    let plans = video_candidates_from_json(&response, 7, 720, 0).unwrap();
    assert_eq!(
        (plans[0].selected_quality, plans[0].protocol.as_str()),
        (720, "m3u8_native")
    );
    assert_eq!(plans.len(), 1);

    response["formats"][1]["http_headers"] = json!({"User-Agent":"different audio context"});
    let plans = video_candidates_from_json(&response, 7, 1080, 0).unwrap();
    assert_eq!(plans[1].format_id, "hls-mux");
    response["formats"][3]["url"] = json!("https://invalid.test/expire/900");
    let plans = video_candidates_from_json(&response, 7, 1080, 0).unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].protocol, "https");
}

#[test]
fn expired_selections_never_outrank_a_fresh_candidate() {
    let mut response = candidate_fixture();
    let plans = video_candidates_from_json(&response, 7, 1080, 460).unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].protocol, "https");
    assert_eq!(
        video_candidates_from_json(&response, 7, 720, 460)
            .unwrap_err()
            .code,
        "source_expired"
    );
    assert_eq!(
        video_candidates_from_json(&response, 7, 1080, 490)
            .unwrap_err()
            .code,
        "source_expired"
    );

    response["formats"][2]["url"] = json!("https://rr.googlevideo.com/direct");
    let plans = video_candidates_from_json(&response, 7, 1080, 490).unwrap();
    assert_eq!(plans[0].protocol, "https");
    assert!(!plans[0].is_reusable());
}

#[test]
fn one_quality_inventory_supplies_both_caps_in_the_same_session_and_mode() {
    let mut response = candidate_fixture();
    response["requested_downloads"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    let key = SourceKey::background("fzQ6gRAEoy0", 7, "video");
    let (inventory, _) = video_inventory_from_json(&response, 7, 0).unwrap();
    let mut cache = SourceCache::default();
    cache.insert(key.clone(), inventory, 0, true);

    for height in [1080, 720, 1080] {
        let selection = cache.lookup(&key, height, true, 0).unwrap();
        assert_eq!(selection.primary.selected_quality, height);
        assert_eq!(selection.primary.qualities, vec![1080, 720]);
    }
    assert!(cache.lookup(&key, 900, true, 0).is_none());
    assert_eq!(
        cache
            .lookup(&key, 900, false, 0)
            .unwrap()
            .primary
            .selected_quality,
        720
    );
    // The 720p URL is within the expiry margin but 1080p direct is still usable.
    assert!(cache.lookup(&key, 720, true, 450).is_none());
    assert_eq!(
        cache
            .lookup(&key, 1080, true, 450)
            .unwrap()
            .primary
            .protocol,
        "https"
    );
    for other in [
        SourceKey::background("fzQ6gRAEoy0", 8, "video"),
        SourceKey::background("fzQ6gRAEoy0", 7, "audio"),
    ] {
        assert!(cache.lookup(&other, 1080, false, 0).is_none());
    }
}

#[test]
fn unknown_audio_expiry_does_not_make_expired_video_usable() {
    let mut response = candidate_fixture();
    response["formats"][1]["url"] = json!("https://manifest.googlevideo.com/audio");
    let plans = video_candidates_from_json(&response, 7, 1080, 440).unwrap();
    assert_eq!(plans[0].format_id, "18");
    assert!(plans.iter().all(|plan| plan.format_id != "617+234"));
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
