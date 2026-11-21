mod comments;
mod display_awake;
mod downloads;
mod media_cache;
mod models;
mod normalization;
mod overlay;
mod player;
mod player_geometry;
mod runtime;
mod session;
mod store;
mod tray;
#[cfg(windows)]
mod video_renderer;
#[cfg(windows)]
#[doc(hidden)]
pub use video_renderer::run_video_renderer;
mod window_state;
mod video_surface;
mod youtube;

use downloads::DownloadManager;
use media_cache::MediaCache;
use models::*;
use player::PlayerManager;
use runtime::{AppPaths, ToolPaths};
use serde::Serialize;
use session::SessionManager;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use store::Store;
use tauri::{Listener, Manager};
use youtube::YoutubeGateway;

pub struct AppState {
    pub store: Arc<Store>,
    pub sessions: Arc<SessionManager>,
    pub gateway: Arc<YoutubeGateway>,
    pub player: Arc<PlayerManager>,
    pub downloads: Arc<DownloadManager>,
    pub cache: Arc<MediaCache>,
    pub tools: Arc<ToolPaths>,
    pub paths: AppPaths,
}

#[derive(Default)]
struct ShutdownSignals {
    started: AtomicBool,
    finished: AtomicBool,
}
impl ShutdownSignals {
    fn try_start(&self) -> bool {
        self.started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

/// All quit routes enter this one bounded, idempotent drain.
fn request_shutdown(handle: &tauri::AppHandle) {
    let signals = handle.state::<ShutdownSignals>();
    if !signals.try_start() {
        return;
    }
    window_state::remember(handle);
    tray::hide_icon(handle);
    overlay::shutdown(handle);
    let Some(state) = handle.try_state::<AppState>() else {
        signals.finished.store(true, Ordering::SeqCst);
        handle.exit(0);
        return;
    };
    state.sessions.begin_shutdown();
    state.gateway.begin_shutdown();
    state.downloads.begin_shutdown();
    state.player.begin_shutdown();
    state.cache.begin_shutdown();
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.hide();
    }
    tracing::info!("Viewsical shutdown started");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let cleanup = async {
            tokio::join!(
                state.downloads.shutdown(),
                state.player.shutdown(&handle),
                state.cache.shutdown(),
                state.gateway.shutdown_worker()
            );
            if let Err(error) = state.sessions.shutdown(&handle).await {
                tracing::warn!(category=%error.code,"Remembered sign-in could not be refreshed during shutdown");
            }
        };
        if tokio::time::timeout_at(deadline, cleanup).await.is_err() {
            tracing::warn!("Viewsical shutdown reached its cleanup deadline");
        }
        // destroy() bypasses the auth window's ordinary hide-on-close handler.
        // Never clear the persistent profile here: closing is not signing out.
        state.sessions.destroy_native_window(&handle);
        for (_, window) in handle.webview_windows() {
            let _ = window.destroy();
        }
        handle
            .state::<ShutdownSignals>()
            .finished
            .store(true, Ordering::SeqCst);
        tracing::info!("Viewsical shutdown completed");
        handle.exit(0);
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    session: SessionSnapshot,
    settings: AppSettings,
    downloads: Vec<DownloadTask>,
    history: Vec<HistoryItem>,
    tools: Vec<ToolStatus>,
}

#[tauri::command]
async fn bootstrap(state: tauri::State<'_, AppState>) -> AppResult<Bootstrap> {
    let session = state.sessions.snapshot();
    let history = state
        .store
        .history_for(matches!(session.status.as_str(), "connected" | "restoring"))?;
    Ok(Bootstrap {
        session,
        settings: state.store.settings()?,
        downloads: state.store.downloads()?,
        history,
        tools: state.tools.status(),
    })
}
#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    mut settings: AppSettings,
    state: tauri::State<'_, AppState>,
) -> AppResult<AppSettings> {
    if !["system", "light", "dark"].contains(&settings.theme.as_str())
        || !settings.volume.is_finite()
        || !(0. ..=100.).contains(&settings.volume)
        || !settings.playback_rate.is_finite()
        || !(0.25..=3.).contains(&settings.playback_rate)
        || !(144..=4320).contains(&settings.default_quality)
    {
        return Err(AppError::new(
            "invalid_settings",
            "Choose valid theme, volume, speed, and quality settings.",
        ));
    }
    if !std::path::Path::new(&settings.download_directory).is_absolute() {
        return Err(AppError::new(
            "invalid_path",
            "Choose an absolute download folder.",
        ));
    }
    std::fs::create_dir_all(&settings.download_directory).map_err(AppError::io)?;
    if settings.remember_playback_mode {
        settings.always_audio_only = false;
    }
    state.player.save_settings(&app, &settings)?;
    if let Err(error) = state.player.refresh_normalization(&app).await {
        tracing::warn!(category=%error.code, "Audio normalization will refresh with the next source");
    }
    Ok(settings)
}
#[tauri::command]
async fn clear_history(state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.store.clear_history()
}
fn desktop_builder() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default();
    // Isolated development smoke tests can coexist with the user's installed
    // player. This escape hatch is absent from release builds.
    #[cfg(debug_assertions)]
    if std::env::var_os("TUBEDESK_DATA_DIR").is_some() {
        return builder;
    }
    builder
        // Register first: duplicate installed/portable launches must exit before
        // creating another WebView2 environment for the same saved profile.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
}

pub fn run() {
    let app=desktop_builder()
        .manage(ShutdownSignals::default())
        .manage(window_state::MainWindowState::default())
        .manage(overlay::OverlayManager::default())
        .manage(video_surface::VideoSurface::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle=app.handle().clone();
            let paths=AppPaths::new(&handle)?;
            let log_dir=paths.data.join("logs");std::fs::create_dir_all(&log_dir)?;
            let (writer,guard)=tracing_appender::non_blocking(tracing_appender::rolling::daily(log_dir,"tubedesk.log"));
            app.manage(std::sync::Mutex::new(guard));
            let _=tracing_subscriber::fmt().with_ansi(false).with_max_level(tracing::Level::INFO).with_writer(writer).try_init();
            let store=Arc::new(Store::new(&paths)?);
            if !cfg!(debug_assertions) || std::env::var_os("TUBEDESK_DATA_DIR").is_none() {
                let previous_root = handle.path().download_dir().unwrap_or_else(|_| paths.data.clone());
                store.migrate_download_directory(&previous_root)?;
            }
            // A killed/rebooted helper cannot still own an active task.
            for mut task in store.downloads()? {
                if ["queued","resolving","downloading","merging","validating"].contains(&task.status.as_str()) {
                    task.status="paused".into();task.speed=None;task.eta=None;store.save_download(&task)?;
                }
            }
            let tools=Arc::new(ToolPaths::new(&handle));
            let cache=Arc::new(MediaCache::new(&paths)?);
            let sessions=Arc::new(SessionManager::new(paths.clone()));
            store.set_account_partition(matches!(sessions.snapshot().status.as_str(),"connected"|"restoring"));
            let gateway=Arc::new(YoutubeGateway::new(tools.clone(),sessions.clone()));
            let player=Arc::new(PlayerManager::new(tools.clone(),store.clone()));
            let downloads=Arc::new(DownloadManager::new(tools.clone(),store.clone()));
            let generation=Arc::new(AtomicU64::new(sessions.snapshot().generation));
            app.manage(AppState{store,sessions,gateway,player,downloads,cache,tools,paths});
            let listener_handle=handle.clone();
            app.listen("session-changed",move|event| {
                if let Ok(snapshot)=serde_json::from_str::<SessionSnapshot>(event.payload()) {
                    if generation.swap(snapshot.generation,Ordering::SeqCst)!=snapshot.generation {
                        listener_handle.state::<AppState>().cache.invalidate_account(&listener_handle);
                        let handle=listener_handle.clone();
                        let transition=snapshot.clone();
                        tauri::async_runtime::spawn(async move {
                            let state=handle.state::<AppState>();
                            state.player.invalidate_session(&handle).await;
                            state.downloads.invalidate_session(&handle).await;
                            state.gateway.warm_worker(&handle).await;
                            if state.sessions.snapshot().generation==transition.generation {
                                let _=state.store.clear_private_history();
                                state.store.set_account_partition(state.sessions.snapshot().status=="connected");
                            }
                        });
                    }
                    let state=listener_handle.state::<AppState>();
                    if snapshot.status=="connected" { state.store.set_account_partition(true); }
                }
            });
            let restore_handle=handle.clone();
            let worker_handle=handle.clone();
            tauri::async_runtime::spawn(async move {
                worker_handle.state::<AppState>().gateway.warm_worker(&worker_handle).await;
            });
            tauri::async_runtime::spawn(async move {
                let state=restore_handle.state::<AppState>();
                if let Err(error)=state.sessions.restore_saved_session(&restore_handle,&state.gateway).await {
                    tracing::info!(category=%error.code,"Saved account session could not be restored");
                }
            });
            window_state::restore(&handle)?;
            tracing::info!("Viewsical initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bootstrap,save_settings,clear_history,
            session::open_sign_in,session::complete_sign_in,session::sign_out,session::session_state,
            youtube::browse,youtube::cancel_browse,youtube::watch::watch_details,youtube::watch::rate_video,
            youtube::account::channel_subscription,youtube::account::set_channel_subscription,
            youtube::local_playlists::local_playlists,youtube::local_playlists::local_playlist,
            youtube::local_playlists::import_local_playlist,youtube::local_playlists::remove_local_playlist,
            youtube::local_playlists::save_local_playlist_video,youtube::watch::video_channel,
            youtube::account::youtube_playlist_save,
            comments::video_comments,comments::cancel_comments,comments::translate_comment,
            media_cache::cache_summary,media_cache::cache_configure,media_cache::cache_clear,
            player::set_playback_mode,player::player_ui_context,player::player_queue_prefetch,player::play_video,player::play_local,player::player_action,player::player_bounds,player::player_state,player::player_overlay_snapshot,player::player_overlay_action,player::retry_player_overlay,
            player::player_subtitle_tracks,player::set_player_subtitle,
            video_surface::video_renderer_mode, video_surface::video_surface_configure, video_surface::video_surface_release, video_surface::video_surface_failed,
            downloads::enqueue_download,downloads::download_action,downloads::missing_downloads,downloads::reveal_download])
        .build(tauri::generate_context!()).expect("Could not start Viewsical");
    app.run(move |handle, event| {
        if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
            if label == "main" {
                overlay::main_window_event(handle, event);
            } else if label == overlay::LABEL {
                overlay::overlay_window_event(handle, event);
            }
        }
        match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == overlay::LABEL => {
                api.prevent_close();
                request_shutdown(handle);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Resized(_),
                ..
            } if label == "main" => window_state::remember_resize(handle),
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                api.prevent_close();
                if !tray::try_hide_on_close(handle) {
                    request_shutdown(handle);
                }
            }
            tauri::RunEvent::ExitRequested { api, .. }
                if !handle
                    .state::<ShutdownSignals>()
                    .finished
                    .load(Ordering::SeqCst) =>
            {
                api.prevent_exit();
                request_shutdown(handle);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn simultaneous_close_routes_start_exactly_one_cleanup() {
        let signals = Arc::new(ShutdownSignals::default());
        let racers: Vec<_> = (0..16)
            .map(|_| {
                let signals = signals.clone();
                std::thread::spawn(move || usize::from(signals.try_start()))
            })
            .collect();
        assert_eq!(
            racers.into_iter().map(|r| r.join().unwrap()).sum::<usize>(),
            1
        );
        assert!(!signals.finished.load(Ordering::SeqCst));
        signals.finished.store(true, Ordering::SeqCst);
        assert!(!signals.try_start());
    }
}
