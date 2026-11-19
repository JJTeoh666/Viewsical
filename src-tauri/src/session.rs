//! The app-owned WebView profile is the session authority. Passwords never cross
//! the native bridge, and cookie exports live only as long as a helper operation.
//! Persistent cookies stay in WebView2. Session-only cookies can be remembered in
//! a current-user DPAPI envelope; they retain session semantics when restored.
use crate::{models::*, runtime::AppPaths, AppState};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const WINDOW: &str = "youtube-sign-in";
const IDLE_URL: &str = "https://www.youtube.com/robots.txt";
const REMEMBER_FILE: &str = "remembered-session.dpapi";
const BLOCKED: &str = "Google does not support sign-in in this embedded browser. Anonymous search, playback, and downloads remain available. Viewsical does not import external browser sessions.";

type CookieKey = (String, String, String);
pub struct CookieSnapshot {
    path: PathBuf,
    pub generation: u64,
    original: HashMap<CookieKey, String>,
}
impl CookieSnapshot {
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for CookieSnapshot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub struct SessionManager {
    paths: AppPaths,
    current: Mutex<SessionSnapshot>,
    transition: tokio::sync::Mutex<()>,
    publish: Mutex<()>,
    window_creation: Mutex<()>,
    native_lifecycle: tokio::sync::RwLock<()>,
    closing: Arc<AtomicBool>,
    remembered: AtomicBool,
    vault_restored: AtomicBool,
}
impl SessionManager {
    pub fn new(paths: AppPaths) -> Self {
        let remembered = fs::read(paths.data.join("session.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SessionSnapshot>(&bytes).ok());
        let connected = remembered
            .as_ref()
            .is_some_and(|s| matches!(s.status.as_str(), "connected" | "restoring"));
        Self {
            paths,
            transition: tokio::sync::Mutex::new(()),
            publish: Mutex::new(()),
            window_creation: Mutex::new(()),
            native_lifecycle: tokio::sync::RwLock::new(()),
            closing: Arc::new(AtomicBool::new(false)),
            remembered: AtomicBool::new(connected),
            vault_restored: AtomicBool::new(false),
            current: Mutex::new(SessionSnapshot {
                generation: now_millis(),
                status: if connected { "restoring" } else { "anonymous" }.into(),
                label: None,
                message: connected.then(|| "Checking your saved YouTube session…".into()),
            }),
        }
    }
    pub fn snapshot(&self) -> SessionSnapshot {
        self.current
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
    }

    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    fn ensure_open(&self) -> AppResult<()> {
        if self.is_closing() {
            Err(AppError::new(
                "closing",
                "Viewsical is closing. Reopen the app to continue.",
            ))
        } else {
            Ok(())
        }
    }

    fn update(
        &self,
        app: &tauri::AppHandle,
        status: &str,
        message: Option<String>,
        bump: bool,
    ) -> SessionSnapshot {
        let _publish = self.publish.lock().unwrap_or_else(|p| p.into_inner());
        let snapshot = {
            let mut s = self.current.lock().unwrap_or_else(|p| p.into_inner());
            if bump {
                s.generation = s.generation.wrapping_add(1);
            }
            s.status = status.into();
            s.message = message;
            s.label = (status == "connected").then(|| "YouTube account".into());
            s.clone()
        };
        if status == "connected" {
            self.remembered.store(true, Ordering::SeqCst);
        }
        if matches!(status, "anonymous" | "expired") {
            self.remembered.store(false, Ordering::SeqCst);
        }
        self.publish_snapshot(app, &snapshot);
        snapshot
    }

    fn publish_snapshot(&self, app: &tauri::AppHandle, snapshot: &SessionSnapshot) {
        // Explicit app target is required for Rust lifecycle listeners;
        // a main-window-only event does not reach AppHandle::listen.
        // Opening account management must not erase the last validated sign-in
        // marker if the user simply closes the app before finishing that flow.
        let mut persisted = snapshot.clone();
        if self.remembered.load(Ordering::SeqCst)
            && matches!(snapshot.status.as_str(), "signingIn" | "blocked")
        {
            persisted.status = "connected".into();
            persisted.message = None;
        }
        if let Ok(bytes) = serde_json::to_vec(&persisted) {
            let _ = fs::write(self.paths.data.join("session.json"), bytes);
        }
        let _ = app.emit_to(tauri::EventTarget::App, "session-changed", snapshot);
        let _ = app.emit_to("main", "session-changed", snapshot);
    }

    pub fn mark_expired(&self, app: &tauri::AppHandle, expected: u64) {
        if self.is_closing() {
            return;
        }
        let _publish = self.publish.lock().unwrap_or_else(|p| p.into_inner());
        let snapshot = {
            let mut current = self.current.lock().unwrap_or_else(|p| p.into_inner());
            if current.generation != expected {
                return;
            }
            current.generation = current.generation.wrapping_add(1);
            current.status = "expired".into();
            current.label = None;
            current.message = Some(
                "Your YouTube session has expired. Sign in again in the app to reconnect.".into(),
            );
            current.clone()
        };
        self.remembered.store(false, Ordering::SeqCst);
        let _ = fs::remove_file(self.paths.data.join(REMEMBER_FILE));
        self.publish_snapshot(app, &snapshot);
    }

    fn ensure_window(&self, app: &tauri::AppHandle, visible: bool) -> AppResult<WebviewWindow> {
        let _creation = self
            .window_creation
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        self.ensure_open()?;
        if let Some(window) = app.get_webview_window(WINDOW) {
            if visible {
                window.show().map_err(AppError::io)?;
                window.set_focus().map_err(AppError::io)?;
            }
            return Ok(window);
        }
        fs::create_dir_all(&self.paths.auth).map_err(AppError::io)?;
        let window =
            WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(IDLE_URL.parse().unwrap()))
                .title("Sign in to YouTube — Viewsical")
                .inner_size(960., 760.)
                .min_inner_size(620., 540.)
                .visible(visible)
                .data_directory(self.paths.auth.clone())
                .devtools(false)
                .on_navigation(allowed_navigation)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()
                .map_err(AppError::io)?;
        if self.is_closing() {
            let _ = window.destroy();
            return Err(AppError::new(
                "closing",
                "Viewsical is closing. Reopen the app to continue.",
            ));
        }
        let hide_window = window.clone();
        let closing = self.closing.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !closing.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = hide_window.hide();
                }
            }
        });
        Ok(window)
    }

    pub async fn cookie_snapshot(
        &self,
        app: &tauri::AppHandle,
    ) -> AppResult<Option<CookieSnapshot>> {
        self.ensure_open()?;
        let snapshot = self.snapshot();
        if snapshot.status != "connected" {
            return Ok(None);
        }
        match self.snapshot_for_validation(app).await {
            Ok(cookies) => Ok(Some(cookies)),
            Err(error) => {
                if error.code == "sign_in_required" {
                    self.mark_expired(app, snapshot.generation);
                }
                Err(error)
            }
        }
    }

    /// Merge only the helper's changes to this snapshot. A newer native browser
    /// value wins, so concurrent extraction cannot roll the WebView session back.
    /// The same transition lock protects logout from a late cookie merge.
    pub async fn accept_cookie_updates(
        &self,
        app: &tauri::AppHandle,
        snapshot: &CookieSnapshot,
    ) -> AppResult<()> {
        let _transition = self.transition.lock().await;
        if self.snapshot().generation != snapshot.generation {
            return Ok(());
        }
        let Some(window) = app.get_webview_window(WINDOW) else {
            return Ok(());
        };
        let _native = self.native_lifecycle.read().await;
        let bytes = fs::read(&snapshot.path).map_err(AppError::io)?;
        if bytes.len() > 1024 * 1024 {
            return Err(AppError::new(
                "session_storage",
                "The updated session file was unexpectedly large.",
            ));
        }
        let updates = parse_cookie_updates(&String::from_utf8_lossy(&bytes));
        let reader = window.clone();
        let native = tauri::async_runtime::spawn_blocking(move || reader.cookies())
            .await
            .map_err(AppError::io)?
            .map_err(AppError::io)?;
        let current: HashMap<CookieKey, String> = native
            .iter()
            .map(|cookie| {
                (
                    cookie_key(
                        cookie.domain().unwrap_or(""),
                        cookie.path().unwrap_or("/"),
                        cookie.name(),
                    ),
                    cookie.value().into(),
                )
            })
            .collect();
        let mut remembered_cookies: HashMap<CookieKey, tauri::webview::Cookie<'static>> = native
            .into_iter()
            .map(|cookie| {
                (
                    cookie_key(
                        cookie.domain().unwrap_or(""),
                        cookie.path().unwrap_or("/"),
                        cookie.name(),
                    ),
                    cookie,
                )
            })
            .collect();
        let mut changed = Vec::new();
        for update in updates {
            let key = cookie_key(
                update.domain().unwrap_or(""),
                update.path().unwrap_or("/"),
                update.name(),
            );
            if should_merge_cookie(
                snapshot.original.get(&key),
                current.get(&key),
                update.value(),
            ) {
                remembered_cookies.insert(key, update.clone());
                changed.push(update);
            }
        }
        if self.snapshot().generation != snapshot.generation {
            return Ok(());
        }
        tauri::async_runtime::spawn_blocking(move || -> tauri::Result<()> {
            for cookie in changed {
                window.set_cookie(cookie)?;
            }
            Ok(())
        })
        .await
        .map_err(AppError::io)?
        .map_err(AppError::io)?;
        if self.remembered.load(Ordering::SeqCst) {
            self.persist_remembered(remembered_cookies.into_values().collect())
                .await?;
        }
        Ok(())
    }

    /// Run once from startup in a background task. A remembered marker is never
    /// presented as a freshly validated authenticated connection.
    pub async fn restore_saved_session(
        &self,
        app: &tauri::AppHandle,
        gateway: &crate::youtube::YoutubeGateway,
    ) -> AppResult<SessionSnapshot> {
        self.ensure_open()?;
        let initial = self.snapshot();
        if initial.status != "restoring" {
            return Ok(initial);
        }
        let result = async {
            let cookies = self.snapshot_for_validation(app).await?;
            gateway.validate_session(app, &cookies).await
        }
        .await;
        let _transition = self.transition.lock().await;
        self.ensure_open()?;
        if self.snapshot().generation != initial.generation {
            return Err(AppError::new(
                "cancelled",
                "The account changed during session restore.",
            ));
        }
        match result {
            Ok(()) => {
                self.remembered.store(true, Ordering::SeqCst);
                if let Err(error) = self.capture_remembered(app).await {
                    tracing::warn!(category = %error.code, "Could not update the saved session backup");
                }
                self.park(app);
                Ok(self.update(app, "connected", None, false))
            }
            Err(error) => {
                self.park(app);
                if is_auth_rejection(&error) {
                    self.remembered.store(false, Ordering::SeqCst);
                    let _ = fs::remove_file(self.paths.data.join(REMEMBER_FILE));
                    self.update(app,"expired",Some("Your saved YouTube sign-in is no longer accepted. Sign in again in the app.".into()),true);
                } else {
                    // A timeout, offline startup, or changed provider response
                    // is not evidence that a previously validated login expired.
                    self.update(
                        app,
                        "connected",
                        Some(format!(
                            "Saved sign-in retained. YouTube could not be checked: {}",
                            error.message
                        )),
                        false,
                    );
                }
                Err(error)
            }
        }
    }

    async fn snapshot_for_validation(&self, app: &tauri::AppHandle) -> AppResult<CookieSnapshot> {
        self.ensure_open()?;
        let generation = self.snapshot().generation;
        if self.snapshot().status == "restoring" && !self.vault_restored.load(Ordering::SeqCst) {
            if let Err(error) = self.restore_remembered(app, generation).await {
                if matches!(error.code.as_str(), "closing" | "cancelled") {
                    return Err(error);
                }
                tracing::warn!(category=%error.code,"Remembered session-only cookies could not be restored; checking native profile");
            }
        }
        let _native = self.native_lifecycle.read().await;
        self.ensure_open()?;
        let window = self.ensure_window(app, false)?;
        // Tauri's synchronous cookie API must run off the UI event thread.
        let cookies = tauri::async_runtime::spawn_blocking(move || window.cookies())
            .await
            .map_err(AppError::io)?
            .map_err(AppError::io)?;
        self.ensure_open()?;
        if self.snapshot().generation != generation {
            return Err(AppError::new(
                "cancelled",
                "The account changed. Please retry.",
            ));
        }
        let selected: Vec<_> = cookies
            .into_iter()
            .filter(|c| allowed_cookie_domain(c.domain().unwrap_or("")))
            .collect();
        if !selected.iter().any(|c| {
            matches!(
                c.name(),
                "SAPISID" | "__Secure-3PAPISID" | "__Secure-1PAPISID" | "SID"
            )
        }) {
            return Err(AppError::new("sign_in_required", "Finish signing in to YouTube in the app window, then choose ‘I've signed in’. If Google rejects this embedded browser, anonymous features remain available."));
        }
        let mut lines = String::from(
            "# Netscape HTTP Cookie File\r\n# Temporary Viewsical session snapshot\r\n",
        );
        let mut original = HashMap::new();
        for cookie in selected {
            let domain = cookie.domain().unwrap_or("");
            let expiry = cookie
                .expires_datetime()
                .map(|d| d.unix_timestamp().max(0))
                .unwrap_or(0);
            if let Some(line) = cookie_line(
                domain,
                cookie.path().unwrap_or("/"),
                cookie.secure().unwrap_or(false),
                cookie.http_only().unwrap_or(false),
                expiry,
                cookie.name(),
                cookie.value(),
            ) {
                original.insert(
                    cookie_key(domain, cookie.path().unwrap_or("/"), cookie.name()),
                    cookie.value().into(),
                );
                lines.push_str(&line);
            }
        }
        fs::create_dir_all(&self.paths.temp).map_err(AppError::io)?;
        let path = self
            .paths
            .temp
            .join(format!("session-{}.cookies", uuid::Uuid::new_v4()));
        let result = write_private_file(&path, lines.as_bytes());
        if result.is_err() {
            let _ = fs::remove_file(&path);
        }
        result?;
        Ok(CookieSnapshot {
            path,
            generation,
            original,
        })
    }

    fn park(&self, app: &tauri::AppHandle) {
        if self.is_closing() {
            return;
        }
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.hide();
            let _ = window.navigate(IDLE_URL.parse().unwrap());
        }
    }

    async fn persist_remembered(
        &self,
        cookies: Vec<tauri::webview::Cookie<'static>>,
    ) -> AppResult<()> {
        let remembered = remembered_cookies(&cookies);
        let path = self.paths.data.join(REMEMBER_FILE);
        let output = path.clone();
        let generation = self.snapshot().generation;
        tauri::async_runtime::spawn_blocking(move || save_remembered(&output, remembered))
            .await
            .map_err(AppError::io)??;
        // A concurrent definitive auth rejection must not be undone by a
        // background encryption/write that started with the old generation.
        if !self.remembered.load(Ordering::SeqCst) || self.snapshot().generation != generation {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }

    // Caller holds transition; shutdown also holds the exclusive native guard.
    async fn capture_remembered(&self, app: &tauri::AppHandle) -> AppResult<()> {
        let Some(window) = app.get_webview_window(WINDOW) else {
            return Ok(());
        };
        let cookies = tauri::async_runtime::spawn_blocking(move || window.cookies())
            .await
            .map_err(AppError::io)?
            .map_err(AppError::io)?;
        self.persist_remembered(cookies).await
    }

    async fn restore_remembered(&self, app: &tauri::AppHandle, generation: u64) -> AppResult<()> {
        let _transition = self.transition.lock().await;
        self.ensure_open()?;
        if self.snapshot().generation != generation {
            return Err(AppError::new(
                "cancelled",
                "The account changed during restore.",
            ));
        }
        if self.vault_restored.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let path = self.paths.data.join(REMEMBER_FILE);
        let remembered = tauri::async_runtime::spawn_blocking(move || load_remembered(&path))
            .await
            .map_err(AppError::io)??;
        if remembered.is_empty() {
            return Ok(());
        }
        let _native = self.native_lifecycle.read().await;
        self.ensure_open()?;
        let window = self.ensure_window(app, false)?;
        let reader = window.clone();
        let native = tauri::async_runtime::spawn_blocking(move || reader.cookies())
            .await
            .map_err(AppError::io)?
            .map_err(AppError::io)?;
        self.ensure_open()?;
        if self.snapshot().generation != generation {
            return Err(AppError::new(
                "cancelled",
                "The account changed during restore.",
            ));
        }
        let missing = missing_remembered(remembered, &native);
        tauri::async_runtime::spawn_blocking(move || -> tauri::Result<()> {
            for cookie in missing {
                window.set_cookie(cookie)?;
            }
            Ok(())
        })
        .await
        .map_err(AppError::io)?
        .map_err(AppError::io)
    }

    /// Release the native controller without signing out or deleting its UDF.
    /// The app coordinator bounds this drain together with media cleanup.
    pub async fn shutdown(&self, app: &tauri::AppHandle) -> AppResult<()> {
        self.begin_shutdown();
        let _transition = self.transition.lock().await;
        let _native = self.native_lifecycle.write().await;
        let capture = if self.remembered.load(Ordering::SeqCst) {
            self.capture_remembered(app).await
        } else {
            Ok(())
        };
        self.destroy_native_window(app);
        capture
    }

    pub fn destroy_native_window(&self, app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.destroy();
        }
    }
}

fn is_auth_rejection(error: &AppError) -> bool {
    matches!(error.code.as_str(), "session_expired" | "sign_in_required")
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberedCookie {
    domain: String,
    path: String,
    name: String,
    value: String,
    secure: bool,
    http_only: bool,
    same_site: Option<String>,
}
#[derive(serde::Serialize, serde::Deserialize)]
struct RememberedCookies {
    version: u32,
    captured_at: u64,
    cookies: Vec<RememberedCookie>,
}
fn remembered_cookies(cookies: &[tauri::webview::Cookie<'static>]) -> Vec<RememberedCookie> {
    cookies
        .iter()
        .filter(|c| {
            c.expires_datetime().is_none() && allowed_cookie_domain(c.domain().unwrap_or(""))
        })
        .map(|c| RememberedCookie {
            domain: c.domain().unwrap_or("").into(),
            path: c.path().unwrap_or("/").into(),
            name: c.name().into(),
            value: c.value().into(),
            secure: c.secure().unwrap_or(false),
            http_only: c.http_only().unwrap_or(false),
            same_site: c.same_site().map(|s| s.to_string()),
        })
        .collect()
}
fn missing_remembered(
    cookies: Vec<RememberedCookie>,
    native: &[tauri::webview::Cookie<'static>],
) -> Vec<tauri::webview::Cookie<'static>> {
    let existing: std::collections::HashSet<_> = native
        .iter()
        .map(|c| cookie_key(c.domain().unwrap_or(""), c.path().unwrap_or("/"), c.name()))
        .collect();
    cookies
        .into_iter()
        .filter(|c| {
            allowed_cookie_domain(&c.domain)
                && !c.name.is_empty()
                && c.path.starts_with('/')
                && ![&c.domain, &c.path, &c.name, &c.value]
                    .iter()
                    .any(|s| s.contains(['\r', '\n', '\t']))
                && !existing.contains(&cookie_key(&c.domain, &c.path, &c.name))
        })
        .map(|c| {
            let mut cookie = tauri::webview::Cookie::new(c.name, c.value);
            cookie.set_domain(c.domain);
            cookie.set_path(c.path);
            cookie.set_secure(c.secure);
            cookie.set_http_only(c.http_only);
            if let Some(same_site) = c
                .same_site
                .filter(|s| matches!(s.as_str(), "Strict" | "Lax" | "None"))
            {
                if let Ok(parsed) =
                    tauri::webview::Cookie::parse(format!("placeholder=x; SameSite={same_site}"))
                {
                    cookie.set_same_site(parsed.same_site());
                }
            }
            cookie
        })
        .collect()
}
fn save_remembered(path: &Path, cookies: Vec<RememberedCookie>) -> AppResult<()> {
    if cookies.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::io(e)),
        };
        return Ok(());
    }
    let mut plain = serde_json::to_vec(&RememberedCookies {
        version: 1,
        captured_at: now_millis(),
        cookies,
    })
    .map_err(|_| AppError::new("session_storage", "Could not encode remembered sign-in."))?;
    let protected = protect_remembered(&plain);
    plain.fill(0);
    let protected = protected?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = write_private_file(&temporary, &protected)
        .and_then(|_| fs::rename(&temporary, path).map_err(AppError::io));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn load_remembered(path: &Path) -> AppResult<Vec<RememberedCookie>> {
    let encrypted = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(AppError::io(e)),
    };
    if encrypted.len() > 1024 * 1024 {
        return Err(AppError::new(
            "session_storage",
            "Remembered sign-in is too large.",
        ));
    }
    let mut plain = unprotect_remembered(&encrypted)?;
    let decoded = serde_json::from_slice::<RememberedCookies>(&plain);
    plain.fill(0);
    let decoded = decoded.map_err(|_| {
        AppError::new(
            "session_storage",
            "Remembered sign-in could not be decoded.",
        )
    })?;
    if decoded.version != 1 {
        return Err(AppError::new(
            "session_storage",
            "Remembered sign-in has an unsupported version.",
        ));
    }
    Ok(decoded.cookies)
}
#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> AppResult<Vec<u8>> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: input
            .len()
            .try_into()
            .map_err(|_| AppError::new("session_storage", "Remembered sign-in is too large."))?,
        pbData: input.as_ptr() as *mut u8,
    };
    let entropy_bytes = b"app.tubedesk.desktop/session-only/v1";
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes.len() as u32,
        pbData: entropy_bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        if protect {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    result.map_err(|_| {
        AppError::new(
            "session_storage",
            "Windows could not protect or restore remembered sign-in for this user.",
        )
    })?;
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        if !protect {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        }
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut std::ffi::c_void)));
    }
    Ok(bytes)
}
#[cfg(windows)]
fn protect_remembered(input: &[u8]) -> AppResult<Vec<u8>> {
    dpapi(input, true)
}
#[cfg(windows)]
fn unprotect_remembered(input: &[u8]) -> AppResult<Vec<u8>> {
    dpapi(input, false)
}
#[cfg(not(windows))]
fn protect_remembered(_: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::new(
        "session_storage",
        "Remembered session-only cookies require Windows protection.",
    ))
}
#[cfg(not(windows))]
fn unprotect_remembered(_: &[u8]) -> AppResult<Vec<u8>> {
    Err(AppError::new(
        "session_storage",
        "Remembered session-only cookies require Windows protection.",
    ))
}

fn allowed_navigation(url: &url::Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(allowed_cookie_domain)
}
fn allowed_cookie_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == "youtube.com"
        || domain.ends_with(".youtube.com")
        || domain == "google.com"
        || domain.ends_with(".google.com")
}
fn cookie_line(
    domain: &str,
    path: &str,
    secure: bool,
    http_only: bool,
    expiry: i64,
    name: &str,
    value: &str,
) -> Option<String> {
    if [domain, path, name, value]
        .iter()
        .any(|s| s.contains(['\r', '\n', '\t']))
        || domain.is_empty()
        || name.is_empty()
    {
        return None;
    }
    Some(format!(
        "{}{}\t{}\t{}\t{}\t{}\t{}\t{}\r\n",
        if http_only { "#HttpOnly_" } else { "" },
        domain,
        if domain.starts_with('.') {
            "TRUE"
        } else {
            "FALSE"
        },
        path,
        if secure { "TRUE" } else { "FALSE" },
        expiry,
        name,
        value
    ))
}
fn cookie_key(domain: &str, path: &str, name: &str) -> CookieKey {
    (domain.to_ascii_lowercase(), path.into(), name.into())
}
fn should_merge_cookie(original: Option<&String>, current: Option<&String>, updated: &str) -> bool {
    current.map(String::as_str) == original.map(String::as_str)
        && current.map(String::as_str) != Some(updated)
}
fn parse_cookie_updates(input: &str) -> Vec<tauri::webview::Cookie<'static>> {
    input
        .lines()
        .filter_map(|line| {
            let (line, http_only) = if let Some(line) = line.strip_prefix("#HttpOnly_") {
                (line, true)
            } else {
                (line, false)
            };
            if line.starts_with('#') || line.trim().is_empty() {
                return None;
            }
            let columns: Vec<_> = line.split('\t').collect();
            if columns.len() != 7
                || !allowed_cookie_domain(columns[0])
                || columns[5].is_empty()
                || columns.iter().any(|s| s.contains(['\r', '\n']))
            {
                return None;
            }
            let expiry = columns[4].parse::<i64>().ok()?;
            let mut cookie =
                tauri::webview::Cookie::new(columns[5].to_owned(), columns[6].to_owned());
            cookie.set_domain(columns[0].to_owned());
            cookie.set_path(columns[2].to_owned());
            cookie.set_secure(columns[3] == "TRUE");
            cookie.set_http_only(http_only);
            if expiry > 0 {
                cookie.set_expires(time::OffsetDateTime::from_unix_timestamp(expiry).ok());
            }
            Some(cookie)
        })
        .collect()
}
fn write_private_file(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(AppError::io)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let user = std::process::Command::new("whoami.exe")
            .creation_flags(0x08000000)
            .output()
            .map_err(AppError::io)?;
        if !user.status.success() {
            return Err(AppError::new(
                "session_storage",
                "Could not restrict the temporary session file to your Windows account.",
            ));
        }
        let name = String::from_utf8_lossy(&user.stdout).trim().to_string();
        let status = std::process::Command::new("icacls.exe")
            .arg(path)
            .args(["/inheritance:r", "/grant:r", &format!("{name}:F")])
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(AppError::io)?;
        if !status.success() {
            return Err(AppError::new(
                "session_storage",
                "Could not protect the temporary YouTube session file.",
            ));
        }
    }
    file.write_all(bytes).map_err(AppError::io)?;
    file.flush().map_err(AppError::io)
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn login_is_blocked(window: &WebviewWindow) -> bool {
    let (send, receive) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(send)));
    let result = window.eval_with_callback("(() => { const t = document.body?.innerText?.toLowerCase() || ''; return t.includes('this browser or app may not be secure') || t.includes('disallowed_useragent') || location.pathname.includes('/signin/rejected'); })()", move |value| {
        if let Some(send) = sender.lock().unwrap_or_else(|p| p.into_inner()).take() { let _ = send.send(value); }
    });
    if result.is_err() {
        return false;
    }
    matches!(tokio::time::timeout(Duration::from_secs(4), receive).await, Ok(Ok(value)) if value == "true")
}

#[tauri::command]
pub async fn open_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<SessionSnapshot> {
    let _transition = state.sessions.transition.lock().await;
    state.sessions.ensure_open()?;
    // A user-initiated account choice supersedes automatic fallback restore.
    state.sessions.vault_restored.store(true, Ordering::SeqCst);
    state.gateway.cancel_all();
    // Increment even when reconnecting the same account; old private requests
    // must not update the screen after the user can choose another account.
    let snapshot = state.sessions.update(&app, "signingIn", Some("Sign in in the YouTube window, then return here and choose ‘I've signed in’. Google may block embedded sign-in.".into()), true);
    let window = state.sessions.ensure_window(&app, true)?;
    window.navigate("https://accounts.google.com/AccountChooser?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Fnext%3D%252F".parse().unwrap()).map_err(AppError::io)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn complete_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<SessionSnapshot> {
    state.sessions.ensure_open()?;
    let generation = state.sessions.snapshot().generation;
    if let Some(window) = app.get_webview_window(WINDOW) {
        if login_is_blocked(&window).await {
            let _transition = state.sessions.transition.lock().await;
            state.sessions.ensure_open()?;
            if state.sessions.snapshot().generation != generation {
                return Err(AppError::new(
                    "cancelled",
                    "The account changed during sign-in. Please retry.",
                ));
            }
            let _ = window.hide();
            return Ok(state
                .sessions
                .update(&app, "blocked", Some(BLOCKED.into()), false));
        }
    }
    let cookies = state.sessions.snapshot_for_validation(&app).await?;
    let result = state.gateway.validate_session(&app, &cookies).await;
    let _transition = state.sessions.transition.lock().await;
    state.sessions.ensure_open()?;
    if state.sessions.snapshot().generation != generation {
        return Err(AppError::new(
            "cancelled",
            "The account changed during sign-in. Please retry.",
        ));
    }
    match result {
        Ok(()) => {
            if state.sessions.snapshot().generation != generation {
                return Err(AppError::new(
                    "cancelled",
                    "The account changed during sign-in. Please retry.",
                ));
            }
            state.sessions.remembered.store(true, Ordering::SeqCst);
            state.sessions.capture_remembered(&app).await?;
            state.sessions.park(&app);
            Ok(state.sessions.update(&app, "connected", None, false))
        }
        Err(error) => {
            if error.code == "sign_in_required" || error.code == "session_expired" {
                state
                    .sessions
                    .update(&app, "signingIn", Some(error.message.clone()), false);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn sign_out(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<SessionSnapshot> {
    let _transition = state.sessions.transition.lock().await;
    state.sessions.ensure_open()?;
    state.gateway.cancel_all();
    // Invalidate first, before waiting for native browser storage cleanup.
    let snapshot = state.sessions.update(&app, "anonymous", None, true);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let clear = window.clone();
        tauri::async_runtime::spawn_blocking(move || clear.clear_all_browsing_data())
            .await
            .map_err(AppError::io)?
            .map_err(AppError::io)?;
        let _ = window.navigate(IDLE_URL.parse().unwrap());
        let _ = window.hide();
    } else {
        // Create the profile only to clear it; never delete an open WebView UDF.
        let window = state.sessions.ensure_window(&app, false)?;
        tauri::async_runtime::spawn_blocking(move || window.clear_all_browsing_data())
            .await
            .map_err(AppError::io)?
            .map_err(AppError::io)?;
    }
    match fs::remove_file(state.paths.data.join(REMEMBER_FILE)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppError::io(e)),
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn session_state(state: tauri::State<'_, AppState>) -> SessionSnapshot {
    state.sessions.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_navigation_to_exact_dns_suffixes_and_https() {
        for input in [
            "https://www.youtube.com/signin",
            "https://accounts.google.com/v3/signin/",
        ] {
            assert!(allowed_navigation(&input.parse().unwrap()));
        }
        for input in [
            "https://youtube.com.attacker.test",
            "http://youtube.com",
            "file:///cookies",
            "https://notgoogle.com",
        ] {
            assert!(!allowed_navigation(&input.parse().unwrap()));
        }
    }
    #[test]
    fn cookie_export_preserves_http_only_scope_and_session_expiry() {
        assert_eq!(
            cookie_line(".youtube.com", "/", true, true, 0, "SID", "value").unwrap(),
            "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue\r\n"
        );
        assert!(cookie_line(".youtube.com", "/", true, false, 0, "SID", "value\nother").is_none());
    }
    #[test]
    fn rotated_cookies_do_not_overwrite_newer_native_values() {
        let original = "old".to_string();
        let newer = "newer-native".to_string();
        assert!(should_merge_cookie(
            Some(&original),
            Some(&original),
            "helper-update"
        ));
        assert!(!should_merge_cookie(
            Some(&original),
            Some(&newer),
            "helper-update"
        ));
        assert!(!should_merge_cookie(Some(&original), None, "helper-update"));
        assert!(should_merge_cookie(None, None, "new-cookie"));
    }
    #[test]
    fn cookie_updates_reject_external_domains_and_preserve_expiry() {
        let updates = parse_cookie_updates("# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\trotated\n.attacker.test\tTRUE\t/\tTRUE\t0\tSID\tstolen\n");
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].value(), "rotated");
        assert_eq!(updates[0].http_only(), Some(true));
        assert_eq!(
            updates[0].expires_datetime().unwrap().unix_timestamp(),
            1893456000
        );
    }
    #[test]
    fn remembered_connection_requires_validation_after_restart() {
        let root =
            std::env::temp_dir().join(format!("tubedesk-session-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("session.json"),
            serde_json::to_vec(&SessionSnapshot {
                generation: 1,
                status: "connected".into(),
                label: Some("YouTube account".into()),
                message: None,
            })
            .unwrap(),
        )
        .unwrap();
        let manager = SessionManager::new(AppPaths {
            data: root.clone(),
            auth: root.join("auth"),
            temp: root.join("tmp"),
            downloads: root.join("downloads"),
        });
        assert_eq!(manager.snapshot().status, "restoring");
        assert!(manager.snapshot().label.is_none());
        fs::remove_file(root.join("session.json")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn remembers_only_session_cookies_and_never_replaces_native_values() {
        let original = tauri::webview::Cookie::parse(
            "SID=old-session; Domain=.youtube.com; Path=/; Secure; HttpOnly; SameSite=Strict",
        )
        .unwrap()
        .into_owned();
        let mut persistent = tauri::webview::Cookie::parse(
            "PERSIST=provider-owned; Domain=.youtube.com; Path=/; Secure",
        )
        .unwrap()
        .into_owned();
        persistent.set_expires(time::OffsetDateTime::from_unix_timestamp(1893456000).unwrap());
        let external =
            tauri::webview::Cookie::parse("OTHER=excluded; Domain=.example.com; Path=/; Secure")
                .unwrap()
                .into_owned();
        let saved = remembered_cookies(&[original.clone(), persistent, external]);
        assert_eq!(saved.len(), 1);
        let restored = missing_remembered(saved, &[]);
        assert_eq!(restored.len(), 1);
        assert!(restored[0].expires_datetime().is_none());
        assert_eq!(restored[0].http_only(), Some(true));
        assert_eq!(restored[0].same_site().unwrap().to_string(), "Strict");
        let mut newer = original.clone();
        newer.set_value("new-native");
        assert!(missing_remembered(remembered_cookies(&[original]), &[newer]).is_empty());
    }

    #[test]
    fn transient_provider_failures_do_not_mean_saved_authentication_expired() {
        for code in [
            "network",
            "timeout",
            "provider_changed",
            "unsupported_library",
            "extraction_failed",
            "access_denied",
            "unavailable",
            "closing",
            "cancelled",
        ] {
            assert!(!is_auth_rejection(&AppError::new(code, "fixture")));
        }
        assert!(is_auth_rejection(&AppError::new(
            "session_expired",
            "fixture"
        )));
        assert!(is_auth_rejection(&AppError::new(
            "sign_in_required",
            "fixture"
        )));
    }

    #[cfg(windows)]
    #[test]
    fn remembered_session_is_user_protected_and_empty_save_forgets_it() {
        let directory =
            std::env::temp_dir().join(format!("tubedesk-dpapi-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(REMEMBER_FILE);
        let cookie = tauri::webview::Cookie::parse(
            "SID=fixture-session-only-secret; Domain=.youtube.com; Path=/; Secure; HttpOnly",
        )
        .unwrap()
        .into_owned();
        save_remembered(&path, remembered_cookies(std::slice::from_ref(&cookie))).unwrap();
        let encoded = fs::read(&path).unwrap();
        assert!(!encoded
            .windows(b"fixture-session-only-secret".len())
            .any(|b| b == b"fixture-session-only-secret"));
        let restored = missing_remembered(load_remembered(&path).unwrap(), &[]);
        assert_eq!(restored[0].value(), cookie.value());
        assert!(restored[0].expires_datetime().is_none());
        // Replacement remains atomic/repeatable on Windows and the final blob
        // must still be decryptable by the current user's DPAPI context.
        save_remembered(&path, remembered_cookies(&[cookie])).unwrap();
        assert_eq!(load_remembered(&path).unwrap().len(), 1);
        let mut tampered = encoded;
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(unprotect_remembered(&tampered).is_err());
        save_remembered(&path, vec![]).unwrap();
        assert!(!path.exists());
        fs::remove_dir(directory).unwrap();
    }
}
