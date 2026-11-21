//! Persistent, disposable media bytes. Signed sources and credentials are never
//! written to this index. Only complete, independently probed components publish.
use crate::{
    models::*,
    runtime::{now, AppPaths},
    youtube::PlaybackPlan,
    AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const DEFAULT_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const MIN_LIMIT: u64 = 128 * 1024 * 1024;
const MAX_LIMIT: u64 = 100 * 1024 * 1024 * 1024;
const MAX_CACHE_DURATION_SECONDS: f64 = 300.;

pub(crate) fn cacheable_duration(duration: Option<f64>) -> bool {
    duration.is_some_and(|seconds| seconds > 0. && seconds <= MAX_CACHE_DURATION_SECONDS)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    video: MediaItem,
    mode: String,
    quality: u32,
    #[serde(default)]
    qualities: Vec<u32>,
    file: String,
    bytes: u64,
    duration: f64,
    last_accessed: u64,
    account: bool,
    #[serde(default)]
    retired: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    enabled: bool,
    max_bytes: u64,
    entries: Vec<Record>,
}
impl Default for Index {
    fn default() -> Self {
        Self {
            enabled: true,
            max_bytes: DEFAULT_LIMIT,
            entries: vec![],
        }
    }
}
struct Inner {
    index: Index,
    pins: HashMap<String, usize>,
    jobs: HashMap<String, (uuid::Uuid, CancellationToken)>,
}
pub struct MediaCache {
    root: PathBuf,
    inner: Mutex<Inner>,
    events: Mutex<Option<AppHandle>>,
    slots: tokio::sync::Semaphore,
    closing: AtomicBool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    id: String,
    video_id: String,
    title: String,
    mode: String,
    quality: u32,
    bytes: u64,
    last_accessed: u64,
    pinned: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSummary {
    enabled: bool,
    max_bytes: u64,
    total_bytes: u64,
    audio_bytes: u64,
    video_bytes: u64,
    pending_bytes: u64,
    entry_count: usize,
    active_count: usize,
    entries: Vec<CacheEntry>,
}
pub struct CacheLease {
    cache: Arc<MediaCache>,
    ids: Vec<String>,
}
impl Drop for CacheLease {
    fn drop(&mut self) {
        let mut inner = self.cache.inner.lock().unwrap_or_else(|p| p.into_inner());
        for id in &self.ids {
            if let Some(count) = inner.pins.get_mut(id) {
                *count = count.saturating_sub(1);
            }
        }
        inner.pins.retain(|_, count| *count > 0);
        self.cache.prune_locked(&mut inner, false);
        let _ = self.cache.save_locked(&inner);
        drop(inner);
        self.cache.notify();
    }
}
pub struct CachedPlayback {
    pub plan: PlaybackPlan,
    pub lease: CacheLease,
}

impl MediaCache {
    pub fn new(paths: &AppPaths) -> AppResult<Self> {
        let root = paths.data.join("media-cache");
        std::fs::create_dir_all(&root).map_err(AppError::io)?;
        if std::fs::symlink_metadata(&root)
            .map_err(AppError::io)?
            .file_type()
            .is_symlink()
            || !root
                .canonicalize()
                .map_err(AppError::io)?
                .starts_with(paths.data.canonicalize().map_err(AppError::io)?)
        {
            return Err(AppError::new(
                "cache_path",
                "The internal cache folder is not valid.",
            ));
        }
        let mut index: Index = std::fs::read(root.join("index.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        index.max_bytes = index.max_bytes.clamp(MIN_LIMIT, MAX_LIMIT);
        index
            .entries
            .retain(|r| !r.retired && valid_record(&root, r));
        let known: HashSet<_> = index.entries.iter().map(|r| r.file.clone()).collect();
        // A crash may leave unpublished components. Delete only our flat UUID
        // media names; never follow directories, links, or a manifest path.
        for entry in std::fs::read_dir(&root).map_err(AppError::io)?.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if owned_name(&file) && !known.contains(&file) {
                remove_owned(&root, &file);
            }
        }
        let cache = Self {
            root,
            events: Mutex::new(None),
            inner: Mutex::new(Inner {
                index,
                pins: HashMap::new(),
                jobs: HashMap::new(),
            }),
            slots: tokio::sync::Semaphore::new(1),
            closing: AtomicBool::new(false),
        };
        {
            let mut inner = cache.inner.lock().unwrap();
            cache.prune_locked(&mut inner, false);
            cache.save_locked(&inner)?;
        }
        Ok(cache)
    }
    fn save_locked(&self, inner: &Inner) -> AppResult<()> {
        let tmp = self.root.join("index.new");
        std::fs::write(
            &tmp,
            serde_json::to_vec(&inner.index).map_err(AppError::io)?,
        )
        .map_err(AppError::io)?;
        std::fs::rename(tmp, self.root.join("index.json")).map_err(AppError::io)
    }
    fn prune_locked(&self, inner: &mut Inner, all: bool) {
        inner.index.entries.sort_by_key(|r| r.last_accessed);
        let mut total: u64 = inner.index.entries.iter().map(|r| r.bytes).sum();
        let pins = &inner.pins;
        let limit = inner.index.max_bytes;
        inner.index.entries.retain(|r| {
            let remove = all || r.retired || total > limit || !valid_record(&self.root, r);
            if remove && pins.get(&r.id).copied().unwrap_or(0) == 0 {
                remove_owned(&self.root, &r.file);
                // Failed file removal (for example a short-lived decoder handle)
                // stays indexed so the usage remains honest and can be retried.
                if !self.root.join(&r.file).exists() {
                    total = total.saturating_sub(r.bytes);
                    return false;
                }
            }
            true
        });
    }
    pub fn summary(&self) -> CacheSummary {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut entries: Vec<_> = inner
            .index
            .entries
            .iter()
            .map(|r| CacheEntry {
                id: r.id.clone(),
                video_id: if r.retired && r.account {
                    String::new()
                } else {
                    r.video.id.clone()
                },
                title: if r.retired && r.account {
                    "Media pending removal".into()
                } else {
                    r.video.title.clone()
                },
                mode: r.mode.clone(),
                quality: r.quality,
                bytes: r.bytes,
                last_accessed: r.last_accessed,
                pinned: inner.pins.get(&r.id).copied().unwrap_or(0) > 0,
            })
            .collect();
        entries.sort_by_key(|r| std::cmp::Reverse(r.last_accessed));
        let pending_bytes = std::fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                owned_name(&name) && name.contains("partial")
            })
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.metadata().ok())
            .map(|m| m.len())
            .sum::<u64>();
        CacheSummary {
            enabled: inner.index.enabled,
            max_bytes: inner.index.max_bytes,
            total_bytes: entries
                .iter()
                .map(|r| r.bytes)
                .sum::<u64>()
                .saturating_add(pending_bytes),
            pending_bytes,
            audio_bytes: entries
                .iter()
                .filter(|r| r.mode == "audio")
                .map(|r| r.bytes)
                .sum(),
            video_bytes: entries
                .iter()
                .filter(|r| r.mode == "video")
                .map(|r| r.bytes)
                .sum(),
            entry_count: entries.len(),
            active_count: inner.jobs.len(),
            entries,
        }
    }
    fn emit(&self, app: &AppHandle) {
        if let Ok(mut target) = self.events.lock() {
            *target = Some(app.clone());
        }
        let _ = app.emit_to("main", "cache-changed", self.summary());
    }
    fn notify(&self) {
        let app = self.events.lock().ok().and_then(|target| target.clone());
        if let Some(app) = app {
            self.emit(&app);
        }
    }
    pub fn configure(
        &self,
        app: &AppHandle,
        enabled: bool,
        max_bytes: u64,
    ) -> AppResult<CacheSummary> {
        if !(MIN_LIMIT..=MAX_LIMIT).contains(&max_bytes) {
            return Err(AppError::new(
                "cache_limit",
                "Choose a cache limit between 128 MB and 100 GB.",
            ));
        }
        {
            let mut inner = self.inner.lock().map_err(AppError::io)?;
            inner.index.enabled = enabled;
            inner.index.max_bytes = max_bytes;
            // Cancel unpublished work when settings change. Existing complete
            // components remain usable even if automatic caching is disabled.
            for (_, token) in inner.jobs.values() {
                token.cancel();
            }
            self.prune_locked(&mut inner, false);
            self.save_locked(&inner)?;
        }
        self.emit(app);
        Ok(self.summary())
    }
    pub fn clear(
        &self,
        app: &AppHandle,
        kind: &str,
        entry_id: Option<&str>,
    ) -> AppResult<CacheSummary> {
        if !matches!(kind, "all" | "audio" | "video") {
            return Err(AppError::new(
                "invalid_input",
                "Choose audio, video, or all cached media.",
            ));
        }
        {
            let mut inner = self.inner.lock().map_err(AppError::io)?;
            for (_, token) in inner.jobs.values() {
                token.cancel();
            }
            let pins = inner.pins.clone();
            inner.index.entries.retain_mut(|r| {
                let selected = entry_id.map_or(kind == "all" || r.mode == kind, |id| r.id == id);
                if selected {
                    r.retired = true;
                }
                if selected && pins.get(&r.id).copied().unwrap_or(0) == 0 {
                    remove_owned(&self.root, &r.file);
                    return self.root.join(&r.file).exists();
                }
                true
            });
            self.save_locked(&inner)?;
        }
        self.emit(app);
        Ok(self.summary())
    }
    pub fn invalidate_account(&self, app: &AppHandle) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            for (_, token) in inner.jobs.values() {
                token.cancel();
            }
            for r in &mut inner.index.entries {
                if r.account {
                    r.retired = true;
                    r.video = MediaItem::default();
                }
            }
            self.prune_locked(&mut inner, false);
            let _ = self.save_locked(&inner);
        }
        self.emit(app);
    }
    pub fn find(
        self: &Arc<Self>,
        item: &MediaItem,
        quality: u32,
        mode: &str,
        generation: u64,
        account: bool,
    ) -> Option<CachedPlayback> {
        let mut inner = self.inner.lock().ok()?;
        let allowed = |r: &&Record| {
            r.video.id == item.id
                && !r.retired
                && (!r.account || account)
                && valid_record(&self.root, r)
        };
        let audio = inner
            .index
            .entries
            .iter()
            .filter(allowed)
            .filter(|r| r.mode == "audio")
            .max_by_key(|r| (r.account == account, r.last_accessed))?
            .clone();
        let video = if mode == "video" {
            Some(
                inner
                    .index
                    .entries
                    .iter()
                    .filter(allowed)
                    .filter(|r| r.mode == "video" && r.quality <= quality)
                    .max_by_key(|r| (r.quality, r.account == account, r.last_accessed))?
                    .clone(),
            )
        } else {
            None
        };
        let mut ids = vec![audio.id.clone()];
        if let Some(v) = &video {
            ids.push(v.id.clone());
        }
        for id in &ids {
            *inner.pins.entry(id.clone()).or_default() += 1;
        }
        for r in &mut inner.index.entries {
            if ids.contains(&r.id) {
                r.last_accessed = now();
            }
        }
        let _ = self.save_locked(&inner);
        let selected = video.as_ref().unwrap_or(&audio);
        let plan = PlaybackPlan {
            video_url: self.root.join(&selected.file).to_string_lossy().into(),
            audio_url: video
                .as_ref()
                .map(|_| self.root.join(&audio.file).to_string_lossy().into()),
            headers: vec![],
            audio_headers: vec![],
            selected_quality: selected.quality,
            qualities: video
                .as_ref()
                .map(|v| {
                    let mut qualities = v.qualities.clone();
                    if !qualities.contains(&v.quality) {
                        qualities.push(v.quality);
                    }
                    qualities
                })
                .unwrap_or_default(),
            session_generation: generation,
            video: selected.video.clone(),
            storyboard: None,
            mode: mode.into(),
            protocol: "cache".into(),
            format_id: "internal-cache".into(),
            expires_at: None,
        };
        tracing::info!(video_id=%item.id, mode, quality=selected.quality, "Internal media cache hit");
        drop(inner);
        self.notify();
        Some(CachedPlayback {
            plan,
            lease: CacheLease {
                cache: self.clone(),
                ids,
            },
        })
    }
    pub fn schedule(self: &Arc<Self>, app: &AppHandle, plan: PlaybackPlan) {
        if self.closing.load(Ordering::SeqCst)
            || plan.protocol == "cache"
            || !plan.video_url.starts_with("https://")
            || !cacheable_duration(plan.video.duration)
        {
            return;
        }
        let snapshot = app.state::<AppState>().sessions.snapshot();
        if snapshot.generation != plan.session_generation {
            return;
        }
        let account = matches!(snapshot.status.as_str(), "connected" | "restoring");
        let key = format!(
            "{}:{account}:{}:{}",
            plan.video.id, plan.mode, plan.selected_quality
        );
        let nonce = uuid::Uuid::new_v4();
        let cancel = CancellationToken::new();
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if !inner.index.enabled {
                return;
            }
            let has = |mode: &str| {
                inner.index.entries.iter().any(|r| {
                    !r.retired
                        && r.account == account
                        && r.video.id == plan.video.id
                        && r.mode == mode
                        && (mode == "audio" || r.quality == plan.selected_quality)
                        && valid_record(&self.root, r)
                })
            };
            if has("audio") && (plan.mode == "audio" || has("video")) {
                return;
            }
            if let Some((_, old)) = inner.jobs.insert(key.clone(), (nonce, cancel.clone())) {
                old.cancel();
            }
            // Cache only the current media; rapid queue changes must not leave
            // a backlog consuming bandwidth for every previous selection.
            for (other, (_, token)) in &inner.jobs {
                if other != &key {
                    token.cancel();
                }
            }
        }
        self.emit(app);
        let cache = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = cache.fill(&app, &plan, account, &cancel).await;
            if let Err(error) = result {
                tracing::info!(video_id=%plan.video.id, category=%error.code, "Background media cache did not complete");
            }
            {
                let mut inner = cache.inner.lock().unwrap_or_else(|p| p.into_inner());
                if inner.jobs.get(&key).is_some_and(|(id, _)| *id == nonce) {
                    inner.jobs.remove(&key);
                }
            }
            cache.emit(&app);
        });
    }
    async fn fill(
        &self,
        app: &AppHandle,
        plan: &PlaybackPlan,
        account: bool,
        cancel: &CancellationToken,
    ) -> AppResult<()> {
        let _slot = tokio::select! { _ = cancel.cancelled() => return Err(cancelled()), slot = self.slots.acquire() => slot.map_err(AppError::io)? };
        self.check_current(app, plan, cancel)?;
        let limit = self.inner.lock().map_err(AppError::io)?.index.max_bytes;
        let tools = app.state::<AppState>().tools.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let audio_name = format!("{id}-a.partial.mka");
        let video_name = format!("{id}-v.partial.mkv");
        let audio = self.root.join(&audio_name);
        let video = self.root.join(&video_name);
        let cleanup = PartialFiles {
            files: vec![audio.clone(), video.clone()],
        };
        let mut command = Command::new(tools.ffmpeg()?);
        command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
        input(&mut command, &plan.video_url, &plan.headers);
        if let Some(source) = &plan.audio_url {
            input(&mut command, source, &plan.audio_headers);
        }
        if plan.mode == "video" {
            command
                .args([
                    "-map",
                    "0:v:0",
                    "-an",
                    "-c",
                    "copy",
                    "-map_metadata",
                    "-1",
                    "-fs",
                    &limit.to_string(),
                    "-f",
                    "matroska",
                ])
                .arg(&video);
        }
        command
            .args([
                "-map",
                if plan.audio_url.is_some() {
                    "1:a:0"
                } else {
                    "0:a:0"
                },
                "-vn",
                "-c",
                "copy",
                "-map_metadata",
                "-1",
                "-fs",
                &limit.to_string(),
                "-f",
                "matroska",
            ])
            .arg(&audio);
        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| AppError::new("cache_worker", "Could not start media caching."))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(6 * 60 * 60);
        let mut last_report = tokio::time::Instant::now();
        let status = loop {
            tokio::select! {
                _ = cancel.cancelled() => { let _ = child.kill().await; let _ = child.wait().await; return Err(cancelled()); }
                status = child.wait() => break status.map_err(AppError::io)?,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    let partial_size: u64 = [&audio, &video].iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
                    let over_budget = {
                        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                        let max = inner.index.max_bytes;
                        inner.index.max_bytes = max.saturating_sub(partial_size);
                        self.prune_locked(&mut inner, false);
                        inner.index.max_bytes = max;
                        let _ = self.save_locked(&inner);
                        inner.index.entries.iter().map(|r| r.bytes).sum::<u64>().saturating_add(partial_size) > max
                    };
                    if last_report.elapsed() >= Duration::from_secs(2) { self.emit(app); last_report=tokio::time::Instant::now(); }
                    if over_budget || tokio::time::Instant::now() > deadline || self.check_current(app, plan, cancel).is_err() {
                        let _ = child.kill().await; let _ = child.wait().await;
                        return Err(AppError::new("cache_limit", "Media cache work was stopped."));
                    }
                }
            }
        };
        if !status.success() {
            return Err(AppError::new(
                "cache_source",
                "The media source could not be cached.",
            ));
        }
        if [&audio, &video]
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .any(|m| m.len() >= limit.saturating_sub(64 * 1024))
        {
            return Err(AppError::new(
                "cache_limit",
                "The media reached the cache size limit before completion.",
            ));
        }
        let mut records = vec![];
        for (path, mode, quality, suffix) in [
            (&audio, "audio", 0, "a.mka"),
            (&video, "video", plan.selected_quality, "v.mkv"),
        ] {
            if mode == "video" && plan.mode == "audio" {
                continue;
            }
            let duration =
                probe(&tools.ffprobe()?, path, mode, plan.video.duration, cancel).await?;
            self.check_current(app, plan, cancel)?;
            let bytes = std::fs::metadata(path).map_err(AppError::io)?.len();
            let record_id = uuid::Uuid::new_v4().to_string();
            records.push((
                path.clone(),
                Record {
                    file: format!("{record_id}-{suffix}"),
                    id: record_id,
                    video: plan.video.clone(),
                    mode: mode.into(),
                    quality,
                    qualities: plan.qualities.clone(),
                    bytes,
                    duration,
                    last_accessed: now(),
                    account,
                    retired: false,
                },
            ));
        }
        {
            let mut inner = self.inner.lock().map_err(AppError::io)?;
            self.check_current(app, plan, cancel)?;
            let bytes: u64 = records.iter().map(|(_, r)| r.bytes).sum();
            if !inner.index.enabled || bytes > inner.index.max_bytes {
                return Err(AppError::new(
                    "cache_limit",
                    "This video is larger than the media cache limit.",
                ));
            }
            for (partial, record) in records {
                // Reuse an already complete component instead of accumulating
                // copies when mode/quality changes while caching is finishing.
                if inner.index.entries.iter().any(|r| {
                    !r.retired
                        && r.account == account
                        && r.video.id == record.video.id
                        && r.mode == record.mode
                        && r.quality == record.quality
                        && valid_record(&self.root, r)
                }) {
                    continue;
                }
                std::fs::rename(partial, self.root.join(&record.file)).map_err(AppError::io)?;
                inner.index.entries.push(record);
            }
            self.prune_locked(&mut inner, false);
            self.save_locked(&inner)?;
        }
        drop(cleanup);
        tracing::info!(video_id=%plan.video.id, mode=%plan.mode, "Validated media added to internal cache");
        Ok(())
    }
    fn check_current(
        &self,
        app: &AppHandle,
        plan: &PlaybackPlan,
        cancel: &CancellationToken,
    ) -> AppResult<()> {
        if cancel.is_cancelled()
            || self.closing.load(Ordering::SeqCst)
            || app.state::<AppState>().sessions.snapshot().generation != plan.session_generation
        {
            return Err(cancelled());
        }
        Ok(())
    }
    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        for (_, token) in inner.jobs.values() {
            token.cancel();
        }
    }
    pub fn cancel_pending(&self, app: &AppHandle) {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.jobs.is_empty() {
            return;
        }
        for (_, token) in inner.jobs.values() {
            token.cancel();
        }
        drop(inner);
        self.emit(app);
    }
    pub(crate) fn has_jobs(&self) -> bool {
        !self.inner.lock().unwrap_or_else(|p| p.into_inner()).jobs.is_empty()
    }
    pub async fn shutdown(&self) {
        self.begin_shutdown();
        for _ in 0..50 {
            if self
                .inner
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .jobs
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
fn input(command: &mut Command, url: &str, headers: &[(String, String)]) {
    command.args(["-rw_timeout", "15000000"]);
    if !headers.is_empty() {
        let value: String = headers
            .iter()
            .filter(|(k, v)| !k.contains(['\r', '\n']) && !v.contains(['\r', '\n']))
            .map(|(k, v)| format!("{k}: {v}\r\n"))
            .collect();
        command.arg("-headers").arg(value);
    }
    command.arg("-i").arg(url);
}
async fn probe(
    tool: &Path,
    path: &Path,
    mode: &str,
    expected: Option<f64>,
    cancel: &CancellationToken,
) -> AppResult<f64> {
    let mut command = Command::new(tool);
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,duration:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled()),
        output = tokio::time::timeout(Duration::from_secs(20), command.output()) => output.map_err(|_| AppError::new("cache_validation", "Cached media validation timed out."))?.map_err(AppError::io)?,
    };
    if !output.status.success() {
        return Err(AppError::new(
            "cache_validation",
            "The cached media could not be validated.",
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| AppError::new("cache_validation", "The cached media could not be read."))?;
    validate_probe(&value, mode, expected)
}
fn validate_probe(value: &Value, mode: &str, expected: Option<f64>) -> AppResult<f64> {
    let error = || {
        AppError::new(
            "cache_validation",
            "The cached media is incomplete or has a missing track.",
        )
    };
    if !value["streams"]
        .as_array()
        .is_some_and(|s| s.iter().any(|s| s["codec_type"] == mode))
    {
        return Err(error());
    }
    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.)
        .ok_or_else(error)?;
    let expected = expected
        .filter(|d| d.is_finite() && *d > 0.)
        .ok_or_else(error)?;
    if (duration - expected).abs() > (expected * 0.001).clamp(1.5, 3.) {
        return Err(error());
    }
    Ok(duration)
}
fn cancelled() -> AppError {
    AppError::new("cancelled", "Media caching was cancelled.")
}
fn owned_name(name: &str) -> bool {
    ["-a.mka", "-v.mkv", "-a.partial.mka", "-v.partial.mkv"]
        .iter()
        .any(|suffix| {
            name.strip_suffix(suffix)
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        })
}
fn valid_record(root: &Path, r: &Record) -> bool {
    owned_name(&r.file)
        && !r.file.contains("partial")
        && matches!(r.mode.as_str(), "audio" | "video")
        && r.duration.is_finite()
        && r.duration > 0.
        && r.bytes > 0
        && std::fs::symlink_metadata(root.join(&r.file))
            .ok()
            .is_some_and(|m| m.file_type().is_file() && m.len() == r.bytes)
}
fn remove_owned(root: &Path, file: &str) {
    if owned_name(file)
        && std::fs::symlink_metadata(root.join(file)).is_ok_and(|m| m.file_type().is_file())
    {
        let _ = std::fs::remove_file(root.join(file));
    }
}
struct PartialFiles {
    files: Vec<PathBuf>,
}
impl Drop for PartialFiles {
    fn drop(&mut self) {
        for file in &self.files {
            let _ = std::fs::remove_file(file);
        }
    }
}

#[tauri::command]
pub async fn cache_summary(app: AppHandle, state: State<'_, AppState>) -> AppResult<CacheSummary> {
    if let Ok(mut target) = state.cache.events.lock() {
        *target = Some(app);
    }
    Ok(state.cache.summary())
}
#[tauri::command]
pub async fn cache_configure(
    app: AppHandle,
    enabled: bool,
    max_bytes: u64,
    state: State<'_, AppState>,
) -> AppResult<CacheSummary> {
    state.cache.configure(&app, enabled, max_bytes)
}
#[tauri::command]
pub async fn cache_clear(
    app: AppHandle,
    kind: String,
    entry_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<CacheSummary> {
    state.cache.clear(&app, &kind, entry_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_cache_requires_a_known_duration_of_at_most_five_minutes() {
        assert!(cacheable_duration(Some(299.)));
        assert!(cacheable_duration(Some(300.)));
        for duration in [
            None,
            Some(0.),
            Some(-1.),
            Some(300.01),
            Some(301.),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert!(
                !cacheable_duration(duration),
                "unexpected eligibility for {duration:?}"
            );
        }
    }

    #[test]
    fn truncated_or_silent_components_never_become_offline_media() {
        let v = serde_json::json!({"streams":[{"codec_type":"video"}],"format":{"duration":"20"}});
        assert!(validate_probe(&v, "audio", Some(20.)).is_err());
        assert!(validate_probe(&v, "video", Some(100.)).is_err());
        assert!(validate_probe(&v, "video", None).is_err());
        assert_eq!(validate_probe(&v, "video", Some(20.)).unwrap(), 20.);
    }
    #[test]
    fn cache_names_cannot_escape_flat_owned_directory() {
        assert!(!owned_name("../../library.sqlite3"));
        assert!(!owned_name("C:\\outside-a.mka"));
        assert!(owned_name(&format!("{}-a.mka", uuid::Uuid::new_v4())));
    }
    #[test]
    fn restart_removes_partials_keeps_valid_components_and_respects_pins() {
        let root = std::env::temp_dir().join(format!("tubedesk-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let paths = AppPaths {
            data: root.clone(),
            auth: root.join("auth"),
            temp: root.join("temp"),
            downloads: root.join("downloads"),
        };
        let cache = Arc::new(MediaCache::new(&paths).unwrap());
        let id = uuid::Uuid::new_v4().to_string();
        let file = format!("{id}-a.mka");
        std::fs::write(cache.root.join(&file), b"validated-fixture").unwrap();
        let item = MediaItem {
            id: "jNQXAC9IVRw".into(),
            youtube_loudness_db: Some(6.),
            ..Default::default()
        };
        {
            let mut inner = cache.inner.lock().unwrap();
            inner.index.entries.push(Record {
                id,
                video: item.clone(),
                mode: "audio".into(),
                quality: 0,
                qualities: vec![],
                file,
                bytes: 17,
                duration: 19.,
                last_accessed: 1,
                account: true,
                retired: false,
            });
            cache.save_locked(&inner).unwrap();
        }
        assert!(cache.find(&item, 1080, "audio", 1, false).is_none());
        let cached = cache.find(&item, 1080, "audio", 1, true).unwrap();
        assert_eq!(cached.plan.video.youtube_loudness_db, Some(6.));
        {
            let mut inner = cache.inner.lock().unwrap();
            inner.index.entries[0].retired = true;
            cache.prune_locked(&mut inner, false);
            assert_eq!(inner.index.entries.len(), 1);
        }
        assert!(cache.find(&item, 1080, "audio", 2, true).is_none());
        drop(cached);
        assert_eq!(cache.summary().entry_count, 0);
        let partial = format!("{}-v.partial.mkv", uuid::Uuid::new_v4());
        std::fs::write(cache.root.join(&partial), b"partial").unwrap();
        drop(cache);
        let reopened = MediaCache::new(&paths).unwrap();
        assert!(!reopened.root.join(partial).exists());
        assert_eq!(reopened.summary().entry_count, 0);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
