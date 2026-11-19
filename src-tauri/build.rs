fn main() {
    println!("cargo:rerun-if-changed=icons");

    let manifest = tauri_build::AppManifest::new().commands(&[
        "bootstrap",
        "save_settings",
        "clear_history",
        "reveal_download",
        "open_sign_in",
        "complete_sign_in",
        "sign_out",
        "session_state",
        "browse",
        "cancel_browse",
        "video_comments",
        "cancel_comments",
        "cache_summary",
        "cache_configure",
        "cache_clear",
        "set_playback_mode",
        "player_ui_context",
        "player_queue_prefetch",
        "play_video",
        "play_local",
        "player_action",
        "player_bounds",
        "player_state",
        "enqueue_download",
        "download_action",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Could not build TubeDesk permissions");
}
