//! Bounded, cancellable yt-dlp execution and temporary cookie handoff.
use super::{classify_error, ensure_generation, gateway::YoutubeGateway};
use crate::{
    downloads::ProcessJob,
    models::{AppError, AppResult},
    runtime::ToolPaths,
    session::CookieSnapshot,
};
use serde_json::{json, Value};
use std::{io, process::Stdio, sync::atomic::Ordering, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    time::{timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;

const MAX_JSON: usize = 16 * 1024 * 1024;
const WORKER_START: Duration = Duration::from_secs(5);

pub(super) struct PlaybackWorker {
    generation: u64,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    _child: tokio::process::Child,
    _job: ProcessJob,
}

impl PlaybackWorker {
    async fn start(tools: &ToolPaths, app: &tauri::AppHandle, generation: u64) -> AppResult<Self> {
        let mut command = tools.youtube_python()?;
        command
            .arg(tools.youtube_plugins(app)?.join("worker.py"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(AppError::io)?;
        let job = ProcessJob::attach(&child)?;
        let stdin = child.stdin.take().ok_or_else(worker_error)?;
        let stdout = child.stdout.take().ok_or_else(worker_error)?;
        let mut worker = Self {
            generation,
            stdin,
            stdout: BufReader::new(stdout),
            _child: child,
            _job: job,
        };
        let ready = tokio::time::timeout(WORKER_START, worker.read_reply())
            .await
            .map_err(|_| worker_error())??;
        if ready["ready"] != 1 {
            return Err(worker_error());
        }
        Ok(worker)
    }

    async fn read_reply(&mut self) -> AppResult<Value> {
        let mut bytes = Vec::new();
        (&mut self.stdout)
            .take((MAX_JSON + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(AppError::io)?;
        if bytes.last() != Some(&b'\n') {
            return Err(worker_error());
        }
        serde_json::from_slice(&bytes).map_err(|_| worker_error())
    }

    async fn extract(&mut self, arguments: &[String]) -> AppResult<AppResult<Value>> {
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({"id": id, "args": arguments});
        let mut bytes = serde_json::to_vec(&request).map_err(AppError::io)?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await.map_err(AppError::io)?;
        let mut response = self.read_reply().await?;
        if response["id"].as_str() != Some(id.as_str()) {
            return Err(worker_error());
        }
        if response["too_large"].as_bool() == Some(true) {
            return Ok(Err(size_error()));
        }
        if let Some(message) = response["provider_error"].as_str() {
            return Ok(Err(classify_error(message)));
        }
        let result = response["result"].take();
        if !result.is_object() {
            return Err(worker_error());
        }
        Ok(Ok(result))
    }
}

fn worker_error() -> AppError {
    AppError::new(
        "youtube_worker",
        "The bundled playback helper stopped responding.",
    )
}

fn size_error() -> AppError {
    AppError::new(
        "response_size",
        "YouTube returned too much data. Try a smaller playlist or another search.",
    )
}

fn timeout_error() -> AppError {
    AppError::new(
        "timeout",
        "YouTube took too long to respond. Check your connection and retry.",
    )
}

fn cancelled() -> AppError {
    AppError::new("cancelled", "The request was cancelled.")
}

impl YoutubeGateway {
    pub(crate) async fn warm_worker(&self, app: &tauri::AppHandle) {
        let Ok(mut slot) = self.worker.try_lock() else {
            return;
        };
        let generation = self.sessions.snapshot().generation;
        if self.closing.load(Ordering::SeqCst)
            || slot.as_ref().is_some_and(|w| w.generation == generation)
        {
            return;
        }
        slot.take();
        if let Ok(worker) = PlaybackWorker::start(&self.tools, app, generation).await {
            if !self.closing.load(Ordering::SeqCst)
                && self.sessions.snapshot().generation == generation
            {
                *slot = Some(worker);
            }
        }
    }

    pub(crate) async fn shutdown_worker(&self) {
        self.worker.lock().await.take();
    }

    async fn resolve_with_worker(
        &self,
        app: &tauri::AppHandle,
        arguments: &[String],
        generation: u64,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> AppResult<Value> {
        let mut slot = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled()),
            slot = timeout_at(deadline, self.worker.lock()) => slot.map_err(|_| timeout_error())?,
        };
        let mut worker = slot.take().filter(|worker| worker.generation == generation);
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled()),
            result = timeout_at(deadline, async {
                if worker.is_none() {
                    worker = Some(PlaybackWorker::start(&self.tools, app, generation).await?);
                }
                worker.as_mut().ok_or_else(worker_error)?.extract(arguments).await
            }) => result.map_err(|_| timeout_error())?,
        };
        match result {
            Ok(response) => {
                if !self.closing.load(Ordering::SeqCst)
                    && self.sessions.snapshot().generation == generation
                {
                    *slot = worker;
                }
                response
            }
            Err(error) => {
                drop(worker);
                tracing::warn!(category=%error.code, "Playback worker unavailable; using bundled one-shot resolver");
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(cancelled()),
                    result = timeout_at(deadline, self.resolve_one_shot(arguments)) => result.map_err(|_| timeout_error())?,
                }
            }
        }
    }

    pub(super) async fn run(
        &self,
        app: &tauri::AppHandle,
        target: &str,
        extra: Vec<String>,
        cookies: Option<&CookieSnapshot>,
        generation: u64,
        cancellation: CancellationToken,
    ) -> AppResult<Value> {
        self.run_extraction(app, target, extra, cookies, generation, cancellation, false)
            .await
    }

    pub(super) async fn run_extraction(
        &self,
        app: &tauri::AppHandle,
        target: &str,
        extra: Vec<String>,
        cookies: Option<&CookieSnapshot>,
        generation: u64,
        cancellation: CancellationToken,
        persistent: bool,
    ) -> AppResult<Value> {
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if self.closing.load(Ordering::SeqCst) || cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let started = Instant::now();
        let deadline = started + Duration::from_secs(90);
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
        let mut arguments = [
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
            "--plugin-dirs",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        arguments.push(
            self.tools
                .youtube_plugins(app)?
                .to_string_lossy()
                .into_owned(),
        );
        arguments.extend([
            "--js-runtimes".into(),
            format!("deno:{}", self.tools.deno()?.display()),
            "--ffmpeg-location".into(),
            self.tools.root().to_string_lossy().into_owned(),
        ]);
        if let Some(cookies) = cookies {
            arguments.extend([
                "--cookies".into(),
                cookies.path().to_string_lossy().into_owned(),
            ]);
        }
        arguments.extend(extra);
        arguments.extend(["--".into(), target.into()]);

        let result = if persistent {
            self.resolve_with_worker(app, &arguments, generation, &cancellation, deadline)
                .await
        } else {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(cancelled()),
                result = timeout_at(deadline, self.resolve_one_shot(&arguments)) => result.map_err(|_| timeout_error())?,
            }
        };
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        if let Some(cookies) = cookies {
            if result
                .as_ref()
                .err()
                .is_none_or(|error| error.code != "timeout")
            {
                self.sessions.accept_cookie_updates(app, cookies).await?;
            }
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(_) => tracing::info!(
                operation,
                persistent,
                authenticated = cookies.is_some(),
                elapsed_ms,
                "YouTube adapter completed"
            ),
            Err(error) => {
                tracing::warn!(operation, persistent, authenticated=cookies.is_some(), elapsed_ms, category=%error.code, "YouTube adapter operation failed")
            }
        }
        result
    }

    async fn resolve_one_shot(&self, arguments: &[String]) -> AppResult<Value> {
        let mut command = self.tools.youtube_cli()?;
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| {
            AppError::new("tool_start", "Could not start the bundled YouTube engine. Check the installed tools in Settings.")
        })?;
        let _job = ProcessJob::attach(&child)?;
        let stdout = child.stdout.take().ok_or_else(worker_error)?;
        let stderr = child.stderr.take().ok_or_else(worker_error)?;
        let (status, stdout, stderr) = tokio::try_join!(
            child.wait(),
            read_limited(stdout, MAX_JSON + 1),
            read_limited(stderr, 128 * 1024),
        )
        .map_err(AppError::io)?;
        if stdout.len() > MAX_JSON {
            return Err(size_error());
        }
        if !status.success() {
            return Err(classify_error(&String::from_utf8_lossy(&stderr)));
        }
        serde_json::from_slice(&stdout).map_err(|_| AppError::new(
            "provider_changed", "The YouTube response could not be read. Retry or update the bundled YouTube engine.",
        ))
    }
}

async fn read_limited(input: impl AsyncReadExt + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input.take(limit as u64).read_to_end(&mut bytes).await?;
    Ok(bytes)
}
