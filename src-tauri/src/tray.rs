use crate::{overlay, request_shutdown, window_state, AppState, ShutdownSignals};
use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};

const ID: &str = "viewsical-tray";
const OPEN: &str = "viewsical-tray-open";
const QUIT: &str = "viewsical-tray-quit";

pub fn try_hide_on_close(app: &AppHandle) -> bool {
    let Some(main) = app.get_webview_window("main") else {
        return false;
    };
    if maintenance_requested(&main)
        || shutdown_started(app)
        || !app
            .state::<AppState>()
            .store
            .settings()
            .is_ok_and(|settings| settings.close_to_tray)
    {
        return false;
    }

    let result = show_icon(app).and_then(|_| {
        window_state::remember(app);
        main.hide()
    });
    if let Err(error) = result {
        tracing::warn!(%error, "Could not minimize Viewsical to the tray");
        return false;
    }
    overlay::schedule(app);
    true
}

pub fn show_main_window(app: &AppHandle) {
    if shutdown_started(app) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        if main.is_minimized().unwrap_or(false) {
            let _ = main.unminimize();
        }
        if main.show().is_ok() {
            hide_icon(app);
            let _ = main.set_focus();
            overlay::schedule(app);
        }
    }
}

pub fn hide_icon(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(ID) {
        let _ = tray.set_visible(false);
    }
}

fn show_icon(app: &AppHandle) -> tauri::Result<()> {
    match app.tray_by_id(ID) {
        Some(tray) => tray.set_visible(true),
        None => create_icon(app).map(drop),
    }
}

fn create_icon(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let open = MenuItem::with_id(app, OPEN, "Open Viewsical", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit Viewsical", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("Viewsical tray icon".into()))?;
    TrayIconBuilder::with_id(ID)
        .icon(icon)
        .tooltip("Viewsical")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN => show_main_window(app),
            QUIT => request_shutdown(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
}

fn shutdown_started(app: &AppHandle) -> bool {
    app.try_state::<ShutdownSignals>()
        .is_some_and(|signals| signals.started.load(Ordering::SeqCst))
}

#[cfg(windows)]
fn maintenance_requested(main: &WebviewWindow) -> bool {
    use windows::{
        core::w,
        Win32::{Foundation::HWND, UI::WindowsAndMessaging::RemovePropW},
    };
    // The installer sets this on the exact installed window before posting WM_CLOSE.
    main.hwnd().is_ok_and(|hwnd| unsafe {
        RemovePropW(HWND(hwnd.0), w!("Viewsical.QuitForMaintenance")).is_ok()
    })
}

#[cfg(not(windows))]
fn maintenance_requested(_main: &WebviewWindow) -> bool {
    false
}
