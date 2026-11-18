use crate::models::{AppError, AppResult};
use tauri::{AppHandle, Manager, WebviewWindow};

const MAX_DIMENSION: u32 = 8192;
const MAX_BYTES: u64 = 128 * 1024 * 1024;

fn require_main(window: &WebviewWindow) -> AppResult<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(AppError::new(
            "player_window",
            "This window cannot present video.",
        ))
    }
}

#[tauri::command]
pub fn video_renderer_mode(app: AppHandle, window: WebviewWindow) -> AppResult<&'static str> {
    require_main(&window)?;
    Ok(if is_canvas(&app) { "canvas" } else { "native" })
}

#[tauri::command]
pub fn video_surface_configure(
    app: AppHandle,
    window: WebviewWindow,
    width: u32,
    height: u32,
) -> AppResult<()> {
    require_main(&window)?;
    if (width == 0) != (height == 0)
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) * 4 > MAX_BYTES
    {
        return Err(AppError::new(
            "invalid_surface",
            "The video surface size is invalid.",
        ));
    }
    #[cfg(windows)]
    windows_surface::set_size(&app, width, height);
    Ok(())
}

#[tauri::command]
pub fn video_surface_release(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    sequence: u64,
) -> AppResult<()> {
    require_main(&window)?;
    #[cfg(windows)]
    windows_surface::release(&app, generation, sequence);
    Ok(())
}

#[tauri::command]
pub fn video_surface_failed(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
) -> AppResult<()> {
    require_main(&window)?;
    #[cfg(windows)]
    windows_surface::script_failed(&app, generation);
    Ok(())
}

pub fn is_canvas(app: &AppHandle) -> bool {
    #[cfg(windows)]
    return app.state::<VideoSurface>().is_canvas();
    #[cfg(not(windows))]
    false
}

pub fn source_changed(app: &AppHandle, load_id: u64, visible: bool) {
    #[cfg(windows)]
    windows_surface::set_source(app, load_id, visible);
}

#[cfg(windows)]
pub use windows_surface::{eligible, start, stop, VideoSurface};
#[cfg(not(windows))]
#[derive(Default)]
pub struct VideoSurface;

#[cfg(windows)]
mod windows_surface {
    use super::*;
    use crate::{models::AppError, AppState};
    use serde_json::{json, Value};
    use std::{
        os::windows::io::{AsRawHandle, BorrowedHandle, OwnedHandle},
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use tauri::Emitter;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        process::Child,
        sync::{mpsc, oneshot},
    };
    use webview2_com::{take_pwstr, Microsoft::Web::WebView2::Win32::*};
    use windows::Win32::{
        Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE},
        System::Threading::GetCurrentProcess,
    };
    use windows_core::{Interface, PCWSTR, PWSTR};

    #[derive(Default)]
    pub struct VideoSurface(Mutex<SurfaceState>);

    #[derive(Default)]
    struct SurfaceState {
        size: (u32, u32),
        source: (u64, bool),
        capable: bool,
        unavailable: bool,
        session: Option<Session>,
        applied: Option<SurfaceKey>,
        generation: u64,
        pending: Option<(u64, u64)>,
        last_release: Option<Instant>,
        scheduled: bool,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    struct SurfaceKey {
        load: u64,
        width: u32,
        height: u32,
    }

    #[derive(Clone)]
    struct Session {
        epoch: u64,
        process: Arc<OwnedHandle>,
        writer: mpsc::UnboundedSender<Value>,
    }

    impl VideoSurface {
        pub(super) fn is_canvas(&self) -> bool {
            self.0.lock().is_ok_and(|state| state.session.is_some())
        }
    }

    impl SurfaceState {
        fn desired(&self) -> Option<SurfaceKey> {
            let (width, height) = self.size;
            let (load, visible) = self.source;
            // The idle 1x1 probe reports capability before playback starts.
            (visible && width > 1 && height > 1).then_some(SurfaceKey {
                load,
                width,
                height,
            })
        }
    }

    pub async fn eligible(app: &AppHandle) -> bool {
        if std::env::var("TUBEDESK_VIDEO_RENDERER").as_deref() == Ok("native") {
            return false;
        }
        if !app
            .state::<VideoSurface>()
            .0
            .lock()
            .is_ok_and(|state| state.capable && !state.unavailable)
        {
            return false;
        }
        let Some(window) = app.get_webview_window("main") else {
            return false;
        };
        let (tx, rx) = oneshot::channel();
        if window
            .with_webview(move |webview| unsafe {
                let available = webview
                    .environment()
                    .cast::<ICoreWebView2Environment12>()
                    .is_ok()
                    && webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|core| core.cast::<ICoreWebView2_17>())
                        .is_ok();
                let _ = tx.send(available);
            })
            .is_err()
        {
            return false;
        }
        matches!(
            tokio::time::timeout(Duration::from_secs(1), rx).await,
            Ok(Ok(true))
        )
    }

    pub async fn start(app: &AppHandle, child: &mut Child, epoch: u64) -> AppResult<()> {
        let unavailable = || {
            AppError::new(
                "video_renderer",
                "The in-page video renderer could not start.",
            )
        };
        let handle = child.raw_handle().ok_or_else(unavailable)?;
        // The Child owns this handle for the duration of the borrow.
        let process = unsafe { BorrowedHandle::borrow_raw(handle) }
            .try_clone_to_owned()
            .map_err(AppError::io)?;
        let mut stdin = child.stdin.take().ok_or_else(unavailable)?;
        let stdout = child.stdout.take().ok_or_else(unavailable)?;
        let mut reader = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(Duration::from_secs(4), reader.next_line())
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
        if ready
            .as_deref()
            .and_then(parse_message)
            .is_none_or(|msg| msg["type"] != "ready")
        {
            if let Some(message) = ready.as_deref().and_then(parse_message) {
                log_helper_error(&message);
            }
            return Err(unavailable());
        }

        let (writer, mut input) = mpsc::unbounded_channel::<Value>();
        {
            let manager = app.state::<VideoSurface>();
            let mut state = manager.0.lock().map_err(AppError::io)?;
            if state.unavailable {
                return Err(unavailable());
            }
            state.session = Some(Session {
                epoch,
                process: Arc::new(process),
                writer,
            });
        }
        let _ = app.emit_to("main", "video-renderer-mode", "canvas");
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(value) = input.recv().await {
                let mut message = value.to_string();
                message.push('\n');
                if stdin.write_all(message.as_bytes()).await.is_err() {
                    failed(&handle, epoch);
                    break;
                }
            }
        });

        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                let Some(message) = parse_message(&line) else {
                    continue;
                };
                match message["type"].as_str() {
                    Some("frame") => {
                        if let (Some(generation), Some(sequence)) =
                            (message["generation"].as_u64(), message["sequence"].as_u64())
                        {
                            forward(&handle, epoch, generation, sequence);
                        }
                    }
                    Some("error") => {
                        log_helper_error(&message);
                        break;
                    }
                    _ => {}
                }
            }
            failed(&handle, epoch);
        });
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            watch_frames(&handle, epoch).await;
        });
        schedule(app);
        Ok(())
    }

    async fn watch_frames(app: &AppHandle, epoch: u64) {
        let timeout = Duration::from_secs(5);
        let mut expecting = None;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let player = app.state::<AppState>().player.snapshot();
            let manager = app.state::<VideoSurface>();
            let expired = {
                let Ok(state) = manager.0.lock() else { return };
                if state.unavailable
                    || state
                        .session
                        .as_ref()
                        .is_none_or(|session| session.epoch != epoch)
                {
                    return;
                }
                let wants_frame = state.applied.is_some()
                    && state.applied == state.desired()
                    && (player.status == "playing"
                        || (player.status == "paused" && state.last_release.is_none()));
                if wants_frame {
                    let (_, since) = *expecting.get_or_insert((state.generation, Instant::now()));
                    if expecting.is_some_and(|(generation, _)| generation != state.generation) {
                        expecting = Some((state.generation, Instant::now()));
                        false
                    } else {
                        state
                            .last_release
                            .map_or(since, |release| release.max(since))
                            .elapsed()
                            > timeout
                    }
                } else {
                    expecting = None;
                    false
                }
            };
            if expired {
                tracing::warn!("In-page video frame delivery timed out");
                failed(app, epoch);
                return;
            }
        }
    }

    fn parse_message(line: &str) -> Option<Value> {
        serde_json::from_str(line).ok()
    }

    fn log_helper_error(message: &Value) {
        if let Some(reason) = message["message"]
            .as_str()
            .or_else(|| message["reason"].as_str())
        {
            tracing::warn!(%reason, "Video renderer helper failed");
        }
    }

    pub fn stop(app: &AppHandle, epoch: u64) {
        let manager = app.state::<VideoSurface>();
        if let Ok(mut state) = manager.0.lock() {
            if state
                .session
                .as_ref()
                .is_some_and(|session| session.epoch == epoch)
            {
                state.session = None;
                state.unavailable = true;
                state.applied = None;
                state.pending = None;
                state.last_release = None;
                drop(state);
                let _ = app.emit_to("main", "video-renderer-mode", "native");
            }
        };
    }

    pub(super) fn set_size(app: &AppHandle, width: u32, height: u32) {
        if let Ok(mut state) = app.state::<VideoSurface>().0.lock() {
            state.size = (width, height);
            state.capable |= width > 0;
        }
        schedule(app);
    }

    pub(super) fn set_source(app: &AppHandle, load: u64, visible: bool) {
        if let Ok(mut state) = app.state::<VideoSurface>().0.lock() {
            if state.source.0 != load {
                if let Some(session) = &state.session {
                    let _ = session.writer.send(json!({ "type":"reset-frame" }));
                }
            }
            state.source = (load, visible);
        }
        schedule(app);
    }

    pub(super) fn release(app: &AppHandle, generation: u64, sequence: u64) {
        if let Ok(mut state) = app.state::<VideoSurface>().0.lock() {
            if state.pending == Some((generation, sequence)) {
                state.pending = None;
                state.last_release = Some(Instant::now());
                if let Some(session) = &state.session {
                    let _ = session.writer.send(
                        json!({ "type":"release", "generation":generation, "sequence":sequence }),
                    );
                }
            }
        }
    }

    pub(super) fn script_failed(app: &AppHandle, generation: u64) {
        let manager = app.state::<VideoSurface>();
        let epoch = if let Ok(mut state) = manager.0.lock() {
            if generation != 0 && generation != state.generation {
                return;
            }
            match state.session.as_ref() {
                Some(session) => session.epoch,
                None => {
                    state.unavailable = true;
                    return;
                }
            }
        } else {
            return;
        };
        failed(app, epoch);
    }

    fn failed(app: &AppHandle, epoch: u64) {
        let manager = app.state::<VideoSurface>();
        {
            let Ok(mut state) = manager.0.lock() else {
                return;
            };
            if state.unavailable
                || state
                    .session
                    .as_ref()
                    .is_none_or(|session| session.epoch != epoch)
            {
                return;
            }
            state.unavailable = true;
        }
        tracing::warn!("Using native video presentation after in-page renderer failure");
        let player = app.state::<AppState>().player.clone();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            player.recover_video_renderer(&handle, epoch).await;
        });
    }

    fn schedule(app: &AppHandle) {
        let manager = app.state::<VideoSurface>();
        {
            let Ok(mut state) = manager.0.lock() else {
                return;
            };
            if state.scheduled
                || state.unavailable
                || state.session.is_none()
                || state.desired() == state.applied
            {
                return;
            }
            state.scheduled = true;
        }
        let handle = app.clone();
        let queued = app.get_webview_window("main").is_some_and(|window| {
            window
                .with_webview(move |webview| {
                    let manager = handle.state::<VideoSurface>();
                    let result = apply(&handle, &webview, &manager);
                    if let Err(epoch) = result {
                        failed(&handle, epoch);
                    }
                })
                .is_ok()
        });
        if !queued {
            if let Ok(mut state) = manager.0.lock() {
                state.scheduled = false;
            }
        }
    }

    fn apply(
        app: &AppHandle,
        webview: &tauri::webview::PlatformWebview,
        manager: &VideoSurface,
    ) -> Result<(), u64> {
        let Ok(mut state) = manager.0.lock() else {
            return Ok(());
        };
        state.scheduled = false;
        let Some(session) = state.session.clone() else {
            return Ok(());
        };
        let key = state.desired();
        if state.unavailable || state.applied == key {
            return Ok(());
        }
        state.generation += 1;
        state.applied = key;
        state.pending = None;
        state.last_release = None;
        let result = match key {
            Some(key) => unsafe { install_buffer(app, webview, &session, state.generation, key) },
            None => {
                let metadata = wide(&json!({
                    "type":"viewsical-video-inactive", "generation":state.generation
                }));
                let notified = unsafe {
                    webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|core| core.PostWebMessageAsJson(PCWSTR(metadata.as_ptr())))
                };
                notified.map_err(|_| ()).and_then(|_| {
                    session
                        .writer
                        .send(json!({ "type":"inactive" }))
                        .map_err(|_| ())
                })
            }
        };
        result.map_err(|_| session.epoch)
    }

    unsafe fn install_buffer(
        app: &AppHandle,
        webview: &tauri::webview::PlatformWebview,
        session: &Session,
        generation: u64,
        key: SurfaceKey,
    ) -> Result<(), ()> {
        let core = webview.controller().CoreWebView2().map_err(|_| ())?;
        if !trusted(app, &core) {
            return Err(());
        }
        let environment = webview
            .environment()
            .cast::<ICoreWebView2Environment12>()
            .map_err(|_| ())?;
        let buffer = environment
            .CreateSharedBuffer(u64::from(key.width) * u64::from(key.height) * 4)
            .map_err(|_| ())?;
        let surface = core.cast::<ICoreWebView2_17>().map_err(|_| ())?;
        let metadata = wide(&json!({
            "type":"viewsical-video-buffer", "generation":generation, "loadId":key.load,
            "width":key.width, "height":key.height
        }));
        surface
            .PostSharedBufferToScript(
                &buffer,
                COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                PCWSTR(metadata.as_ptr()),
            )
            .map_err(|_| ())?;
        let mut mapping = Default::default();
        buffer.FileMappingHandle(&mut mapping).map_err(|_| ())?;
        let mut handle = HANDLE::default();
        let process = GetCurrentProcess();
        DuplicateHandle(
            process,
            HANDLE(mapping.0),
            HANDLE(session.process.as_raw_handle()),
            &mut handle,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
        .map_err(|_| ())?;
        let _ = buffer.Close();
        session
            .writer
            .send(json!({
                "type":"surface", "generation":generation, "handle":handle.0 as usize,
                "width":key.width, "height":key.height
            }))
            .map_err(|_| ())?;
        Ok(())
    }

    fn forward(app: &AppHandle, epoch: u64, generation: u64, sequence: u64) {
        let window = app.get_webview_window("main");
        let handle = app.clone();
        let queued = window.is_some_and(|window| window.with_webview(move |webview| {
            let manager = handle.state::<VideoSurface>();
            let result = (|| {
                let mut state = manager.0.lock().map_err(|_| ())?;
                let Some(key) = state.applied else { return Ok(()) };
                if state.unavailable || state.session.as_ref().is_none_or(|session| session.epoch != epoch)
                    || state.generation != generation || state.pending.is_some()
                {
                    return Ok(());
                }
                state.pending = Some((generation, sequence));
                let metadata = wide(&json!({ "type":"viewsical-video-frame", "generation":generation, "sequence":sequence, "loadId":key.load }));
                unsafe {
                    let core = webview.controller().CoreWebView2().map_err(|_| ())?;
                    if !trusted(&handle, &core) { return Err(()) }
                    core.PostWebMessageAsJson(PCWSTR(metadata.as_ptr())).map_err(|_| ())
                }
            })();
            if result.is_err() {
                failed(&handle, epoch);
            }
        }).is_ok());
        if !queued {
            failed(app, epoch);
        }
    }

    fn wide(value: &Value) -> Vec<u16> {
        value
            .to_string()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    unsafe fn trusted(app: &AppHandle, core: &ICoreWebView2) -> bool {
        let mut source = PWSTR::null();
        if core.Source(&mut source).is_err() {
            return false;
        }
        let Ok(url) = url::Url::parse(&take_pwstr(source)) else {
            return false;
        };
        let is_app = matches!(
            (url.scheme(), url.host_str(), url.port()),
            ("http", Some("tauri.localhost"), None)
                | ("https", Some("tauri.localhost"), None)
                | ("tauri", Some("localhost"), None)
        );
        let is_dev = cfg!(debug_assertions)
            && app
                .config()
                .build
                .dev_url
                .as_ref()
                .is_some_and(|dev| dev.origin() == url.origin());
        (is_app || is_dev) && matches!(url.path(), "/" | "/index.html") && url.query().is_none()
    }
}
