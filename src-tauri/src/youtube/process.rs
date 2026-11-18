//! Bounded, cancellable yt-dlp execution and temporary cookie handoff.
use super::{classify_error, ensure_generation, gateway::YoutubeGateway};
use crate::{
    models::{AppError, AppResult},
    session::CookieSnapshot,
};
use serde_json::Value;
use std::{process::Stdio, sync::atomic::Ordering, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

const MAX_JSON: u64 = 16 * 1024 * 1024;

impl YoutubeGateway {
    pub(super) async fn run(
        &self,
        app: &tauri::AppHandle,
        target: &str,
        extra: Vec<String>,
        cookies: Option<&CookieSnapshot>,
        generation: u64,
        cancellation: CancellationToken,
    ) -> AppResult<Value> {
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if self.closing.load(Ordering::SeqCst) || cancellation.is_cancelled() {
            return Err(AppError::new("cancelled", "The request was cancelled."));
        }
        let started = std::time::Instant::now();
        let operation = if target.starts_with(":ytsubs") {
            "subscriptions"
        } else if target.contains("ytsearch") {
            "search"
        } else if target.contains("list=") {
            "playlist"
        } else if target.contains("/watch?") {
            "video"
        } else {
            "browse"
        };
        let mut command = Command::new(self.tools.yt_dlp()?);
        command
            .args([
                "--ignore-config",
                "--no-plugin-dirs",
                "--no-update",
                "--no-warnings",
                "--skip-download",
                "--dump-single-json",
                "--socket-timeout",
                "20",
                "--retries",
                "2",
                "--extractor-retries",
                "1",
            ])
            .arg("--plugin-dirs")
            .arg(self.tools.youtube_plugins(app)?)
            .arg("--js-runtimes")
            .arg(format!("deno:{}", self.tools.deno()?.display()))
            .arg("--ffmpeg-location")
            .arg(
                self.tools
                    .ffmpeg()?
                    .parent()
                    .unwrap_or(std::path::Path::new(".")),
            );
        if let Some(cookies) = cookies {
            command.arg("--cookies").arg(cookies.path());
        }
        command
            .args(extra)
            .arg("--")
            .arg(target)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| AppError::new("tool_start", "Could not start the bundled YouTube engine. Check the installed tools in Settings."))?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let out = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_JSON + 1)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let err = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take(128 * 1024)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let status = tokio::select! {
            _ = cancellation.cancelled() => { terminate(&mut child).await; out.abort(); err.abort(); return Err(AppError::new("cancelled", "The request was cancelled.")); }
            _ = tokio::time::sleep(Duration::from_secs(90)) => { terminate(&mut child).await; out.abort(); err.abort(); return Err(AppError::new("timeout", "YouTube took too long to respond. Check your connection and retry.")); }
            result = child.wait() => result.map_err(AppError::io)?,
        };
        let stdout = out.await.map_err(AppError::io)?.map_err(AppError::io)?;
        let stderr = err.await.map_err(AppError::io)?.map_err(AppError::io)?;
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if let Some(cookies) = cookies {
            self.sessions.accept_cookie_updates(app, cookies).await?;
        }
        if !status.success() {
            let error = classify_error(&String::from_utf8_lossy(&stderr));
            tracing::warn!(operation, authenticated=cookies.is_some(), elapsed_ms=started.elapsed().as_millis() as u64,
                exit_code=status.code(), category=%error.code, "YouTube adapter operation failed");
            return Err(error);
        }
        tracing::info!(
            operation,
            authenticated = cookies.is_some(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "YouTube adapter completed"
        );
        if stdout.len() as u64 > MAX_JSON {
            return Err(AppError::new(
                "response_size",
                "YouTube returned too much data. Try a smaller playlist or another search.",
            ));
        }
        serde_json::from_slice(&stdout).map_err(|_| AppError::new("provider_changed", "The YouTube response could not be read. Retry or update the bundled YouTube engine."))
    }
}

async fn terminate(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    {
        if child.try_wait().ok().flatten().is_none() {
            if let Some(pid) = child.id() {
                let mut taskkill = Command::new("taskkill.exe");
                taskkill
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let _ = taskkill.status().await;
            }
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}
