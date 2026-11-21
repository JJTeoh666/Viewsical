use crate::{models::*, runtime::ToolPaths, store::Store, AppState};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

struct RunningDownload {
    cancel: CancellationToken,
    outcome: Mutex<String>,
    generation: AtomicU64,
}

pub struct DownloadManager {
    tools: Arc<ToolPaths>,
    store: Arc<Store>,
    jobs: Mutex<HashMap<String, Arc<RunningDownload>>>,
    slots: Arc<Semaphore>,
    closing: AtomicBool,
}

impl DownloadManager {
    pub fn new(tools: Arc<ToolPaths>, store: Arc<Store>) -> Self {
        if let Ok(tasks) = store.downloads() {
            for mut task in tasks {
                if matches!(
                    task.status.as_str(),
                    "queued" | "resolving" | "downloading" | "merging" | "validating"
                ) {
                    task.status = "paused".into();
                    task.speed = None;
                    task.eta = None;
                    task.error =
                        Some("Interrupted when Viewsical closed. Resume to continue.".into());
                    let _ = store.save_download(&task);
                }
            }
        }
        Self {
            tools,
            store,
            jobs: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(2)),
            closing: AtomicBool::new(false),
        }
    }

    fn publish(&self, app: &AppHandle, task: &DownloadTask) -> AppResult<()> {
        self.store.save_download(task)?;
        let _ = app.emit("download-updated", task);
        Ok(())
    }

    fn find(&self, id: &str) -> AppResult<DownloadTask> {
        self.store
            .downloads()?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::new("not_found", "This download is no longer in the library."))
    }

    pub async fn enqueue(
        self: &Arc<Self>,
        app: &AppHandle,
        request: DownloadRequest,
    ) -> AppResult<DownloadTask> {
        validate_request(&request)?;
        self.tools.youtube_python()?;
        self.tools.deno()?;
        self.tools.ffmpeg()?;
        self.tools.ffprobe()?;
        let settings = self.store.settings()?;
        let directory = request
            .directory
            .filter(|p| !p.trim().is_empty())
            .unwrap_or(settings.download_directory);
        let destination = PathBuf::from(directory.trim());
        if !destination.is_absolute() {
            return Err(AppError::new(
                "invalid_destination",
                "Choose an absolute download folder.",
            ));
        }
        std::fs::create_dir_all(&destination).map_err(|_| {
            AppError::new(
                "destination",
                "Viewsical cannot write to this folder. Choose another download folder.",
            )
        })?;
        let task = DownloadTask {
            id: uuid::Uuid::new_v4().to_string(),
            video: request.item,
            mode: request.mode,
            quality: request.quality,
            format: request.format,
            destination: destination.to_string_lossy().into(),
            status: "queued".into(),
            progress: 0.,
            downloaded_bytes: 0,
            total_bytes: None,
            speed: None,
            eta: None,
            output_path: None,
            error: None,
            created_at: now(),
            session_generation: app.state::<AppState>().sessions.snapshot().generation,
        };
        self.publish(app, &task)?;
        self.start(app.clone(), task.clone())?;
        Ok(task)
    }

    fn start(self: &Arc<Self>, app: AppHandle, task: DownloadTask) -> AppResult<()> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "closing",
                "Viewsical is closing. Reopen the app to resume downloads.",
            ));
        }
        let running = Arc::new(RunningDownload {
            cancel: CancellationToken::new(),
            outcome: Mutex::new("paused".into()),
            generation: AtomicU64::new(task.session_generation),
        });
        {
            let mut jobs = self.jobs.lock().map_err(AppError::io)?;
            if self.closing.load(Ordering::SeqCst) {
                return Err(AppError::new(
                    "closing",
                    "Viewsical is closing. Reopen the app to resume downloads.",
                ));
            }
            if jobs.contains_key(&task.id) {
                return Err(AppError::new(
                    "busy",
                    "This download is still stopping. Try again in a moment.",
                ));
            }
            jobs.insert(task.id.clone(), running.clone());
        }
        if let Err(error) = self.publish(&app, &task) {
            if let Ok(mut jobs) = self.jobs.lock() {
                jobs.remove(&task.id);
            }
            return Err(error);
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let id = task.id.clone();
            manager.run(app, task, running).await;
            if let Ok(mut jobs) = manager.jobs.lock() {
                jobs.remove(&id);
            }
        });
        Ok(())
    }

    async fn run(&self, app: AppHandle, mut task: DownloadTask, running: Arc<RunningDownload>) {
        let result = self.run_inner(&app, &mut task, &running).await;
        if running.cancel.is_cancelled() && task.status != "completed" {
            task.status = running
                .outcome
                .lock()
                .map(|s| s.clone())
                .unwrap_or_else(|_| "paused".into());
            task.error = None;
            if task.status == "cancelled" {
                let _ = remove_work_dir(&task);
            }
        } else if let Err(error) = result {
            if error.code == "source_changed" {
                let _ = remove_work_dir(&task);
                task.progress = 0.;
                task.downloaded_bytes = 0;
                task.total_bytes = None;
            }
            task.status = "failed".into();
            task.error = Some(error.message);
        }
        task.speed = None;
        task.eta = None;
        let _ = self.publish(&app, &task);
    }

    async fn run_inner(
        &self,
        app: &AppHandle,
        task: &mut DownloadTask,
        running: &RunningDownload,
    ) -> AppResult<()> {
        let _slot = tokio::select! {
            _ = running.cancel.cancelled() => return Ok(()),
            permit = self.slots.acquire() => permit.map_err(AppError::io)?,
        };
        if running.cancel.is_cancelled() {
            return Ok(());
        }
        task.status = "resolving".into();
        task.error = None;
        self.publish(app, task)?;
        let state = app.state::<AppState>();
        let session = state.sessions.snapshot();
        if running.generation.load(Ordering::SeqCst) != session.generation {
            return Err(AppError::new("session_changed", "Your account changed while this download was queued. Resume to use the current session."));
        }
        task.session_generation = session.generation;
        let cookies = state.sessions.cookie_snapshot(app).await?;
        if session.generation != state.sessions.snapshot().generation {
            return Err(AppError::new(
                "session_changed",
                "Your account changed. Resume this download to use the current session.",
            ));
        }
        let work = work_dir(task)?;
        std::fs::create_dir_all(&work).map_err(AppError::io)?;
        let selection_file = work.join("selection.json");
        let format = match std::fs::read(&selection_file) {
            Ok(bytes) => serde_json::from_slice::<String>(&bytes)
                .ok()
                .filter(|s| valid_format_ids(s))
                .unwrap_or_else(|| format_selector(task)),
            Err(_) => format_selector(task),
        };
        let mut command = self.tools.youtube_cli()?;
        command.args([
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-update",
            "--no-playlist",
            "--no-simulate",
            "--newline",
            "--no-colors",
            "--continue",
            "--part",
            "--windows-filenames",
            "--trim-filenames",
            "160",
            "--socket-timeout",
            "20",
            "--retries",
            "3",
            "--fragment-retries",
            "3",
            "--concurrent-fragments",
            "1",
            "--progress",
            "--progress-delta",
            "0.5",
            "--progress-template",
            "download:TD_PROGRESS:%(progress)j",
            "--progress-template",
            "postprocess:TD_POST:%(progress)j",
            "--print",
            "before_dl:TD_SELECTION:%(format_id)j",
            "--print",
            "before_dl:TD_INFO:%()j",
            "--print",
            "after_move:TD_FILE:%(filepath)j",
        ]);
        command
            .arg("--plugin-dirs")
            .arg(self.tools.youtube_plugins(app)?)
            .arg("--js-runtimes")
            .arg(format!("deno:{}", self.tools.deno()?.display()));
        command.arg("--ffmpeg-location").arg(
            self.tools
                .ffmpeg()?
                .parent()
                .ok_or_else(|| AppError::new("tools", "FFmpeg folder is missing."))?,
        );
        command.arg("-f").arg(format);
        if task.mode == "video" {
            command
                .arg("--merge-output-format")
                .arg(&task.format)
                .arg("--remux-video")
                .arg(&task.format);
        }
        command
            .arg("-o")
            .arg(work.join("%(title).120B [%(id)s].%(ext)s"));
        if let Some(ref jar) = cookies {
            command.arg("--cookies").arg(jar.path());
        }
        command
            .arg("--")
            .arg(format!("https://www.youtube.com/watch?v={}", task.video.id));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        hide_command(&mut command);
        let mut child = command.spawn().map_err(|_| {
            AppError::new(
                "extractor_start",
                "The YouTube helper could not start. Check the bundled tools in Settings.",
            )
        })?;
        let _job = ProcessJob::attach(&child)?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::new(
                "extractor",
                "The download helper did not open its output channel.",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::new(
                "extractor",
                "The download helper did not open its error channel.",
            )
        })?;
        let stderr_reader = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut bytes = Vec::new();
            let _ = reader.read_to_end(&mut bytes).await;
            let start = bytes.len().saturating_sub(6000);
            String::from_utf8_lossy(&bytes[start..]).into_owned()
        });
        let mut lines = BufReader::new(stdout).lines();
        let mut output: Option<PathBuf> = None;
        let mut finished_stdout = false;
        let exit = loop {
            tokio::select! {
                _ = running.cancel.cancelled() => {
                    let _ = child.kill().await; let _ = child.wait().await;
                    if let Some(ref jar) = cookies { let _ = state.sessions.accept_cookie_updates(app, jar).await; }
                    stderr_reader.abort(); return Ok(());
                },
                status = child.wait() => break status.map_err(AppError::io)?,
                line = lines.next_line(), if !finished_stdout => match line {
                    Ok(Some(line)) => self.consume_line(app, task, &line, &mut output, &selection_file)?,
                    Ok(None) => finished_stdout = true,
                    Err(error) => { let _ = child.kill().await; return Err(AppError::io(error)); }
                },
            }
        };
        while let Ok(Some(line)) = lines.next_line().await {
            self.consume_line(app, task, &line, &mut output, &selection_file)?;
        }
        if let Some(ref jar) = cookies {
            let _ = state.sessions.accept_cookie_updates(app, jar).await;
        }
        let stderr = stderr_reader.await.unwrap_or_default();
        if !exit.success() {
            return Err(download_error(&stderr));
        }
        if running.cancel.is_cancelled() {
            return Ok(());
        }
        if session.generation != state.sessions.snapshot().generation {
            return Err(AppError::new(
                "session_changed",
                "Your account changed while downloading. Resume to try again.",
            ));
        }
        let output = output.ok_or_else(|| {
            AppError::new(
                "output_missing",
                "The helper finished without a media file. Retry the download.",
            )
        })?;
        let canonical_work = work.canonicalize().map_err(AppError::io)?;
        let canonical_output = output.canonicalize().map_err(AppError::io)?;
        if !canonical_output.starts_with(&canonical_work) {
            return Err(AppError::new(
                "invalid_output",
                "The helper returned a file outside this download's working folder.",
            ));
        }
        task.status = "validating".into();
        self.publish(app, task)?;
        validate_media(
            &self.tools,
            &canonical_output,
            &task.mode,
            Some(&running.cancel),
        )
        .await?;
        if running.cancel.is_cancelled() {
            return Ok(());
        }
        let destination = publish_file(&canonical_output, Path::new(&task.destination), &task.id)?;
        task.output_path = Some(destination.to_string_lossy().into());
        task.status = "completed".into();
        task.progress = 100.;
        task.downloaded_bytes = std::fs::metadata(&destination)
            .map(|m| m.len())
            .unwrap_or(task.downloaded_bytes);
        task.total_bytes = Some(task.downloaded_bytes);
        task.error = None;
        self.publish(app, task)?;
        let _ = remove_work_dir(task);
        Ok(())
    }

    fn consume_line(
        &self,
        app: &AppHandle,
        task: &mut DownloadTask,
        line: &str,
        output: &mut Option<PathBuf>,
        selection_file: &Path,
    ) -> AppResult<()> {
        if let Some(text) = line.strip_prefix("TD_PROGRESS:") {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                update_progress(task, &value);
                self.publish(app, task)?;
            }
        } else if line.starts_with("TD_POST:") {
            task.status = "merging".into();
            self.publish(app, task)?;
        } else if let Some(text) = line.strip_prefix("TD_SELECTION:") {
            if let Ok(id) = serde_json::from_str::<String>(text) {
                if valid_format_ids(&id) {
                    std::fs::write(
                        selection_file,
                        serde_json::to_vec(&id).map_err(AppError::io)?,
                    )
                    .map_err(AppError::io)?;
                }
            }
        } else if let Some(text) = line.strip_prefix("TD_INFO:") {
            // Extractor info can contain temporary URLs. Persist only stable stream identity.
            let info: Value = serde_json::from_str(text).map_err(|_| {
                AppError::new(
                    "extractor_response",
                    "The helper returned invalid download metadata.",
                )
            })?;
            if info["id"].as_str() == Some(task.video.id.as_str()) {
                task.video.youtube_loudness_db =
                    crate::normalization::valid_loudness(info["viewsical_loudness_db"].as_f64());
                if let Some(heatmap) = crate::youtube::replay_heatmap(&info) {
                    task.video.heatmap = Some(heatmap);
                }
                if let Some(chapters) = crate::youtube::video_chapters(&info) {
                    task.video.chapters = Some(chapters);
                }
            }
            if task.mode == "video" {
                if let Some(height) = info["height"]
                    .as_u64()
                    .filter(|height| (144..=8640).contains(height))
                {
                    task.quality = height as u32;
                }
            }
            let identity = stream_identity(&info);
            let path = selection_file.with_file_name("identity.json");
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(previous) = serde_json::from_slice::<Value>(&bytes) {
                    if !identity_compatible(&previous, &identity) {
                        return Err(AppError::new("source_changed", "This video's source changed since the download was paused. Partial data was cleared; resume to start a fresh download."));
                    }
                }
            }
            std::fs::write(path, serde_json::to_vec(&identity).map_err(AppError::io)?)
                .map_err(AppError::io)?;
        } else if let Some(text) = line.strip_prefix("TD_FILE:") {
            if let Ok(path) = serde_json::from_str::<String>(text) {
                *output = Some(PathBuf::from(path));
            }
        }
        Ok(())
    }

    pub async fn action(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        action: &str,
    ) -> AppResult<()> {
        if !matches!(action, "pause" | "resume" | "cancel") {
            return Err(AppError::new("invalid_action", "Unknown download action."));
        }
        let mut task = self.find(id)?;
        if task.status == "completed" {
            return Err(AppError::new(
                "completed",
                "This file is already downloaded.",
            ));
        }
        if action == "resume" {
            if !matches!(task.status.as_str(), "paused" | "failed") {
                return Err(AppError::new(
                    "invalid_state",
                    "Only paused or failed downloads can be resumed.",
                ));
            }
            task.status = "queued".into();
            task.error = None;
            task.session_generation = app.state::<AppState>().sessions.snapshot().generation;
            self.start(app.clone(), task.clone())?;
        } else {
            let desired = if action == "cancel" {
                "cancelled"
            } else {
                "paused"
            };
            let running = self.jobs.lock().map_err(AppError::io)?.get(id).cloned();
            if let Some(running) = running {
                if let Ok(mut outcome) = running.outcome.lock() {
                    *outcome = desired.into();
                }
                running.cancel.cancel();
            } else {
                task.status = desired.into();
                task.error = None;
                task.speed = None;
                task.eta = None;
                if action == "cancel" {
                    remove_work_dir(&task)?;
                }
                self.publish(app, &task)?;
            }
        }
        Ok(())
    }

    pub async fn invalidate_session(&self, app: &AppHandle) {
        let generation = app.state::<AppState>().sessions.snapshot().generation;
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs
                .values()
                .filter(|job| job.generation.load(Ordering::SeqCst) != generation)
            {
                if let Ok(mut outcome) = job.outcome.lock() {
                    *outcome = "paused".into();
                }
                job.cancel.cancel();
            }
        }
    }

    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                if let Ok(mut outcome) = job.outcome.lock() {
                    *outcome = "paused".into();
                }
                job.cancel.cancel();
            }
        }
    }

    pub async fn shutdown(&self) {
        self.begin_shutdown();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
        loop {
            if self.jobs.lock().map(|jobs| jobs.is_empty()).unwrap_or(true)
                || tokio::time::Instant::now() >= deadline
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }
}

pub(crate) fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn validate_request(request: &DownloadRequest) -> AppResult<()> {
    if !valid_video_id(&request.item.id) || request.item.kind != "video" {
        return Err(AppError::new(
            "invalid_video",
            "Select a YouTube video to download.",
        ));
    }
    if !matches!(request.mode.as_str(), "video" | "audio")
        || !(144..=4320).contains(&request.quality)
    {
        return Err(AppError::new(
            "invalid_format",
            "Choose a supported download mode and quality.",
        ));
    }
    if (request.mode == "video" && !matches!(request.format.as_str(), "mp4" | "mkv"))
        || (request.mode == "audio" && !matches!(request.format.as_str(), "original" | "m4a"))
    {
        return Err(AppError::new(
            "invalid_format",
            "Choose MP4/MKV for video or original/M4A for audio.",
        ));
    }
    Ok(())
}
fn format_selector(task: &DownloadTask) -> String {
    // HLS audio/video are a coherent pair. A direct audio URL can be rejected
    // even when its companion HLS video works; never mix those transports first.
    if task.mode == "audio" {
        if task.format == "m4a" {
            "ba[protocol^=m3u8][ext=m4a]/ba[ext=m4a]".into()
        } else {
            "ba[protocol^=m3u8]/ba[ext=m4a]/ba".into()
        }
    } else if task.format == "mp4" {
        format!("bv[protocol^=m3u8][height<={q}][vcodec^=avc1]+ba[protocol^=m3u8][acodec^=mp4a]/b[protocol^=m3u8][height<={q}][vcodec^=avc1]/bv[height<={q}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<={q}][ext=mp4][vcodec^=avc1]",q=task.quality)
    } else {
        format!("bv[protocol^=m3u8][height<={q}]+ba[protocol^=m3u8]/b[protocol^=m3u8][height<={q}]/bv[height<={q}]+ba/b[height<={q}]",q=task.quality)
    }
}

fn valid_format_ids(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'_' | b'.'))
}
fn stream_identity(info: &Value) -> Value {
    fn stream(source: &Value) -> Value {
        let mut result = serde_json::Map::new();
        for key in [
            "format_id",
            "ext",
            "vcodec",
            "acodec",
            "width",
            "height",
            "fps",
            "asr",
            "audio_channels",
            "language",
            "filesize",
        ] {
            if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
                result.insert(key.into(), value.clone());
            }
        }
        Value::Object(result)
    }
    let components = info["requested_formats"]
        .as_array()
        .map(|formats| formats.iter().map(stream).collect())
        .unwrap_or_else(|| vec![stream(info)]);
    serde_json::json!({"videoId":info["id"],"formatId":info["format_id"],"components":components})
}
fn identity_compatible(previous: &Value, current: &Value) -> bool {
    match (previous, current) {
        (Value::Object(a), Value::Object(b)) => a.iter().all(|(key, value)| {
            b.get(key)
                .is_none_or(|other| identity_compatible(value, other))
        }),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| identity_compatible(a, b))
        }
        (a, b) => a == b,
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn work_dir(task: &DownloadTask) -> AppResult<PathBuf> {
    if uuid::Uuid::parse_str(&task.id).is_err() {
        return Err(AppError::new(
            "invalid_task",
            "This download has an invalid identifier.",
        ));
    }
    Ok(PathBuf::from(&task.destination)
        .join(".tubedesk")
        .join(&task.id))
}
fn remove_work_dir(task: &DownloadTask) -> AppResult<()> {
    let path = work_dir(task)?;
    if path.exists() {
        let actual = path.canonicalize().map_err(AppError::io)?;
        let parent = PathBuf::from(&task.destination)
            .canonicalize()
            .map_err(AppError::io)?;
        if actual.file_name().and_then(|s| s.to_str()) != Some(task.id.as_str())
            || actual
                .parent()
                .and_then(Path::file_name)
                .and_then(|s| s.to_str())
                != Some(".tubedesk")
            || !actual.starts_with(&parent)
        {
            return Err(AppError::new(
                "invalid_path",
                "The download working folder is not safe to remove.",
            ));
        }
        std::fs::remove_dir_all(actual).map_err(AppError::io)?;
    }
    Ok(())
}
fn publish_file(source: &Path, destination: &Path, id: &str) -> AppResult<PathBuf> {
    let name = source
        .file_name()
        .ok_or_else(|| AppError::new("invalid_output", "The output filename is missing."))?;
    let mut output = destination.join(name);
    if output.exists() {
        let stem = source.file_stem().unwrap_or_default().to_string_lossy();
        let ext = source.extension().unwrap_or_default().to_string_lossy();
        output = destination.join(format!("{} [{}].{}", stem, &id[..8], ext));
    }
    if output.exists() {
        return Err(AppError::new("file_exists", "A file with this name already exists. Choose another folder or rename the existing file."));
    }
    std::fs::rename(source, &output).map_err(|_| AppError::new("publish", "The file passed validation but could not be moved into your download folder. Free some space and resume to retry."))?;
    Ok(output)
}

fn update_progress(task: &mut DownloadTask, value: &Value) {
    task.status = "downloading".into();
    task.downloaded_bytes = value["downloaded_bytes"]
        .as_u64()
        .unwrap_or(task.downloaded_bytes);
    task.total_bytes = value["total_bytes"]
        .as_u64()
        .or_else(|| value["total_bytes_estimate"].as_u64());
    if let Some(total) = task.total_bytes.filter(|n| *n > 0) {
        task.progress = (task.downloaded_bytes as f64 / total as f64 * 100.).clamp(0., 99.);
    }
    task.speed = value["speed"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .map(|n| format!("{:.1} MB/s", n / 1_000_000.));
    task.eta = value["eta"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .map(|n| format!("{}:{:02}", n as u64 / 60, n as u64 % 60));
}
fn download_error(stderr: &str) -> AppError {
    let lower = stderr.to_lowercase();
    if lower.contains("no space left") || lower.contains("not enough space") {
        return AppError::new(
            "disk_full",
            "Your download drive is full. Free some space, then resume.",
        );
    }
    if lower.contains("requested format is not available") {
        return AppError::new("format_unavailable", "The selected format is unavailable or changed. Start a new download; choose MKV for a wider range of codecs.");
    }
    if lower.contains("sign in")
        || lower.contains("cookies are no longer valid")
        || lower.contains("login required")
    {
        return AppError::new(
            "sign_in_required",
            "YouTube requires a fresh sign-in for this video. Reconnect your account and resume.",
        );
    }
    if lower.contains("private video")
        || lower.contains("video unavailable")
        || lower.contains("not available in your country")
    {
        return AppError::new(
            "unavailable",
            "This video is unavailable to the current YouTube session.",
        );
    }
    if lower.contains("permission denied") || lower.contains("access is denied") {
        return AppError::new(
            "destination",
            "Viewsical cannot write to the download folder. Choose another folder.",
        );
    }
    if lower.contains("timed out")
        || lower.contains("unable to download")
        || lower.contains("network")
    {
        return AppError::new(
            "network",
            "The download connection failed. Check your connection, then resume.",
        );
    }
    AppError::new("download_failed", "The download helper could not finish this video. Check your connection or sign-in, then resume. If it keeps failing, update the bundled YouTube helper.")
}

pub(crate) async fn validate_media(
    tools: &ToolPaths,
    path: &Path,
    mode: &str,
    cancel: Option<&CancellationToken>,
) -> AppResult<()> {
    if !path.is_file() || std::fs::metadata(path).map_err(AppError::io)?.len() == 0 {
        return Err(AppError::new(
            "incomplete",
            "The downloaded file is empty or missing. Resume to try again.",
        ));
    }
    let mut command = Command::new(tools.ffprobe()?);
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_type",
            "-of",
            "json",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    hide_command(&mut command);
    let timeout = tokio::time::timeout(Duration::from_secs(45), command.output());
    let output = if let Some(token) = cancel {
        tokio::select! { _ = token.cancelled() => return Err(AppError::new("cancelled", "Validation was paused.")), result = timeout => result }
    } else {
        timeout.await
    };
    let output = output
        .map_err(|_| {
            AppError::new(
                "validation_timeout",
                "Media validation took too long. Resume to try again.",
            )
        })?
        .map_err(AppError::io)?;
    let data: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        AppError::new(
            "invalid_media",
            "The downloaded file could not be read as media. Resume or choose another format.",
        )
    })?;
    let duration = data["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.);
    let expected = if mode == "audio" { "audio" } else { "video" };
    let has_stream = data["streams"]
        .as_array()
        .is_some_and(|a| a.iter().any(|s| s["codec_type"] == expected));
    if !output.status.success() || !duration.is_finite() || duration <= 0. || !has_stream {
        return Err(AppError::new("invalid_media", "The downloaded file is incomplete or lacks the selected media stream. Resume or choose another format."));
    }
    Ok(())
}

pub(crate) fn hide_command(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Every helper process and its descendants terminate when this guard or the app exits.
pub(crate) struct ProcessJob {
    #[cfg(windows)]
    handle: isize,
}
impl ProcessJob {
    pub(crate) fn attach(child: &Child) -> AppResult<Self> {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::{
                Foundation::{CloseHandle, HANDLE},
                System::JobObjects::*,
            };
            let job = CreateJobObjectW(None, None).map_err(AppError::io)?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) {
                let _ = CloseHandle(job);
                return Err(AppError::io(error));
            }
            let handle = child.raw_handle().ok_or_else(|| {
                AppError::new(
                    "process",
                    "The helper process exited before it could be managed.",
                )
            })?;
            if let Err(error) = AssignProcessToJobObject(job, HANDLE(handle)) {
                let _ = CloseHandle(job);
                return Err(AppError::io(error));
            }
            Ok(Self {
                handle: job.0 as isize,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }
}
impl Drop for ProcessJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.handle as *mut _,
            ));
        }
    }
}

#[tauri::command]
pub async fn enqueue_download(
    app: AppHandle,
    state: State<'_, AppState>,
    request: DownloadRequest,
) -> AppResult<DownloadTask> {
    state.downloads.enqueue(&app, request).await
}
#[tauri::command]
pub async fn download_action(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    action: String,
) -> AppResult<()> {
    state.downloads.action(&app, &task_id, &action).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn validates_stable_youtube_ids() {
        assert!(valid_video_id("BaW_jenozKc"));
        assert!(!valid_video_id("../../evil"));
        assert!(!valid_video_id("--exec=oops"));
    }
    #[test]
    fn preserves_no_unknown_progress_as_complete() {
        let mut task: DownloadTask = serde_json::from_value(json!({"id":"a","video":MediaItem::default(),"mode":"video","quality":1080,"format":"mp4","destination":"C:\\Downloads","status":"resolving","progress":0,"downloadedBytes":0,"totalBytes":null,"speed":null,"eta":null,"outputPath":null,"error":null,"createdAt":0,"sessionGeneration":1})).unwrap();
        update_progress(
            &mut task,
            &json!({"downloaded_bytes":100,"total_bytes":100,"status":"finished"}),
        );
        assert_eq!(task.status, "downloading");
        assert_eq!(task.progress, 99.);
        assert!(task.output_path.is_none());
        update_progress(&mut task, &json!({"downloaded_bytes":20}));
        assert!(task.total_bytes.is_none());
        assert_ne!(task.status, "completed");
    }
    #[test]
    fn resumed_formats_cannot_contain_options_or_paths() {
        assert!(valid_format_ids("137+140"));
        assert!(!valid_format_ids("137 --exec evil"));
        assert!(!valid_format_ids("https://example.com"));
    }
    #[test]
    fn errors_do_not_expose_session_material() {
        let result =
            download_error("ERROR: https://cdn.example/?secret=123 cookies are no longer valid");
        assert_eq!(result.code, "sign_in_required");
        assert!(!result.message.contains("secret"));
    }
    #[test]
    fn source_identity_ignores_expiring_urls_but_rejects_changed_bytes() {
        let a = json!({"id":"BaW_jenozKc","format_id":"137+140","requested_formats":[{"format_id":"137","vcodec":"avc1","filesize":100,"url":"https://cdn.example/?secret=old"},{"format_id":"140","acodec":"aac","filesize":40}]});
        let mut b = a.clone();
        b["requested_formats"][0]["url"] = json!("https://cdn.example/?secret=new");
        assert!(identity_compatible(
            &stream_identity(&a),
            &stream_identity(&b)
        ));
        assert!(!serde_json::to_string(&stream_identity(&a))
            .unwrap()
            .contains("secret"));
        b["requested_formats"][0]["filesize"] = json!(120);
        assert!(!identity_compatible(
            &stream_identity(&a),
            &stream_identity(&b)
        ));
    }
}
