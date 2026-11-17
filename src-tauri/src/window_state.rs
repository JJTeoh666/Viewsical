//! Remember only the user's maximized/restored main-window choice.
//!
//! Fullscreen, minimization and shutdown hiding are temporary presentation
//! states; none should replace the normal-window preference.
use crate::{AppState, ShutdownSignals};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct MainWindowState {
    last_maximized: Mutex<Option<bool>>,
}

impl MainWindowState {
    fn changed(&self, maximized: bool, fullscreen: bool, minimized: bool, visible: bool) -> bool {
        if fullscreen || minimized || !visible {
            return false;
        }
        let Ok(last) = self.last_maximized.lock() else {
            return false;
        };
        last.is_some_and(|last| last != maximized)
    }
    fn accept(&self, maximized: bool) {
        if let Ok(mut last) = self.last_maximized.lock() {
            *last = Some(maximized);
        }
    }
}

/// The configured window starts hidden, so restoring cannot flash its normal
/// size first. Failure to load the optional preference does not block startup.
pub fn restore(app: &AppHandle) -> tauri::Result<()> {
    let Some(main) = app.get_webview_window("main") else {
        return Ok(());
    };
    let maximized = app
        .state::<AppState>()
        .store
        .window_maximized()
        .unwrap_or_else(|error| {
            tracing::warn!(category=%error.code, "Saved window state could not be read");
            false
        });
    if maximized {
        if let Err(error) = main.maximize() {
            tracing::warn!(%error, "Saved maximized window state could not be restored");
        }
    }
    app.state::<MainWindowState>().accept(maximized);
    main.show()?;
    let _ = main.set_focus();
    Ok(())
}

pub fn remember(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let maximized = main.is_maximized();
    let fullscreen = main.is_fullscreen();
    let minimized = main.is_minimized();
    let visible = main.is_visible();
    if let (Ok(maximized), Ok(fullscreen), Ok(minimized), Ok(visible)) =
        (maximized, fullscreen, minimized, visible)
    {
        let window_state = app.state::<MainWindowState>();
        if window_state.changed(maximized, fullscreen, minimized, visible) {
            match state.store.save_window_maximized(maximized) {
                Ok(()) => window_state.accept(maximized),
                Err(error) => {
                    tracing::warn!(category=%error.code, "Window state could not be saved")
                }
            }
        }
    }
}

pub fn remember_resize(app: &AppHandle) {
    if !app
        .state::<ShutdownSignals>()
        .started
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        remember(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporary_window_states_do_not_replace_the_normal_choice() {
        let state = MainWindowState::default();
        assert!(!state.changed(true, false, false, true));
        state.accept(true);
        assert!(!state.changed(false, true, false, true));
        assert!(!state.changed(false, false, true, true));
        assert!(!state.changed(false, false, false, false));
        assert!(!state.changed(true, false, false, true));
        assert!(state.changed(false, false, false, true));
        state.accept(false);
        assert!(!state.changed(false, false, false, true));
        assert!(state.changed(true, false, false, true));
    }
}
