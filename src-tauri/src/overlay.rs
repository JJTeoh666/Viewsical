//! One application-owned WebView presents the shared React controls above mpv.
//! Geometry is physical, owner-relative and never follows playback-frame IPC.
use crate::player_geometry::{visible_clip, ClipRect};
use crate::{models::*, AppState};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const LABEL: &str = "player-overlay";
const OPEN_ERROR: &str = "Video controls couldn’t open. Use keyboard controls or retry.";

#[derive(Clone)]
struct Desired {
    bounds: PlayerBounds,
    allowed: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Geometry {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    radius: i32,
    clip: ClipRect,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Creation,
    StartupTimeout,
    Renderer,
    Closed,
}
#[derive(Default)]
struct Inner {
    desired: Option<Desired>,
    applied: Option<Geometry>,
    shown: bool,
    ready: bool,
    handshake_seen: bool,
    creating: bool,
    epoch: u64,
    error: Option<String>,
    failure: Option<Failure>,
}
#[derive(Default)]
pub struct OverlayManager {
    inner: Mutex<Inner>,
    pending: AtomicBool,
    closing: AtomicBool,
    expected_destroy: AtomicUsize,
}

pub fn error(app: &AppHandle) -> Option<String> {
    app.try_state::<OverlayManager>()?
        .inner
        .lock()
        .ok()?
        .error
        .clone()
}

fn publish(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.player.publish_presentation(app);
    }
}

fn failed(app: &AppHandle, epoch: u64, cause: Failure) {
    let manager = app.state::<OverlayManager>();
    if manager.closing.load(Ordering::SeqCst) {
        return;
    }
    let changed = if let Ok(mut inner) = manager.inner.lock() {
        if inner.epoch != epoch {
            return;
        }
        inner.creating = false;
        inner.ready = false;
        inner.failure = Some(cause);
        inner.error.replace(OPEN_ERROR.into()).is_none()
    } else {
        false
    };
    schedule(app);
    if changed {
        publish(app);
    }
}

/// May run on every state event; identical requests do not touch the native
/// window. Creation is lazy and failure requires an explicit user retry.
pub fn sync(app: &AppHandle, bounds: PlayerBounds, video_visible: bool) {
    let manager = app.state::<OverlayManager>();
    if manager.closing.load(Ordering::SeqCst) {
        return;
    }
    let wanted = video_visible && bounds.visible && bounds.width > 1. && bounds.height > 1.;
    let exists = app.get_webview_window(LABEL).is_some();
    let (create, changed) = if let Ok(mut inner) = manager.inner.lock() {
        let changed = inner.desired.as_ref().is_none_or(|previous| {
            let old = &previous.bounds;
            previous.allowed != video_visible
                || old.x != bounds.x
                || old.y != bounds.y
                || old.width != bounds.width
                || old.height != bounds.height
                || old.visible != bounds.visible
                || old.radius != bounds.radius
                || old.viewport_top != bounds.viewport_top
        });
        inner.desired = Some(Desired {
            bounds,
            allowed: video_visible,
        });
        if wanted && inner.error.is_none() && !inner.creating && !exists {
            inner.creating = true;
            inner.ready = false;
            inner.handshake_seen = false;
            inner.epoch += 1;
            (Some(inner.epoch), changed)
        } else {
            (None, changed)
        }
    } else {
        (None, false)
    };
    if let Some(epoch) = create {
        create_window(app, epoch);
    }
    if changed || create.is_some() {
        schedule(app);
    }
}

fn create_window(app: &AppHandle, epoch: u64) {
    tracing::info!(epoch, "Player overlay creation requested");
    let app = app.clone();
    // Building a WebView from a synchronous window callback can deadlock
    // WebView2. Dispatch creation from the async runtime instead.
    tauri::async_runtime::spawn(async move {
        let result = (|| -> tauri::Result<()> {
            let Some(main) = app.get_webview_window("main") else {
                return Ok(());
            };
            if app.state::<OverlayManager>().closing.load(Ordering::SeqCst) {
                return Ok(());
            }
            let navigation_app = app.clone();
            let load_app = app.clone();
            let builder = WebviewWindowBuilder::new(
                &app,
                LABEL,
                WebviewUrl::App("index.html?player-overlay=1".into()),
            )
            .title("Viewsical controls")
            .decorations(false)
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .shadow(false)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .focused(false)
            .visible(false)
            .inner_size(1., 1.)
            .disable_drag_drop_handler()
            .on_navigation(move |url| allowed_navigation(&navigation_app, url))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_page_load(move |_, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    tracing::info!(epoch, "Player overlay local page loaded");
                    publish(&load_app);
                }
            });
            #[cfg(windows)]
            let builder = builder.owner(&main)?.no_redirection_bitmap(true);
            let window = builder.build()?;
            tracing::info!(epoch, "Player overlay native window created");
            #[cfg(windows)]
            watch_renderer(&window, &app, epoch)?;
            let stale = {
                let manager = app.state::<OverlayManager>();
                let inner = manager.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.epoch != epoch || manager.closing.load(Ordering::SeqCst)
            };
            if stale {
                let _ = window.destroy();
                return Ok(());
            }
            if let Ok(mut inner) = app.state::<OverlayManager>().inner.lock() {
                inner.creating = false;
            }
            schedule(&app);
            Ok(())
        })();
        if let Err(error) = result {
            tracing::warn!(%error, "Player overlay could not be created");
            failed(&app, epoch, Failure::Creation);
            return;
        }
        let grace = if cfg!(debug_assertions) { 45 } else { 30 };
        tokio::time::sleep(std::time::Duration::from_secs(grace)).await;
        let manager = app.state::<OverlayManager>();
        let timed_out = manager
            .inner
            .lock()
            .map(|inner| inner.epoch == epoch && !inner.ready && inner.error.is_none())
            .unwrap_or(false);
        if timed_out {
            tracing::warn!(epoch, "Player overlay readiness timed out");
            failed(&app, epoch, Failure::StartupTimeout);
        }
    });
}

/// Subscribe to the native WebView2 failure signal. No heartbeat, polling or
/// screenshots are needed; only this overlay's failed renderer is retired.
#[cfg(windows)]
fn watch_renderer(window: &tauri::WebviewWindow, app: &AppHandle, epoch: u64) -> tauri::Result<()> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
    let app = app.clone();
    window.with_webview(move |webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(error) => {
                tracing::warn!(%error, "Player overlay failure monitoring could not start");
                failed(&app, epoch, Failure::Creation);
                return;
            }
        };
        let event_app = app.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                if args.ProcessFailedKind(&mut kind).is_ok()
                    && matches!(
                        kind,
                        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                    )
                {
                    tracing::warn!(failure_kind = kind.0, "Player overlay renderer failed");
                    failed(&event_app, epoch, Failure::Renderer);
                }
            }
            Ok(())
        }));
        let mut token = 0;
        if let Err(error) = core.add_ProcessFailed(&handler, &mut token) {
            tracing::warn!(%error, "Player overlay failure monitoring could not start");
            failed(&app, epoch, Failure::Creation);
        }
        // CoreWebView2 owns the callback until its controller is destroyed.
    })
}

/// The local React page subscribes before requesting its first snapshot. This
/// handshake prevents an unloaded/failed document from masking the video.
pub fn ready(app: &AppHandle) {
    let manager = app.state::<OverlayManager>();
    if manager.closing.load(Ordering::SeqCst) {
        return;
    }
    let (changed, recovered) = if let Ok(mut inner) = manager.inner.lock() {
        if !inner.handshake_seen {
            inner.handshake_seen = true;
            tracing::info!(
                epoch = inner.epoch,
                failed = inner.error.is_some(),
                creating = inner.creating,
                "Player overlay readiness received"
            );
        }
        let Some(result) = accept_ready(&mut inner) else {
            return;
        };
        result
    } else {
        (false, false)
    };
    if changed {
        schedule(app);
    }
    if recovered {
        tracing::info!("Player overlay recovered from slow initial loading");
        publish(app);
    }
}

fn accept_ready(inner: &mut Inner) -> Option<(bool, bool)> {
    // A slow bundled/dev page can recover in place when it finally starts.
    // A failed renderer or destroyed native window requires an explicit retry.
    if inner.error.is_some() && inner.failure != Some(Failure::StartupTimeout) {
        return None;
    }
    let recovered = inner.error.take().is_some();
    inner.failure = None;
    let changed = !inner.ready;
    inner.ready = true;
    Some((changed, recovered))
}

fn allowed_navigation(app: &AppHandle, url: &url::Url) -> bool {
    let dev = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    allowed_url(url, dev)
}

fn allowed_url(url: &url::Url, dev: Option<&url::Url>) -> bool {
    let local = match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => {
            url.port().is_none()
        }
        _ => dev.is_some_and(|dev| dev.origin() == url.origin()),
    };
    local
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && url
            .query_pairs()
            .any(|(key, value)| key == "player-overlay" && value == "1")
}

fn schedule(app: &AppHandle) {
    let manager = app.state::<OverlayManager>();
    if manager.closing.load(Ordering::SeqCst) || manager.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            handle
                .state::<OverlayManager>()
                .pending
                .store(false, Ordering::SeqCst);
            apply(&handle);
        })
        .is_err()
    {
        app.state::<OverlayManager>()
            .pending
            .store(false, Ordering::SeqCst);
    }
}

fn desired_geometry(
    bounds: &PlayerBounds,
    origin: (i32, i32),
    client: (i32, i32),
) -> Option<Geometry> {
    let clip = visible_clip(bounds, client)?;
    Some(Geometry {
        x: origin.0.saturating_add(bounds.x.round() as i32),
        y: origin.1.saturating_add(bounds.y.round() as i32),
        width: bounds.width.round() as i32,
        height: bounds.height.round() as i32,
        radius: bounds
            .radius
            .unwrap_or(0.)
            .clamp(0., bounds.width.min(bounds.height) / 2.)
            .round() as i32,
        clip,
    })
}

#[cfg(windows)]
fn apply(app: &AppHandle) {
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::WindowsAndMessaging::*,
    };
    let manager = app.state::<OverlayManager>();
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(hwnd), Ok(owner)) = (window.hwnd(), main.hwnd()) else {
        return;
    };
    // Tauri exposes windows0.62 handles; only raw HWNDs cross to our0.61 API.
    let (hwnd, owner) = (HWND(hwnd.0), HWND(owner.0));
    let (desired, ready, last, was_shown) = {
        let inner = manager.inner.lock().unwrap_or_else(|p| p.into_inner());
        (
            inner.desired.clone(),
            inner.ready && inner.error.is_none(),
            inner.applied,
            inner.shown,
        )
    };
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    let (geometry, active_owner) = unsafe {
        let foreground = GetForegroundWindow();
        let active = foreground == owner || foreground == hwnd;
        let geometry = if !manager.closing.load(Ordering::SeqCst)
            && IsWindowVisible(owner).as_bool()
            && !IsIconic(owner).as_bool()
            && GetClientRect(owner, &mut rect).is_ok()
            && ClientToScreen(owner, &mut origin).as_bool()
        {
            desired.as_ref().filter(|d| d.allowed).and_then(|d| {
                desired_geometry(
                    &d.bounds,
                    (origin.x, origin.y),
                    (rect.right - rect.left, rect.bottom - rect.top),
                )
            })
        } else {
            None
        };
        (geometry, active)
    };
    let shown = geometry.is_some() && ready && active_owner;
    unsafe {
        if let Some(geometry) = geometry {
            let resized = last.is_none_or(|old| {
                old.width != geometry.width
                    || old.height != geometry.height
                    || old.radius != geometry.radius
                    || old.clip != geometry.clip
            });
            if resized {
                crate::player_geometry::apply_region(
                    hwnd,
                    geometry.width,
                    geometry.height,
                    geometry.radius,
                    geometry.clip,
                );
            }
            // Size the hidden WebView immediately so initialization has a real
            // viewport. It must not expose an empty document while loading.
            if was_shown != shown || last != Some(geometry) {
                let flags = SWP_NOACTIVATE
                    | if shown {
                        SWP_SHOWWINDOW
                    } else {
                        SWP_HIDEWINDOW | SWP_NOZORDER
                    };
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    geometry.x,
                    geometry.y,
                    geometry.width,
                    geometry.height,
                    flags,
                );
            }
        } else if was_shown {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
    if was_shown != shown {
        tracing::info!(visible = shown, "Player overlay visibility changed");
    }
    if let Ok(mut inner) = manager.inner.lock() {
        inner.applied = geometry.or(last);
        inner.shown = shown;
    };
}

#[cfg(not(windows))]
fn apply(_app: &AppHandle) {}

pub fn main_window_event(app: &AppHandle, event: &WindowEvent) {
    if matches!(
        event,
        WindowEvent::Moved(_)
            | WindowEvent::Resized(_)
            | WindowEvent::ScaleFactorChanged { .. }
            | WindowEvent::Focused(_)
    ) {
        schedule(app);
    }
}

pub fn overlay_window_event(app: &AppHandle, event: &WindowEvent) {
    match event {
        WindowEvent::Focused(_) => schedule(app),
        WindowEvent::Destroyed => {
            let manager = app.state::<OverlayManager>();
            if manager.closing.load(Ordering::SeqCst) {
                return;
            }
            // Destroyed callbacks are serialized on the Windows UI thread;
            // retries may only add expected callbacks from other threads.
            if manager.expected_destroy.load(Ordering::SeqCst) > 0 {
                manager.expected_destroy.fetch_sub(1, Ordering::SeqCst);
                return;
            }
            let epoch = manager.inner.lock().map(|inner| inner.epoch).unwrap_or(0);
            failed(app, epoch, Failure::Closed);
        }
        _ => {}
    }
}

pub async fn retry(app: &AppHandle) -> AppResult<()> {
    let manager = app.state::<OverlayManager>();
    if manager.closing.load(Ordering::SeqCst) {
        return Err(AppError::new("closing", "Viewsical is closing."));
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        manager.expected_destroy.fetch_add(1, Ordering::SeqCst);
        if let Err(error) = window.destroy() {
            manager.expected_destroy.fetch_sub(1, Ordering::SeqCst);
            return Err(AppError::io(error));
        }
        // destroy() queues native destruction. Reusing the label before Tauri
        // removes the old window makes sync see an existing window and skip
        // recreation forever. Wait without holding presentation/geometry locks.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while app.get_webview_window(LABEL).is_some() {
            if manager.closing.load(Ordering::SeqCst) {
                return Err(AppError::new("closing", "Viewsical is closing."));
            }
            if tokio::time::Instant::now() >= deadline {
                let epoch = manager.inner.lock().map_err(AppError::io)?.epoch;
                failed(app, epoch, Failure::Closed);
                return Err(AppError::new(
                    "overlay_close",
                    "The previous controls window could not close. Retry controls again.",
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    let desired = {
        let mut inner = manager.inner.lock().map_err(AppError::io)?;
        inner.epoch += 1;
        inner.error = None;
        inner.failure = None;
        inner.ready = false;
        inner.handshake_seen = false;
        inner.creating = false;
        inner.applied = None;
        inner.shown = false;
        inner.desired.clone()
    };
    publish(app);
    if let Some(desired) = desired {
        sync(app, desired.bounds, desired.allowed);
    }
    Ok(())
}

pub fn shutdown(app: &AppHandle) {
    let manager = app.state::<OverlayManager>();
    manager.closing.store(true, Ordering::SeqCst);
    if let Ok(mut inner) = manager.inner.lock() {
        inner.epoch += 1;
        inner.ready = false;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounds() -> PlayerBounds {
        PlayerBounds {
            x: 100.,
            y: 80.,
            width: 640.,
            height: 360.,
            visible: true,
            radius: Some(15.),
            viewport_top: 64.,
        }
    }
    #[test]
    fn late_ready_recovers_only_startup_timeout_not_a_failed_renderer() {
        let mut inner = Inner::default();
        inner.error = Some(OPEN_ERROR.into());
        inner.failure = Some(Failure::Renderer);
        assert_eq!(accept_ready(&mut inner), None);
        assert!(!inner.ready);
        inner.failure = Some(Failure::StartupTimeout);
        assert_eq!(accept_ready(&mut inner), Some((true, true)));
        assert!(inner.ready && inner.error.is_none() && inner.failure.is_none());
        assert_eq!(accept_ready(&mut inner), Some((false, false)));
        inner.ready = false;
        inner.error = Some(OPEN_ERROR.into());
        inner.failure = Some(Failure::Closed);
        assert_eq!(accept_ready(&mut inner), None);
    }
    #[test]
    fn navigation_stays_on_the_bundled_overlay_or_exact_development_origin() {
        for good in [
            "http://tauri.localhost/index.html?player-overlay=1",
            "tauri://localhost/?player-overlay=1",
        ] {
            assert!(allowed_url(&url::Url::parse(good).unwrap(), None));
        }
        for bad in [
            "https://www.youtube.com/index.html?player-overlay=1",
            "https://tauri.localhost.evil/index.html?player-overlay=1",
            "http://tauri.localhost:9000/index.html?player-overlay=1",
            "http://tauri.localhost/",
            "http://tauri.localhost/settings?player-overlay=1",
        ] {
            assert!(!allowed_url(&url::Url::parse(bad).unwrap(), None));
        }
        let dev = url::Url::parse("http://127.0.0.1:1420").unwrap();
        assert!(allowed_url(
            &url::Url::parse("http://127.0.0.1:1420/index.html?player-overlay=1").unwrap(),
            Some(&dev)
        ));
        assert!(!allowed_url(
            &url::Url::parse("http://127.0.0.1:1421/index.html?player-overlay=1").unwrap(),
            Some(&dev)
        ));
    }
    #[test]
    fn physical_geometry_preserves_negative_monitor_origins_without_double_scaling() {
        let geometry = desired_geometry(&bounds(), (-1920, 25), (1440, 900)).unwrap();
        assert_eq!(
            (
                geometry.x,
                geometry.y,
                geometry.width,
                geometry.height,
                geometry.radius
            ),
            (-1820, 105, 640, 360, 15)
        );
    }
    #[test]
    fn offscreen_hidden_and_invalid_surfaces_cannot_show_an_overlay() {
        let mut b = bounds();
        b.visible = false;
        assert!(desired_geometry(&b, (0, 0), (1440, 900)).is_none());
        b.visible = true;
        b.y = -1.;
        assert_eq!(
            desired_geometry(&b, (0, 0), (1440, 900)).unwrap().clip.top,
            65
        );
        b.y = 800.;
        assert_eq!(
            desired_geometry(&b, (0, 0), (1440, 900))
                .unwrap()
                .clip
                .bottom,
            100
        );
        b.y = 901.;
        assert!(desired_geometry(&b, (0, 0), (1440, 900)).is_none());
        b.y = f64::NAN;
        assert!(desired_geometry(&b, (0, 0), (1440, 900)).is_none());
    }
}
