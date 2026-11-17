use crate::{
    downloads::{hide_command, valid_video_id, ProcessJob},
    media_cache::CacheLease,
    models::*,
    runtime::ToolPaths,
    store::Store,
    youtube::PlaybackPlan,
    AppState,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{oneshot, Mutex as AsyncMutex},
};
#[cfg(windows)]
type PipeWriter = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;
#[cfg(not(windows))]
type PipeWriter = tokio::io::Sink;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayAction {
    Toggle,
    Pause,
    Resume,
    Seek,
    Volume,
    AdjustVolume,
    Mute,
    Speed,
    Quality,
    Mode,
    Next,
    Previous,
    Fullscreen,
    Theater,
    FocusControls,
    Scroll,
}
impl OverlayAction {
    fn name(self) -> &'static str {
        match self {
            Self::Toggle => "toggle",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Seek => "seek",
            Self::Volume => "volume",
            Self::AdjustVolume => "adjust-volume",
            Self::Mute => "mute",
            Self::Speed => "speed",
            Self::Quality => "quality",
            Self::Mode => "mode",
            Self::Next => "next",
            Self::Previous => "previous",
            Self::Fullscreen => "fullscreen",
            Self::Theater => "theater",
            Self::FocusControls => "focus-controls",
            Self::Scroll => "scroll",
        }
    }
    fn switches_source(self) -> bool {
        matches!(self, Self::Quality | Self::Mode)
    }
    fn is_ui_request(self) -> bool {
        matches!(
            self,
            Self::Next
                | Self::Previous
                | Self::Fullscreen
                | Self::Theater
                | Self::FocusControls
                | Self::Scroll
        )
    }
}

fn ensure_control_load(expected: u64, current: u64, closing: bool) -> AppResult<()> {
    if expected == 0 || expected != current || closing {
        Err(AppError::new("cancelled", "The selected video changed."))
    } else {
        Ok(())
    }
}
fn stepped_volume(current: f64, step: Option<f64>) -> AppResult<f64> {
    let step = step
        .filter(|value| *value == 5. || *value == -5.)
        .ok_or_else(|| AppError::new("invalid_value", "Use a five-point volume step."))?;
    Ok((current + step).clamp(0., 100.))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SourceToken {
    load: u64,
    attempt: u64,
}
#[derive(Default)]
struct EntryTracker {
    map: HashMap<i64, SourceToken>,
    active: Option<i64>,
    pending: Option<SourceToken>,
    early: VecDeque<(Option<i64>, Value)>,
}
impl EntryTracker {
    fn begin(&mut self, token: SourceToken) {
        self.pending = Some(token);
        self.early.clear();
    }
    fn bind(&mut self, id: i64, token: SourceToken) -> Vec<Value> {
        self.map.insert(id, token);
        self.pending = None;
        if self.map.len() > 32 {
            self.map
                .retain(|_, value| value.load >= token.load.saturating_sub(4));
        }
        self.early
            .drain(..)
            .filter_map(|(entry, value)| (entry == Some(id)).then_some(value))
            .collect()
    }
    fn route(&mut self, value: Value, current: SourceToken) -> Option<Value> {
        let kind = value["event"].as_str().unwrap_or("");
        let explicit = value["playlist_entry_id"].as_i64();
        if kind == "start-file" {
            self.active = explicit;
        }
        let entry = explicit.or(self.active);
        if let Some(token) = entry.and_then(|id| self.map.get(&id)).copied() {
            return (token == current).then_some(value);
        }
        if self.pending == Some(current) && self.early.len() < 96 {
            self.early.push_back((entry, value));
        }
        None
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum MediaFailure {
    Rejected,
    Network,
    Decoder,
    Unavailable,
    Premature,
    AudioMissing,
    #[default]
    Unknown,
}
impl MediaFailure {
    fn code(self) -> &'static str {
        match self {
            Self::Rejected => "source_rejected",
            Self::Network => "media_network",
            Self::Decoder => "media_decoder",
            Self::Unavailable => "media_unavailable",
            Self::Premature => "source_truncated",
            Self::AudioMissing => "audio_unavailable",
            Self::Unknown => "media_open",
        }
    }
}
#[derive(Clone)]
struct Recovery {
    item: MediaItem,
    quality: u32,
    mode: String,
    generation: u64,
    attempted: bool,
    prefer_hls: bool,
}
#[derive(Clone)]
struct LoadOptions {
    load: u64,
    generation: u64,
    fresh_preferences: bool,
    mode: String,
    force_refresh: bool,
    prefer_hls: bool,
}

#[derive(Clone)]
struct LocalSource {
    path: String,
    quality: u32,
    has_video: bool,
    loudness_db: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AudioTrack {
    id: i64,
    selected: bool,
    external: bool,
}
#[derive(Default)]
struct AudioState {
    tracks: Vec<AudioTrack>,
    expected_external: bool,
    decoded: bool,
    output: bool,
    checking: bool,
    repaired: bool,
}

impl AudioState {
    fn selected(&self) -> bool {
        self.tracks
            .iter()
            .any(|track| track.selected && (!self.expected_external || track.external))
    }
    fn preferred(&self) -> Option<i64> {
        self.tracks
            .iter()
            .find(|track| track.external && self.expected_external)
            .or_else(|| self.tracks.iter().find(|track| track.selected))
            .or_else(|| self.tracks.first())
            .map(|track| track.id)
    }
    fn ready(&self, paused: bool) -> bool {
        self.selected() && self.decoded && (self.output || paused)
    }
}

pub struct PlayerManager {
    tools: Arc<ToolPaths>,
    store: Arc<Store>,
    state: Mutex<PlayerState>,
    ui: Mutex<PlayerUiContext>,
    writer: AsyncMutex<Option<Arc<AsyncMutex<PipeWriter>>>>,
    process: AsyncMutex<Option<Child>>,
    process_job: Mutex<Option<ProcessJob>>,
    starting: AsyncMutex<()>,
    switching: AsyncMutex<()>,
    control_updates: AsyncMutex<()>,
    presentation_revision: Mutex<u64>,
    surface: Mutex<Option<isize>>,
    bounds: Mutex<PlayerBounds>,
    serial: AtomicU64,
    load: AtomicU64,
    attempt: AtomicU64,
    engine_epoch: AtomicU64,
    replies: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    entries: Mutex<EntryTracker>,
    recovery: Mutex<Option<Recovery>>,
    local_path: Mutex<Option<LocalSource>>,
    source_generation: AtomicU64,
    desired_pause: AtomicBool,
    cache_paused: AtomicBool,
    restarted: AtomicBool,
    loaded: AtomicBool,
    closing: AtomicBool,
    last_frame_emit: Mutex<Instant>,
    failure: Mutex<MediaFailure>,
    audio: Mutex<AudioState>,
    cache_lease: Mutex<Option<(SourceToken, CacheLease)>>,
    retired_leases: Mutex<Vec<(SourceToken, CacheLease)>>,
    ended_source: Mutex<Option<SourceToken>>,
    pending_cache: Mutex<Option<(SourceToken, PlaybackPlan)>>,
}
impl PlayerManager {
    pub fn new(tools: Arc<ToolPaths>, store: Arc<Store>) -> Self {
        let mut state = PlayerState::default();
        if let Ok(settings) = store.settings() {
            state.volume = settings.volume;
            state.muted = settings.muted;
            state.speed = settings.playback_rate;
            state.quality = settings.default_quality;
            state.requested_quality = settings.default_quality;
            if settings.always_audio_only {
                state.playback_mode = "audio".into();
            }
        }
        Self {
            tools,
            store,
            state: Mutex::new(state),
            ui: Mutex::new(PlayerUiContext::default()),
            writer: AsyncMutex::new(None),
            process: AsyncMutex::new(None),
            process_job: Mutex::new(None),
            starting: AsyncMutex::new(()),
            switching: AsyncMutex::new(()),
            control_updates: AsyncMutex::new(()),
            presentation_revision: Mutex::new(0),
            surface: Mutex::new(None),
            bounds: Mutex::new(PlayerBounds {
                x: 0.,
                y: 0.,
                width: 640.,
                height: 360.,
                visible: false,
                radius: None,
            }),
            serial: AtomicU64::new(1),
            load: AtomicU64::new(0),
            attempt: AtomicU64::new(0),
            engine_epoch: AtomicU64::new(0),
            replies: Mutex::new(HashMap::new()),
            entries: Mutex::new(EntryTracker::default()),
            recovery: Mutex::new(None),
            local_path: Mutex::new(None),
            source_generation: AtomicU64::new(0),
            desired_pause: AtomicBool::new(false),
            cache_paused: AtomicBool::new(false),
            restarted: AtomicBool::new(false),
            loaded: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            last_frame_emit: Mutex::new(Instant::now()),
            failure: Mutex::new(MediaFailure::Unknown),
            audio: Mutex::new(AudioState::default()),
            cache_lease: Mutex::new(None),
            retired_leases: Mutex::new(Vec::new()),
            ended_source: Mutex::new(None),
            pending_cache: Mutex::new(None),
        }
    }
    pub fn snapshot(&self) -> PlayerState {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }
    fn publish(&self, app: &AppHandle) {
        let _ = app.emit_to("main", "player-state", self.snapshot());
        self.publish_presentation(app);
        if let Ok(bounds) = self.bounds.lock() {
            crate::overlay::sync(app, bounds.clone(), self.video_visible());
        }
    }
    pub fn presentation(&self, app: &AppHandle) -> PlayerPresentation {
        let mut revision = self
            .presentation_revision
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *revision += 1;
        PlayerPresentation {
            revision: *revision,
            player: self.snapshot(),
            ui: self.ui.lock().map(|ui| ui.clone()).unwrap_or_default(),
            paused_intent: self.desired_pause.load(Ordering::SeqCst),
            overlay_error: crate::overlay::error(app),
        }
    }
    pub fn publish_presentation(&self, app: &AppHandle) {
        let presentation = self.presentation(app);
        let _ = app.emit_to("main", "player-presentation", &presentation);
        if app.get_webview_window("player-overlay").is_some() {
            let _ = app.emit_to("player-overlay", "player-presentation", &presentation);
        }
    }
    fn video_visible(&self) -> bool {
        let state = self.snapshot();
        state.video.is_some()
            && state.playback_mode == "video"
            && matches!(
                state.status.as_str(),
                "preparing" | "buffering" | "playing" | "paused"
            )
            && !self.closing.load(Ordering::SeqCst)
    }
    fn change(&self, app: &AppHandle, update: impl FnOnce(&mut PlayerState)) {
        if let Ok(mut s) = self.state.lock() {
            update(&mut s);
        }
        self.publish(app);
    }
    fn fail(self: &Arc<Self>, app: &AppHandle, error: &AppError) {
        self.change(app, |s| {
            s.status = "failed".into();
            s.error = Some(error.message.clone());
            s.error_code = Some(error.code.clone());
        });
        tracing::warn!(load_id=self.load.load(Ordering::SeqCst),category=%error.code,"Playback operation failed");
        let manager = self.clone();
        let token = self.token();
        tauri::async_runtime::spawn(async move {
            let _switch = manager.switching.lock().await;
            if manager.token() != token || manager.snapshot().status != "failed" {
                return;
            }
            if manager.writer.lock().await.is_some() {
                let _ = manager.send(json!(["stop"])).await;
            } else if let Some(mut child) = manager.process.lock().await.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            manager.retire_active_lease();
        });
    }
    fn save_history(&self) {
        let state = self.snapshot();
        if let Some(video) = state.video {
            let _ = self
                .store
                .record_history(&video, state.position, state.duration);
        }
    }
    fn token(&self) -> SourceToken {
        SourceToken {
            load: self.load.load(Ordering::SeqCst),
            attempt: self.attempt.load(Ordering::SeqCst),
        }
    }
    fn check_load(&self, app: &AppHandle, options: &LoadOptions) -> AppResult<()> {
        if self.closing.load(Ordering::SeqCst)
            || self.load.load(Ordering::SeqCst) != options.load
            || app.state::<AppState>().sessions.snapshot().generation != options.generation
        {
            return Err(AppError::new(
                "cancelled",
                "A newer video or account replaced this request.",
            ));
        }
        Ok(())
    }
    pub async fn play(
        self: &Arc<Self>,
        app: &AppHandle,
        item: MediaItem,
        quality: u32,
        start: Option<f64>,
        mode: Option<String>,
    ) -> AppResult<()> {
        validate_quality(quality)?;
        if !valid_video_id(&item.id) || item.kind != "video" {
            return Err(AppError::new(
                "invalid_video",
                "Choose a YouTube video to play.",
            ));
        }
        let requested_mode =
            validated_mode(mode.as_deref().unwrap_or(&self.snapshot().playback_mode))?.to_string();
        let mode = if self.store.settings()?.always_audio_only {
            "audio".into()
        } else {
            requested_mode
        };
        app.state::<AppState>().gateway.cancel("playback-source");
        app.state::<AppState>().cache.cancel_pending(app);
        self.save_history();
        let load = self.load.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = app.state::<AppState>().sessions.snapshot().generation;
        let options = LoadOptions {
            load,
            generation,
            fresh_preferences: true,
            mode: mode.clone(),
            force_refresh: false,
            prefer_hls: false,
        };
        self.source_generation.store(generation, Ordering::SeqCst);
        self.desired_pause.store(false, Ordering::SeqCst);
        if let Ok(mut local) = self.local_path.lock() {
            *local = None;
        }
        {
            let _switch = self.switching.lock().await;
            self.check_load(app, &options)?;
            if self.writer.lock().await.is_some() {
                let _ = self.send(json!(["stop"])).await;
            }
            self.change(app, |s| {
                s.status = "resolving".into();
                s.video = Some(item.clone());
                s.position = valid_start(start.unwrap_or(0.));
                s.duration = item.duration.unwrap_or(0.);
                s.qualities.clear();
                s.error = None;
                s.error_code = None;
                s.load_id = load;
                s.playback_mode = mode.clone();
                s.requested_quality = quality;
                s.buffered_seconds = 0.;
            });
        }
        if let Ok(mut context) = self.recovery.lock() {
            *context = Some(Recovery {
                item: item.clone(),
                quality,
                mode,
                generation,
                attempted: false,
                prefer_hls: false,
            });
        }
        let result = self.open_remote(app, &item, quality, start, options).await;
        if let Err(ref error) = result {
            if self.load.load(Ordering::SeqCst) == load && error.code != "cancelled" {
                self.fail(app, error);
            }
        }
        result
    }
    async fn open_remote(
        self: &Arc<Self>,
        app: &AppHandle,
        item: &MediaItem,
        quality: u32,
        start: Option<f64>,
        options: LoadOptions,
    ) -> AppResult<()> {
        self.check_load(app, &options)?;
        let cached = self
            .store
            .downloads()?
            .into_iter()
            .filter(|d| {
                !options.force_refresh
                    && d.status == "completed"
                    && d.video.id == item.id
                    && (options.mode == "audio" || d.mode == "video")
                    && (d.mode == "audio" || d.quality <= quality)
                    && d.output_path
                        .as_ref()
                        .is_some_and(|p| std::path::Path::new(p).is_file())
            })
            .max_by_key(|d| (d.mode == options.mode, d.quality));
        if let Some(cached) = cached {
            let source = LocalSource {
                path: cached.output_path.unwrap_or_default(),
                quality: cached.quality,
                has_video: cached.mode == "video",
                loudness_db: cached.video.youtube_loudness_db,
            };
            return self
                .open_local_source(app, source, item.clone(), start, options)
                .await;
        }
        if !options.force_refresh {
            let state = app.state::<AppState>();
            let account = matches!(
                state.sessions.snapshot().status.as_str(),
                "connected" | "restoring"
            );
            if let Some(cached) =
                state
                    .cache
                    .find(item, quality, &options.mode, options.generation, account)
            {
                self.ensure_engine(app).await?;
                let _switch = self.switching.lock().await;
                self.check_load(app, &options)?;
                if options.fresh_preferences {
                    self.apply_fresh_preferences(app).await?;
                }
                let position = valid_start(start.unwrap_or_else(|| self.saved_position(item)));
                let result = self.load_plan(app, cached.plan, position, &options).await;
                if result.is_ok() {
                    self.install_cache_lease(Some(cached.lease));
                }
                return result;
            }
        }
        let started = Instant::now();
        let plan = app
            .state::<AppState>()
            .gateway
            .resolve_mode(
                app,
                item,
                quality,
                &options.mode,
                options.force_refresh,
                options.prefer_hls,
            )
            .await?;
        self.check_load(app, &options)?;
        tracing::info!(load_id=options.load,video_id=%item.id,mode=%options.mode,protocol=%plan.protocol,format_id=%plan.format_id,quality=plan.selected_quality,elapsed_ms=started.elapsed().as_millis()as u64,"Playback sources resolved");
        self.ensure_engine(app).await?;
        let _switch = self.switching.lock().await;
        self.check_load(app, &options)?;
        if options.fresh_preferences {
            self.apply_fresh_preferences(app).await?;
            self.check_load(app, &options)?;
        }
        if let Ok(mut local) = self.local_path.lock() {
            *local = None;
        }
        let position = valid_start(start.unwrap_or_else(|| self.saved_position(item)));
        self.load_plan(app, plan, position, &options).await
    }
    fn saved_position(&self, item: &MediaItem) -> f64 {
        self.store
            .history()
            .ok()
            .and_then(|h| h.into_iter().find(|h| h.video.id == item.id))
            .filter(|h| h.duration <= 0. || h.position < h.duration - 8.)
            .map(|h| h.position)
            .unwrap_or(0.)
    }
    async fn apply_fresh_preferences(&self, app: &AppHandle) -> AppResult<()> {
        let settings = self.store.settings()?;
        for command in preference_commands(&settings) {
            self.send(command).await?;
        }
        self.change(app, |s| {
            s.volume = settings.volume;
            s.muted = settings.muted;
            s.speed = settings.playback_rate;
        });
        Ok(())
    }
    /// Settings changes update the active item's gain without reloading audio.
    /// Serialize with source commits and read the current item after acquiring
    /// the lock, so a late settings response cannot use a previous track's gain.
    pub async fn refresh_normalization(&self, _app: &AppHandle) -> AppResult<()> {
        let _switch = self.switching.lock().await;
        if self.writer.lock().await.is_none() || !self.loaded.load(Ordering::SeqCst) {
            return Ok(());
        }
        let item = self.snapshot().video;
        let gain = crate::normalization::gain_db(
            self.store.settings()?.normalize_audio,
            item.and_then(|item| item.youtube_loudness_db),
        );
        self.send(json!(["set_property", "volume-gain", gain]))
            .await?;
        Ok(())
    }
    async fn load_plan(
        self: &Arc<Self>,
        app: &AppHandle,
        plan: PlaybackPlan,
        start: f64,
        options: &LoadOptions,
    ) -> AppResult<()> {
        if plan.session_generation != options.generation {
            return Err(AppError::new(
                "session_changed",
                "Your YouTube session changed. Select the video again.",
            ));
        }
        let network = plan.protocol != "cache";
        let warming = network.then(|| plan.clone());
        let external_audio = if options.mode == "video" {
            plan.audio_url.clone()
        } else {
            None
        };
        self.local_path.lock().map_err(AppError::io)?.take();
        self.pending_cache.lock().map_err(AppError::io)?.take();
        let headers = normalized_headers(&plan.headers);
        let audio_headers = normalized_headers(&plan.audio_headers);
        if plan.audio_url.is_some() && !audio_headers.is_empty() && audio_headers != headers {
            return Err(AppError::new("source_context","These audio and video sources require different request contexts. Try another quality."));
        }
        self.send(json!([
            "set_property",
            "http-header-fields",
            headers
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect::<Vec<_>>()
        ]))
        .await?;
        let mut file_options = source_options(
            start,
            &options.mode,
            self.desired_pause.load(Ordering::SeqCst),
            network,
        );
        let gain = crate::normalization::gain_db(
            self.store.settings()?.normalize_audio,
            plan.video.youtube_loudness_db,
        );
        file_options.insert("volume-gain".into(), json!(gain.to_string()));

        self.change(app, |s| {
            s.status = "preparing".into();
            s.video = Some(plan.video);
            s.playback_mode = options.mode.clone();
            s.quality = if options.mode == "audio" {
                0
            } else {
                plan.selected_quality
            };
            s.qualities = if options.mode == "audio" {
                vec![]
            } else {
                plan.qualities
            };
            s.requested_quality = options_quality(s.requested_quality);
            s.position = start;
            s.error = None;
            s.error_code = None;
            s.buffered_seconds = 0.;
        });
        self.commit_file(app, &plan.video_url, file_options, options, external_audio)
            .await?;
        if network {
            self.install_cache_lease(None);
            *self.pending_cache.lock().map_err(AppError::io)? =
                warming.map(|plan| (self.token(), plan));
            self.maybe_warm(app);
        }
        Ok(())
    }
    async fn open_local_source(
        self: &Arc<Self>,
        app: &AppHandle,
        source: LocalSource,
        mut item: MediaItem,
        start: Option<f64>,
        options: LoadOptions,
    ) -> AppResult<()> {
        self.ensure_engine(app).await?;
        let _switch = self.switching.lock().await;
        self.check_load(app, &options)?;
        if options.fresh_preferences {
            self.apply_fresh_preferences(app).await?;
            self.check_load(app, &options)?;
        }
        let position = valid_start(start.unwrap_or_else(|| self.saved_position(&item)));
        item.youtube_loudness_db = source.loudness_db;
        let mut file_options = source_options(
            position,
            &options.mode,
            self.desired_pause.load(Ordering::SeqCst),
            false,
        );
        file_options.insert(
            "volume-gain".into(),
            json!(crate::normalization::gain_db(
                self.store.settings()?.normalize_audio,
                source.loudness_db,
            )
            .to_string()),
        );
        if let Ok(mut local) = self.local_path.lock() {
            *local = Some(source.clone());
        }
        self.send(json!(["set_property", "http-header-fields", []]))
            .await?;
        self.change(app, |s| {
            s.status = "preparing".into();
            s.video = Some(item);
            s.playback_mode = options.mode.clone();
            s.quality = if options.mode == "audio" {
                0
            } else {
                source.quality
            };
            s.qualities = if options.mode == "audio" {
                vec![]
            } else {
                vec![source.quality]
            };
            s.position = position;
            s.error = None;
            s.error_code = None;
            s.buffered_seconds = 0.;
        });
        self.commit_file(app, &source.path, file_options, &options, None)
            .await?;
        self.install_cache_lease(None);
        self.pending_cache.lock().map_err(AppError::io)?.take();
        Ok(())
    }
    async fn commit_file(
        self: &Arc<Self>,
        app: &AppHandle,
        path: &str,
        file_options: serde_json::Map<String, Value>,
        options: &LoadOptions,
        external_audio: Option<String>,
    ) -> AppResult<()> {
        self.check_load(app, options)?;
        let token = SourceToken {
            load: options.load,
            attempt: self.attempt.fetch_add(1, Ordering::SeqCst) + 1,
        };
        *self.ended_source.lock().map_err(AppError::io)? = None;
        self.restarted.store(false, Ordering::SeqCst);
        self.loaded.store(false, Ordering::SeqCst);
        self.cache_paused.store(false, Ordering::SeqCst);
        *self.audio.lock().map_err(AppError::io)? = AudioState {
            expected_external: external_audio.is_some(),
            ..AudioState::default()
        };

        if let Ok(mut failure) = self.failure.lock() {
            *failure = MediaFailure::Unknown;
        }
        self.entries.lock().map_err(AppError::io)?.begin(token);
        self.send(audio_source_command(external_audio)).await?;
        self.send(json!([
            "loadfile",
            path,
            "replace",
            -1,
            Value::Object(file_options)
        ]))
        .await?;
        let playlist = self.send(json!(["get_property", "playlist"])).await?;
        let id = playlist
            .as_array()
            .and_then(|entries| entries.first())
            .and_then(|entry| entry["id"].as_i64())
            .ok_or_else(|| {
                AppError::new(
                    "player_entry",
                    "The player did not identify this source. Select the video again.",
                )
            })?;
        let early = self.entries.lock().map_err(AppError::io)?.bind(id, token);
        for event in early {
            if self.token() == token {
                self.media_event(app, event);
            }
        }
        let bounds = self.bounds.lock().map_err(AppError::io)?.clone();
        self.set_bounds(app, bounds).await?;
        let manager = Arc::downgrade(self);
        let app = app.clone();
        let starting_position = self.snapshot().position;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(25)).await;
            if let Some(manager) = manager.upgrade() {
                let state = manager.snapshot();
                if manager.token() == token
                    && !manager.desired_pause.load(Ordering::SeqCst)
                    && matches!(state.status.as_str(), "preparing" | "buffering")
                    && (!manager.restarted.load(Ordering::SeqCst)
                        || (state.position - starting_position).abs() < 0.5)
                {
                    manager.recover(&app, MediaFailure::Network);
                }
            }
        });
        Ok(())
    }
    pub async fn play_download(self: &Arc<Self>, app: &AppHandle, id: &str) -> AppResult<()> {
        let task = self
            .store
            .downloads()?
            .into_iter()
            .find(|d| d.id == id && d.status == "completed")
            .ok_or_else(|| AppError::new("not_found", "This download is not complete."))?;
        let path = task
            .output_path
            .clone()
            .filter(|p| std::path::Path::new(p).is_file())
            .ok_or_else(|| {
                AppError::new(
                    "not_found",
                    "This file was moved or deleted. Download it again to play offline.",
                )
            })?;
        app.state::<AppState>().gateway.cancel("playback-source");
        app.state::<AppState>().cache.cancel_pending(app);
        self.save_history();
        let mode = if task.mode == "audio" || self.store.settings()?.always_audio_only {
            "audio".into()
        } else {
            self.snapshot().playback_mode
        };
        let load = self.load.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = app.state::<AppState>().sessions.snapshot().generation;
        self.source_generation.store(generation, Ordering::SeqCst);
        self.desired_pause.store(false, Ordering::SeqCst);
        if let Ok(mut context) = self.recovery.lock() {
            *context = None;
        }
        self.change(app, |s| {
            s.load_id = load;
            s.video = Some(task.video.clone());
            s.status = "preparing".into();
            s.duration = task.video.duration.unwrap_or(0.);
            s.requested_quality = options_quality(task.quality);
        });
        let result = self
            .open_local_source(
                app,
                LocalSource {
                    path,
                    quality: task.quality,
                    has_video: task.mode == "video",
                    loudness_db: task.video.youtube_loudness_db,
                },
                task.video,
                None,
                LoadOptions {
                    load,
                    generation,
                    mode,
                    fresh_preferences: true,
                    force_refresh: false,
                    prefer_hls: false,
                },
            )
            .await;
        if let Err(ref error) = result {
            if self.load.load(Ordering::SeqCst) == load && error.code != "cancelled" {
                self.fail(app, error);
            }
        }
        result
    }
    pub async fn set_mode(self: &Arc<Self>, app: &AppHandle, mode: &str) -> AppResult<()> {
        let mode = validated_mode(mode)?.to_string();
        let state = self.snapshot();
        if state.playback_mode == mode {
            return Ok(());
        }
        let Some(item) = state.video.clone() else {
            self.change(app, |s| s.playback_mode = mode);
            return Ok(());
        };
        self.switch_source(app, item, state.requested_quality, Some(mode))
            .await
    }
    async fn switch_source(
        self: &Arc<Self>,
        app: &AppHandle,
        item: MediaItem,
        quality: u32,
        mode: Option<String>,
    ) -> AppResult<()> {
        let state = self.snapshot();
        let force_refresh = mode.is_none();
        let mode = mode.unwrap_or_else(|| state.playback_mode.clone());
        let local = self
            .local_path
            .lock()
            .map_err(AppError::io)?
            .clone()
            .filter(|source| mode == "audio" || source.has_video);
        app.state::<AppState>().gateway.cancel("playback-source");
        app.state::<AppState>().cache.cancel_pending(app);
        let load = self.load.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = app.state::<AppState>().sessions.snapshot().generation;
        self.source_generation.store(generation, Ordering::SeqCst);
        {
            let _switch = self.switching.lock().await;
            if self.writer.lock().await.is_some() {
                // Stop the old demuxers on mode changes so audio-only does not
                // continue prefetching the paused video's network source.
                let command = if mode != state.playback_mode {
                    json!(["stop"])
                } else {
                    json!(["set_property", "pause", true])
                };
                let _ = self.send(command).await;
            }
            self.change(app, |s| {
                s.load_id = load;
                s.status = "resolving".into();
                s.error = None;
                s.error_code = None;
                s.playback_mode = mode.clone();
                s.requested_quality = quality;
            });
        }
        let options = LoadOptions {
            load,
            generation,
            mode: mode.clone(),
            fresh_preferences: false,
            force_refresh,
            prefer_hls: false,
        };
        let result = if let Some(source) = local {
            self.open_local_source(app, source, item, Some(state.position), options)
                .await
        } else {
            if let Ok(mut context) = self.recovery.lock() {
                *context = Some(Recovery {
                    item: item.clone(),
                    quality,
                    mode,
                    generation,
                    attempted: false,
                    prefer_hls: false,
                });
            }
            self.open_remote(app, &item, quality, Some(state.position), options)
                .await
        };
        if let Err(ref error) = result {
            if self.load.load(Ordering::SeqCst) == load && error.code != "cancelled" {
                self.fail(app, error);
            }
        }
        result
    }
    async fn ensure_engine(self: &Arc<Self>, app: &AppHandle) -> AppResult<()> {
        let _guard = self.starting.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new("closing", "Viewsical is closing."));
        }
        {
            let mut process = self.process.lock().await;
            if let Some(ref mut child) = *process {
                if child.try_wait().map_err(AppError::io)?.is_none()
                    && self.writer.lock().await.is_some()
                {
                    return Ok(());
                }
            }
        }
        let surface = self.ensure_surface(app).await?;
        #[cfg(windows)]
        {
            let pipe_name = format!("\\\\.\\pipe\\tubedesk-{}", uuid::Uuid::new_v4());
            let state = self.snapshot();
            let mut command = Command::new(self.tools.mpv()?);
            command
                .args([
                    "--idle=yes",
                    "--no-terminal",
                    "--keep-open=no",
                    "--no-config",
                    "--load-scripts=no",
                    "--input-default-bindings=no",
                    "--input-vo-keyboard=no",
                    "--input-cursor=no",
                    "--window-dragging=no",
                    "--input-doubleclick-time=250",
                    "--osc=no",
                    "--osd-level=0",
                    "--ytdl=no",
                    "--force-window=yes",
                    "--title=Viewsical video",
                    "--hwdec=auto-safe",
                    "--tls-verify=yes",
                    "--network-timeout=20",
                    "--cache=yes",
                    "--cache-pause=yes",
                    "--cache-pause-initial=yes",
                    "--cache-pause-wait=3",
                    "--cache-secs=30",
                    "--demuxer-readahead-secs=30",
                    "--demuxer-max-bytes=128MiB",
                    "--demuxer-max-back-bytes=32MiB",
                ])
                .arg(format!("--wid={}", surface as u32))
                .arg(format!("--input-ipc-server={pipe_name}"))
                .arg(format!("--volume={}", state.volume))
                .arg(format!("--mute={}", if state.muted { "yes" } else { "no" }))
                .arg(format!("--speed={}", state.speed));
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            hide_command(&mut command);
            let child = command.spawn().map_err(|_| {
                AppError::new(
                    "player_start",
                    "The native player could not start. Check mpv in Settings.",
                )
            })?;
            let job = ProcessJob::attach(&child)?;
            *self.process.lock().await = Some(child);
            *self.process_job.lock().map_err(AppError::io)? = Some(job);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            let client = loop {
                match tokio::net::windows::named_pipe::ClientOptions::new().open(&pipe_name){Ok(client)=>break client,Err(_)if tokio::time::Instant::now()<deadline=>tokio::time::sleep(Duration::from_millis(70)).await,Err(_)=>return Err(AppError::new("player_start","The native player did not respond. Restart Viewsical or check the bundled mpv build."))}
            };
            let (reader, writer) = tokio::io::split(client);
            let epoch = self.engine_epoch.fetch_add(1, Ordering::SeqCst) + 1;
            *self.writer.lock().await = Some(Arc::new(AsyncMutex::new(writer)));
            let manager = self.clone();
            let handle = app.clone();
            let future: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(async move {
                let mut lines = BufReader::new(reader).lines();
                loop {
                    let line = match lines.next_line().await {
                        Ok(Some(line)) => line,
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!(kind=?error.kind(), "Native player IPC read failed");
                            break;
                        }
                    };
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        if let Some(id) = value["request_id"].as_u64() {
                            if let Ok(mut replies) = manager.replies.lock() {
                                if let Some(reply) = replies.remove(&id) {
                                    let _ = reply.send(value);
                                }
                            }
                        } else if manager.engine_epoch.load(Ordering::SeqCst) == epoch {
                            manager.event(&handle, value);
                        }
                    }
                }
                if manager.engine_epoch.load(Ordering::SeqCst) != epoch {
                    return;
                }
                let exit_code = manager
                    .process
                    .lock()
                    .await
                    .as_mut()
                    .and_then(|process| process.try_wait().ok().flatten())
                    .and_then(|status| status.code());
                tracing::warn!(exit_code, "Native player IPC ended");
                manager.writer.lock().await.take();
                if matches!(
                    manager.snapshot().status.as_str(),
                    "playing" | "paused" | "preparing" | "buffering"
                ) {
                    manager.fail(
                        &handle,
                        &AppError::new(
                            "player_closed",
                            "The native player closed unexpectedly. Select the video to try again.",
                        ),
                    );
                }
            });
            tauri::async_runtime::spawn(future);
            for (id, name) in [
                "time-pos",
                "duration",
                "pause",
                "volume",
                "mute",
                "speed",
                "paused-for-cache",
                "demuxer-cache-duration",
                "hwdec-current",
                "frame-drop-count",
                "track-list",
                "aid",
                "audio-params",
                "audio-out-params",
                "current-ao",
            ]
            .iter()
            .enumerate()
            {
                self.send(json!(["observe_property", id + 1, name])).await?;
            }
            self.send(json!(["request_log_messages", "warn"])).await?;
            let weak = Arc::downgrade(self);
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    let Some(manager) = weak.upgrade() else {
                        break;
                    };
                    if manager.writer.lock().await.is_none() {
                        break;
                    }
                    if matches!(manager.snapshot().status.as_str(), "playing" | "buffering") {
                        manager.save_history();
                    }
                }
            });
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = surface;
            Err(AppError::new(
                "platform",
                "Native playback currently supports Windows.",
            ))
        }
    }
    async fn send(&self, command: Value) -> AppResult<Value> {
        let writer = self.writer.lock().await.clone().ok_or_else(|| {
            AppError::new(
                "player_idle",
                "Open a video before using playback controls.",
            )
        })?;
        let id = self.serial.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.replies.lock().map_err(AppError::io)?.insert(id, tx);
        // Opening a remote external track may block in the demuxer. Let mpv
        // continue serving properties/control events while that command runs.
        let asynchronous = command[0].as_str() == Some("audio-add");
        let mut bytes =
            serde_json::to_vec(&json!({"command":command,"request_id":id,"async":asynchronous}))
                .map_err(AppError::io)?;
        bytes.push(b'\n');
        if writer.lock().await.write_all(&bytes).await.is_err() {
            self.replies.lock().map_err(AppError::io)?.remove(&id);
            return Err(AppError::new(
                "player_closed",
                "The native player connection closed. Open the video again.",
            ));
        }
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(response)) if response["error"] == "success" => Ok(response["data"].clone()),
            Ok(Ok(_)) => Err(AppError::new(
                "player_command",
                "The player could not apply this control. Try again after the video loads.",
            )),
            _ => {
                self.replies.lock().map_err(AppError::io)?.remove(&id);
                Err(AppError::new(
                    "player_timeout",
                    "The native player stopped responding. Open the video again.",
                ))
            }
        }
    }
    fn install_cache_lease(&self, lease: Option<CacheLease>) {
        let token = self.token();
        let ended = self
            .ended_source
            .lock()
            .map(|ended| *ended == Some(token))
            .unwrap_or(false);
        let lease = if ended {
            None
        } else {
            lease.map(|lease| (token, lease))
        };
        if let Ok(mut current) = self.cache_lease.lock() {
            if let Some(old) = std::mem::replace(&mut *current, lease) {
                if let Ok(mut retired) = self.retired_leases.lock() {
                    retired.push(old);
                }
            }
        }
        if self.loaded.load(Ordering::SeqCst) {
            if let Ok(mut retired) = self.retired_leases.lock() {
                retired.clear();
            }
        }
    }
    fn retire_active_lease(&self) {
        if let Ok(mut current) = self.cache_lease.lock() {
            if let Some(old) = current.take() {
                if let Ok(mut retired) = self.retired_leases.lock() {
                    retired.push(old);
                }
            }
        }
    }
    fn release_source_lease(&self, token: SourceToken) {
        if let Ok(mut ended) = self.ended_source.lock() {
            *ended = Some(token);
        }
        if let Ok(mut current) = self.cache_lease.lock() {
            if current.as_ref().is_some_and(|(source, _)| *source == token) {
                current.take();
            }
        }
        if let Ok(mut retired) = self.retired_leases.lock() {
            retired.retain(|(source, _)| *source != token);
        }
        if let Ok(mut pending) = self.pending_cache.lock() {
            if pending.as_ref().is_some_and(|(source, _)| *source == token) {
                pending.take();
            }
        }
    }
    fn clear_cache_leases(&self) {
        if let Ok(mut current) = self.cache_lease.lock() {
            current.take();
        }
        if let Ok(mut retired) = self.retired_leases.lock() {
            retired.clear();
        }
        if let Ok(mut pending) = self.pending_cache.lock() {
            pending.take();
        }
    }

    fn maybe_warm(self: &Arc<Self>, app: &AppHandle) {
        let ready = self
            .audio
            .lock()
            .map(|audio| audio.ready(false))
            .unwrap_or(false);
        if !self.restarted.load(Ordering::SeqCst) || !ready {
            return;
        }
        let plan = self.pending_cache.lock().ok().and_then(|mut pending| {
            if pending
                .as_ref()
                .is_some_and(|(token, _)| *token == self.token())
            {
                pending.take().map(|(_, plan)| plan)
            } else {
                None
            }
        });
        if let Some(plan) = plan {
            app.state::<AppState>().cache.schedule(app, plan);
        }
    }
    fn schedule_audio_check(self: &Arc<Self>, app: &AppHandle) {
        if let Ok(mut audio) = self.audio.lock() {
            if audio.checking {
                return;
            }
            audio.checking = true;
        }
        let manager = self.clone();
        let app = app.clone();
        let token = self.token();
        tauri::async_runtime::spawn(async move {
            for round in 0..3 {
                tokio::time::sleep(Duration::from_millis(if round == 0 { 750 } else { 1500 }))
                    .await;
                if manager.token() != token || manager.closing.load(Ordering::SeqCst) {
                    return;
                }
                for name in ["track-list", "audio-params", "audio-out-params"] {
                    let value = manager
                        .send(json!(["get_property", name]))
                        .await
                        .unwrap_or(Value::Null);
                    if manager.token() != token {
                        return;
                    }
                    manager.update_audio_property(name, &value);
                }
                let paused = manager.desired_pause.load(Ordering::SeqCst);
                let (ready, selected, target, repaired) = manager
                    .audio
                    .lock()
                    .map(|audio| {
                        (
                            audio.ready(paused),
                            audio.selected(),
                            audio.preferred(),
                            audio.repaired,
                        )
                    })
                    .unwrap_or((false, false, None, true));
                if ready {
                    manager.set_play_status(&app);
                    manager.maybe_warm(&app);
                    break;
                }
                let playing = manager.restarted.load(Ordering::SeqCst)
                    && !manager.cache_paused.load(Ordering::SeqCst);
                if !repaired && target.is_some() && (!selected || (!paused && playing)) {
                    let id = target.unwrap_or_default();
                    if let Ok(mut audio) = manager.audio.lock() {
                        audio.repaired = true;
                        audio.decoded = false;
                        audio.output = false;
                    }
                    // Reset only the selected audio decoder/output. Intentional
                    // mute and volume are never changed by this repair.
                    let _ = manager.send(json!(["set_property", "aid", "no"])).await;
                    if manager.token() != token {
                        return;
                    }
                    let _ = manager.send(json!(["set_property", "aid", id])).await;
                    tracing::info!(
                        load_id = token.load,
                        audio_track = id,
                        "Reinitializing selected audio track"
                    );
                    continue;
                }
                if round == 2 && ((!selected && paused) || (playing && !paused)) {
                    let failure = merge_failure(
                        manager
                            .failure
                            .lock()
                            .map(|failure| *failure)
                            .unwrap_or_default(),
                        MediaFailure::AudioMissing,
                    );
                    manager.recover(&app, failure);
                }
            }
            if manager.token() == token {
                if let Ok(mut audio) = manager.audio.lock() {
                    audio.checking = false;
                }
            }
        });
    }
    fn update_audio_property(&self, name: &str, value: &Value) {
        if let Ok(mut audio) = self.audio.lock() {
            match name {
                "track-list" => audio.tracks = parse_audio_tracks(value),
                "audio-params" => audio.decoded = audio_params_present(value),
                "audio-out-params" => audio.output = audio_params_present(value),
                _ => {}
            }
        }
    }
    fn event(self: &Arc<Self>, app: &AppHandle, value: Value) {
        let event = value["event"].as_str().unwrap_or("");
        if event == "end-file" {
            let ended = value["playlist_entry_id"].as_i64().and_then(|id| {
                self.entries
                    .lock()
                    .ok()
                    .and_then(|entries| entries.map.get(&id).copied())
            });
            if let Some(token) = ended {
                self.release_source_lease(token);
            }
        }
        if event == "client-message" {
            return;
        }
        if event == "log-message" {
            // Never store or emit raw mpv text: it may contain signed URLs or headers.
            let current = self.token();
            let belongs_to_current = self
                .entries
                .lock()
                .map(|entries| {
                    entries.active.and_then(|id| entries.map.get(&id).copied()) == Some(current)
                })
                .unwrap_or(false);
            if !belongs_to_current {
                return;
            }
            let category = classify_media_failure(value["text"].as_str().unwrap_or(""));
            if category != MediaFailure::Unknown {
                if let Ok(mut failure) = self.failure.lock() {
                    *failure = merge_failure(*failure, category);
                }
                tracing::warn!(
                    load_id = self.load.load(Ordering::SeqCst),
                    category = category.code(),
                    "Native media warning"
                );
            }
            return;
        }
        if event == "property-change"
            && matches!(value["name"].as_str(), Some("volume" | "mute" | "speed"))
        {
            self.media_event(app, value);
            return;
        }
        let routed = self
            .entries
            .lock()
            .ok()
            .and_then(|mut entries| entries.route(value, self.token()));
        if let Some(event) = routed {
            self.media_event(app, event);
        }
    }
    fn media_event(self: &Arc<Self>, app: &AppHandle, value: Value) {
        match value["event"].as_str().unwrap_or("") {
            "file-loaded" => {
                self.loaded.store(true, Ordering::SeqCst);
                // Re-read the preference after loading too: a switch changed
                // while the source was opening must apply to this very item.
                let manager = self.clone();
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = manager.refresh_normalization(&handle).await {
                        tracing::warn!(category=%error.code, "Audio normalization refresh failed");
                    }
                });
                if let Ok(mut retired) = self.retired_leases.lock() {
                    retired.clear();
                }
                self.set_play_status(app);
                self.schedule_audio_check(app);
            }
            "playback-restart" => {
                self.restarted.store(true, Ordering::SeqCst);
                self.set_play_status(app);
                self.schedule_audio_check(app);
                self.maybe_warm(app);
            }
            "property-change" => {
                let name = value["name"].as_str().unwrap_or("");
                let data = &value["data"];
                match name {
                    "track-list" | "audio-params" | "audio-out-params" => {
                        self.update_audio_property(name, data);
                        self.set_play_status(app);
                        self.maybe_warm(app);
                        if self.loaded.load(Ordering::SeqCst)
                            && self.restarted.load(Ordering::SeqCst)
                            && !self.desired_pause.load(Ordering::SeqCst)
                            && !self
                                .audio
                                .lock()
                                .map(|audio| audio.ready(false))
                                .unwrap_or(false)
                        {
                            self.schedule_audio_check(app);
                        }
                    }
                    "aid" => {
                        let selected = data.as_i64().is_some();
                        tracing::info!(
                            load_id = self.load.load(Ordering::SeqCst),
                            selected,
                            "Audio track selection changed"
                        );
                    }
                    "current-ao" => {
                        let output_active = data
                            .as_str()
                            .is_some_and(|value| !value.is_empty() && value != "null");
                        tracing::info!(
                            load_id = self.load.load(Ordering::SeqCst),
                            output_active,
                            "Audio output state changed"
                        );
                    }
                    "paused-for-cache" => {
                        if let Some(paused) = data.as_bool() {
                            self.cache_paused.store(paused, Ordering::SeqCst);
                            self.set_play_status(app);
                            tracing::info!(
                                load_id = self.load.load(Ordering::SeqCst),
                                buffering = paused,
                                buffered_seconds = self.snapshot().buffered_seconds,
                                "Playback buffer changed"
                            );
                        }
                    }
                    "pause" => self.set_play_status(app),
                    "time-pos" | "duration" | "demuxer-cache-duration" => {
                        if let Some(number) = data.as_f64().filter(|n| n.is_finite()) {
                            if let Ok(mut state) = self.state.lock() {
                                match name {
                                    "time-pos" => state.position = number.max(0.),
                                    "duration" => state.duration = number.max(0.),
                                    _ => state.buffered_seconds = number.max(0.),
                                }
                            }
                            if let Ok(mut last) = self.last_frame_emit.lock() {
                                if last.elapsed() >= Duration::from_millis(200) {
                                    *last = Instant::now();
                                    self.publish(app);
                                }
                            }
                        }
                    }
                    "volume" => {
                        if let Some(v) = data.as_f64() {
                            self.change(app, |s| s.volume = v);
                        }
                    }
                    "mute" => {
                        if let Some(v) = data.as_bool() {
                            self.change(app, |s| s.muted = v);
                        }
                    }
                    "speed" => {
                        if let Some(v) = data.as_f64() {
                            self.change(app, |s| s.speed = v);
                        }
                    }
                    "hwdec-current" => {
                        let accelerated = data.as_str().is_some_and(|s| s != "no" && !s.is_empty());
                        tracing::info!(
                            load_id = self.load.load(Ordering::SeqCst),
                            accelerated,
                            "Decoder initialized"
                        );
                    }
                    "frame-drop-count" => {
                        if let Some(count) = data.as_u64().filter(|n| *n > 0) {
                            tracing::info!(
                                load_id = self.load.load(Ordering::SeqCst),
                                dropped_frames = count,
                                "Decoder frame drop count"
                            );
                        }
                    }
                    _ => {}
                }
            }
            "end-file" => match value["reason"].as_str().unwrap_or("") {
                "eof" => {
                    let state = self.snapshot();
                    if premature_eof(&state) {
                        self.recover(app, MediaFailure::Premature);
                    } else {
                        self.change(app, |s| {
                            s.status = "ended".into();
                            s.position = s.duration.max(s.position);
                        });
                        self.save_history();
                    }
                }
                "error" => {
                    let structured =
                        classify_media_failure(value["file_error"].as_str().unwrap_or(""));
                    let failure = merge_failure(
                        self.failure.lock().map(|f| *f).unwrap_or_default(),
                        structured,
                    );
                    self.recover(app, failure);
                }
                "redirect" => {
                    if let (Some(first), Some(count)) = (
                        value["playlist_insert_id"].as_i64(),
                        value["playlist_insert_num_entries"].as_u64(),
                    ) {
                        if count <= 8 {
                            if let Ok(mut entries) = self.entries.lock() {
                                for id in first..first + count as i64 {
                                    entries.map.insert(id, self.token());
                                }
                            }
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    fn set_play_status(&self, app: &AppHandle) {
        let state = self.snapshot();
        if matches!(
            state.status.as_str(),
            "idle" | "failed" | "ended" | "resolving"
        ) {
            return;
        }
        let status = if self.desired_pause.load(Ordering::SeqCst) {
            "paused"
        } else if self.cache_paused.load(Ordering::SeqCst)
            || !self.restarted.load(Ordering::SeqCst)
            || !self
                .audio
                .lock()
                .map(|audio| audio.ready(false))
                .unwrap_or(false)
        {
            "buffering"
        } else {
            "playing"
        };
        if state.status != status {
            self.change(app, |s| s.status = status.into());
        }
    }
    fn recover(self: &Arc<Self>, app: &AppHandle, failure: MediaFailure) {
        let state = self.snapshot();
        let token = self.token();
        let can_retry = !matches!(failure, MediaFailure::Decoder | MediaFailure::Unavailable)
            && self.local_path.lock().map(|p| p.is_none()).unwrap_or(false);
        let context = {
            let Ok(mut recovery) = self.recovery.lock() else {
                return;
            };
            match recovery.as_mut() {
                Some(context) if can_retry && !context.attempted => {
                    context.attempted = true;
                    if matches!(
                        failure,
                        MediaFailure::Rejected
                            | MediaFailure::Network
                            | MediaFailure::Unknown
                            | MediaFailure::Premature
                            | MediaFailure::AudioMissing
                    ) {
                        context.prefer_hls = true;
                    }
                    Some(context.clone())
                }
                _ => None,
            }
        };
        let Some(context) = context else {
            let message=match failure{MediaFailure::Decoder=>"This source could not be decoded. Try another quality or video.",MediaFailure::Rejected=>"YouTube rejected the refreshed media source. Retry the video or reconnect your session.",MediaFailure::Network=>"The media connection failed. Check your connection, then retry.",MediaFailure::Premature=>"The source ended before the video was complete. Retry to get a fresh source.",MediaFailure::AudioMissing=>"The video's audio source could not be opened. Retry or choose another quality.",_=>"This source could not be played. Retry or choose another quality."};
            self.fail(app, &AppError::new(failure.code(), message));
            return;
        };
        if state.load_id != token.load
            || state.video.as_ref().map(|v| &v.id) != Some(&context.item.id)
        {
            return;
        }
        let manager = self.clone();
        let app = app.clone();
        let future: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(async move {
            let options = LoadOptions {
                load: token.load,
                generation: context.generation,
                mode: context.mode,
                fresh_preferences: false,
                force_refresh: true,
                prefer_hls: context.prefer_hls,
            };
            if manager.check_load(&app, &options).is_err() || manager.token() != token {
                return;
            }
            manager.change(&app, |s| {
                s.status = "resolving".into();
                s.error = Some("Refreshing the video source…".into());
                s.error_code = None;
            });
            let result = manager
                .open_remote(
                    &app,
                    &context.item,
                    context.quality,
                    Some(state.position),
                    options,
                )
                .await;
            if let Err(error) = result {
                if manager.load.load(Ordering::SeqCst) == token.load && error.code != "cancelled" {
                    manager.fail(&app, &error);
                }
            }
        });
        tauri::async_runtime::spawn(future);
    }
    pub async fn action(
        self: &Arc<Self>,
        app: &AppHandle,
        action: &str,
        value: Option<f64>,
    ) -> AppResult<()> {
        let _control = if action == "quality" {
            None
        } else {
            Some(self.control_updates.lock().await)
        };
        let _source = if matches!(action, "volume" | "adjust-volume" | "mute" | "speed") {
            Some(self.switching.lock().await)
        } else {
            None
        };
        self.action_inner(app, action, value).await
    }
    async fn action_inner(
        self: &Arc<Self>,
        app: &AppHandle,
        action: &str,
        value: Option<f64>,
    ) -> AppResult<()> {
        let state = self.snapshot();
        let value = value.filter(|v| v.is_finite());
        match action {
            "pause" | "resume" | "toggle" => {
                let paused = match action {
                    "pause" => true,
                    "resume" => false,
                    _ => !self.desired_pause.load(Ordering::SeqCst),
                };
                self.desired_pause.store(paused, Ordering::SeqCst);
                if self.writer.lock().await.is_some() {
                    self.send(json!(["set_property", "pause", paused])).await?;
                }
                if paused {
                    self.save_history();
                } else {
                    self.schedule_audio_check(app);
                }
                self.set_play_status(app);
            }
            "seek" => {
                let pos = value
                    .ok_or_else(|| AppError::new("invalid_value", "A seek position is required."))?
                    .clamp(0., state.duration.max(0.));
                self.restarted.store(false, Ordering::SeqCst);
                self.send(json!(["seek", pos, "absolute+exact"])).await?;
                self.change(app, |s| s.position = pos);
                self.set_play_status(app);
            }
            "volume" | "adjust-volume" => {
                let v = if action == "adjust-volume" {
                    stepped_volume(state.volume, value)?
                } else {
                    value
                        .ok_or_else(|| AppError::new("invalid_value", "A volume is required."))?
                        .clamp(0., 100.)
                };
                self.send(json!(["set_property", "volume", v])).await?;
                self.change(app, |s| s.volume = v);
            }
            "mute" => {
                let v = value.map(|v| v != 0.).unwrap_or(!state.muted);
                self.send(json!(["set_property", "mute", v])).await?;
                self.change(app, |s| s.muted = v);
            }
            "speed" => {
                let v = value
                    .ok_or_else(|| AppError::new("invalid_value", "A playback speed is required."))?
                    .clamp(0.25, 3.);
                self.send(json!(["set_property", "speed", v])).await?;
                self.change(app, |s| s.speed = v);
            }
            "quality" => {
                let quality = value
                    .ok_or_else(|| AppError::new("invalid_quality", "Choose a video quality."))?
                    as u32;
                validate_quality(quality)?;
                if state.playback_mode == "audio" {
                    self.change(app, |s| s.requested_quality = quality);
                } else {
                    if !state.qualities.contains(&quality) {
                        return Err(AppError::new(
                            "invalid_quality",
                            "This quality is not available for the current video.",
                        ));
                    }
                    let item = state
                        .video
                        .ok_or_else(|| AppError::new("player_idle", "Open a video first."))?;
                    self.switch_source(app, item, quality, None).await?;
                }
            }
            "stop" => {
                app.state::<AppState>().gateway.cancel("playback-source");
                app.state::<AppState>().cache.cancel_pending(app);
                self.save_history();
                self.load.fetch_add(1, Ordering::SeqCst);
                self.attempt.fetch_add(1, Ordering::SeqCst);
                if let Ok(mut recovery) = self.recovery.lock() {
                    *recovery = None;
                }
                let _switch = self.switching.lock().await;
                if self.writer.lock().await.is_some() {
                    let _ = self.send(json!(["stop"])).await;
                }
                self.change(app, |s| {
                    s.status = "idle".into();
                    s.video = None;
                    s.position = 0.;
                    s.error = None;
                    s.error_code = None;
                });
                self.retire_active_lease();
            }
            _ => return Err(AppError::new("invalid_action", "Unknown playback control.")),
        }
        if matches!(action, "volume" | "adjust-volume" | "mute" | "speed") {
            if let Ok(mut settings) = self.store.settings() {
                let current = self.snapshot();
                settings.volume = current.volume;
                settings.muted = current.muted;
                settings.playback_rate = current.speed;
                let _ = self.store.save_settings(&settings);
            }
        }
        Ok(())
    }
    pub async fn ui_context(&self, app: &AppHandle, context: PlayerUiContext) -> AppResult<()> {
        *self.ui.lock().map_err(AppError::io)? = context;
        self.publish_presentation(app);
        Ok(())
    }
    async fn scoped_action(
        self: &Arc<Self>,
        app: &AppHandle,
        load_id: u64,
        action: OverlayAction,
        value: Option<f64>,
        mode: Option<String>,
    ) -> AppResult<()> {
        let _control = if action.switches_source() || action.is_ui_request() {
            None
        } else {
            Some(self.control_updates.lock().await)
        };
        // Simple native controls serialize with source commits. Quality/mode
        // changes already acquire switching internally and must not re-lock it.
        let _source = if action.switches_source() || action.is_ui_request() {
            None
        } else {
            Some(self.switching.lock().await)
        };
        ensure_control_load(
            load_id,
            self.load.load(Ordering::SeqCst),
            self.closing.load(Ordering::SeqCst),
        )?;
        if self.snapshot().video.is_none() {
            return Err(AppError::new("player_idle", "Open a video first."));
        }
        if action.is_ui_request() {
            let value = if action == OverlayAction::Scroll {
                Some(
                    value
                        .filter(|v| v.is_finite())
                        .ok_or_else(|| {
                            AppError::new("invalid_value", "A scroll distance is required.")
                        })?
                        .clamp(-4000., 4000.),
                )
            } else {
                None
            };
            if action == OverlayAction::FocusControls {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_focus();
                }
            }
            app.emit_to(
                "main",
                "player-ui-request",
                json!({"loadId":load_id,"action":action.name(),"value":value}),
            )
            .map_err(AppError::io)?;
            return Ok(());
        }
        if action == OverlayAction::Mode {
            let mode = mode.as_deref().ok_or_else(|| {
                AppError::new("invalid_mode", "Choose video or audio-only playback.")
            })?;
            self.set_mode(app, mode).await
        } else {
            self.action_inner(app, action.name(), value).await
        }
    }
    pub async fn set_bounds(&self, app: &AppHandle, bounds: PlayerBounds) -> AppResult<()> {
        if ![bounds.x, bounds.y, bounds.width, bounds.height]
            .iter()
            .all(|n| n.is_finite())
            || bounds.width < 0.
            || bounds.height < 0.
            || bounds.radius.is_some_and(|r| !r.is_finite() || r < 0.)
        {
            return Err(AppError::new(
                "invalid_bounds",
                "The video surface bounds are invalid.",
            ));
        }
        *self.bounds.lock().map_err(AppError::io)? = bounds.clone();
        crate::overlay::sync(app, bounds.clone(), self.video_visible());
        let surface = *self.surface.lock().map_err(AppError::io)?;
        let video_mode = self.snapshot().playback_mode == "video";
        let player_pid = self
            .process
            .lock()
            .await
            .as_ref()
            .and_then(|child| child.id());
        if let Some(handle) = surface {
            app.run_on_main_thread(move || {
                #[cfg(windows)]
                unsafe {
                    use windows::Win32::{
                        Foundation::HWND, Graphics::Gdi::*, UI::WindowsAndMessaging::*,
                    };
                    // Input belongs to the shared web overlay. Keep the mpv
                    // child disabled so it cannot steal focus or dispatch a
                    // duplicate click/shortcut through the old native path.
                    if let (Some(expected), Ok(child)) =
                        (player_pid, GetWindow(HWND(handle as *mut _), GW_CHILD))
                    {
                        let mut actual = 0;
                        GetWindowThreadProcessId(child, Some(&mut actual));
                        if actual == expected {
                            let _ = windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow(
                                child, false,
                            );
                        }
                    }
                    let width = bounds.width.round().clamp(1., 16384.) as i32;
                    let height = bounds.height.round().clamp(1., 16384.) as i32;
                    let radius = bounds
                        .radius
                        .unwrap_or(0.)
                        .clamp(0., bounds.width.min(bounds.height) / 2.)
                        .round() as i32;
                    let region =
                        CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
                    if !region.is_invalid()
                        && SetWindowRgn(HWND(handle as *mut _), Some(region), true) == 0
                    {
                        let _ = DeleteObject(HGDIOBJ(region.0));
                    }
                    let visible =
                        bounds.visible && video_mode && bounds.width > 1. && bounds.height > 1.;
                    let _ = SetWindowPos(
                        HWND(handle as *mut _),
                        Some(HWND_TOP),
                        bounds.x.round().clamp(-32768., 32768.) as i32,
                        bounds.y.round().clamp(-32768., 32768.) as i32,
                        width,
                        height,
                        SWP_NOACTIVATE
                            | if visible {
                                SWP_SHOWWINDOW
                            } else {
                                SWP_HIDEWINDOW
                            },
                    );
                }
            })
            .map_err(AppError::io)?;
        }
        Ok(())
    }
    async fn ensure_surface(&self, app: &AppHandle) -> AppResult<isize> {
        if let Some(surface) = *self.surface.lock().map_err(AppError::io)? {
            return Ok(surface);
        }
        #[cfg(windows)]
        {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| AppError::new("window", "The main app window is missing."))?;
            let (tx, rx) = oneshot::channel();
            app.run_on_main_thread(move || {
                let result = (|| -> AppResult<isize> {
                    unsafe {
                        use windows::{
                            core::w,
                            Win32::{Foundation::HWND, UI::WindowsAndMessaging::*},
                        };
                        let parent = window.hwnd().map_err(AppError::io)?;
                        let handle = CreateWindowExW(
                            WINDOW_EX_STYLE(0),
                            w!("STATIC"),
                            w!("Viewsical video"),
                            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                            0,
                            0,
                            1,
                            1,
                            Some(HWND(parent.0 as *mut _)),
                            None,
                            None,
                            None,
                        )
                        .map_err(AppError::io)?;
                        Ok(handle.0 as isize)
                    }
                })();
                let _ = tx.send(result);
            })
            .map_err(AppError::io)?;
            let surface = rx.await.map_err(AppError::io)??;
            *self.surface.lock().map_err(AppError::io)? = Some(surface);
            Ok(surface)
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            Err(AppError::new(
                "platform",
                "Native playback currently supports Windows.",
            ))
        }
    }
    pub async fn invalidate_session(&self, app: &AppHandle) {
        if self.local_path.lock().map(|p| p.is_some()).unwrap_or(false) {
            return;
        }
        let _switch = self.switching.lock().await;
        if self.source_generation.load(Ordering::SeqCst)
            == app.state::<AppState>().sessions.snapshot().generation
        {
            return;
        }
        self.save_history();
        self.load.fetch_add(1, Ordering::SeqCst);
        self.attempt.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut context) = self.recovery.lock() {
            *context = None;
        }
        if self.writer.lock().await.is_some() {
            let _ = self.send(json!(["stop"])).await;
        }
        self.change(app, |s| {
            s.status = "idle".into();
            s.video = None;
            s.error = None;
            s.error_code = None;
        });
        self.retire_active_lease();
    }
    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.load.fetch_add(1, Ordering::SeqCst);
        self.attempt.fetch_add(1, Ordering::SeqCst);
    }
    pub async fn shutdown(&self) {
        self.begin_shutdown();
        self.save_history();
        self.engine_epoch.fetch_add(1, Ordering::SeqCst);
        self.writer.lock().await.take();
        if let Some(mut process) = self.process.lock().await.take() {
            let _ = process.kill().await;
            let _ = process.wait().await;
        }
        if let Ok(mut job) = self.process_job.lock() {
            job.take();
        }
        if let Ok(mut replies) = self.replies.lock() {
            replies.clear();
        }
        self.clear_cache_leases();
    }
}
fn validated_mode(mode: &str) -> AppResult<&str> {
    if matches!(mode, "video" | "audio") {
        Ok(mode)
    } else {
        Err(AppError::new(
            "invalid_mode",
            "Choose video or audio-only playback.",
        ))
    }
}
fn validate_quality(quality: u32) -> AppResult<()> {
    if (144..=8640).contains(&quality) {
        Ok(())
    } else {
        Err(AppError::new(
            "invalid_quality",
            "Choose an available video quality.",
        ))
    }
}
fn options_quality(quality: u32) -> u32 {
    if (144..=8640).contains(&quality) {
        quality
    } else {
        1080
    }
}
fn valid_start(position: f64) -> f64 {
    if position.is_finite() {
        position.max(0.)
    } else {
        0.
    }
}
fn normalized_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut result = headers
        .iter()
        .filter(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "user-agent" | "referer" | "origin" | "accept-language"
            ) && !value.contains(['\r', '\n'])
        })
        .map(|(key, value)| (key.to_ascii_lowercase(), value.clone()))
        .collect::<Vec<_>>();
    result.sort();
    result
}
fn source_options(
    start: f64,
    mode: &str,
    paused: bool,
    network: bool,
) -> serde_json::Map<String, Value> {
    let mut options = serde_json::Map::new();
    options.insert("start".into(), json!(start.to_string()));
    options.insert("pause".into(), json!(if paused { "yes" } else { "no" }));
    options.insert(
        "vid".into(),
        json!(if mode == "audio" { "no" } else { "auto" }),
    );
    options.insert("aid".into(), json!("auto"));
    options.insert("audio-display".into(), json!("no"));
    options.insert("cache".into(), json!(if network { "yes" } else { "no" }));
    options.insert(
        "cache-pause-initial".into(),
        json!(if network { "yes" } else { "no" }),
    );
    options
}
fn parse_audio_tracks(value: &Value) -> Vec<AudioTrack> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|track| track["type"] == "audio")
        .filter_map(|track| {
            Some(AudioTrack {
                id: track["id"].as_i64()?,
                selected: track["selected"].as_bool().unwrap_or(false),
                external: track["external"].as_bool().unwrap_or(false),
            })
        })
        .collect()
}
fn audio_params_present(value: &Value) -> bool {
    value.as_object().is_some_and(|object| !object.is_empty())
}
fn audio_source_command(source: Option<String>) -> Value {
    json!([
        "set_property",
        "audio-files",
        source.into_iter().collect::<Vec<_>>()
    ])
}
fn preference_commands(settings: &AppSettings) -> [Value; 3] {
    [
        json!(["set_property", "volume", settings.volume]),
        json!(["set_property", "mute", settings.muted]),
        json!(["set_property", "speed", settings.playback_rate]),
    ]
}
fn premature_eof(state: &PlayerState) -> bool {
    let expected = state
        .video
        .as_ref()
        .and_then(|v| v.duration)
        .unwrap_or(state.duration);
    expected > 5. && state.position + (expected * 0.02).clamp(2., 5.) < expected
}
fn merge_failure(previous: MediaFailure, next: MediaFailure) -> MediaFailure {
    // A subsequent wrapper error (e.g. no audio file found) must not obscure
    // the HTTP rejection that caused it and disable the transport fallback.
    if previous == MediaFailure::Rejected || next == MediaFailure::Unknown {
        previous
    } else if next == MediaFailure::Rejected || previous == MediaFailure::Unknown {
        next
    } else {
        previous
    }
}

fn classify_media_failure(text: &str) -> MediaFailure {
    let text = text.to_ascii_lowercase();
    if text.contains("403") || text.contains("410") || text.contains("forbidden") {
        MediaFailure::Rejected
    } else if text.contains("timed out")
        || text.contains("connection")
        || text.contains("network")
        || text.contains("http error")
    {
        MediaFailure::Network
    } else if text.contains("unsupported codec")
        || text.contains("could not open codec")
        || ((text.contains("initialization failed") || text.contains("failed to initialize"))
            && (text.contains("decoder")
                || text.contains("video output")
                || text.contains("audio output")))
    {
        MediaFailure::Decoder
    } else if text.contains("404") || text.contains("not found") {
        MediaFailure::Unavailable
    } else {
        MediaFailure::Unknown
    }
}
#[tauri::command]
pub fn player_overlay_snapshot(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> AppResult<PlayerPresentation> {
    ensure_control_window(window.label())?;
    tracing::info!(
        caller = window.label(),
        "Player presentation snapshot requested"
    );
    if window.label() == "player-overlay" {
        crate::overlay::ready(&app);
    }
    Ok(state.player.presentation(&app))
}
#[tauri::command]
pub async fn player_overlay_action(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    load_id: u64,
    action: OverlayAction,
    value: Option<f64>,
    mode: Option<String>,
) -> AppResult<()> {
    ensure_control_window(window.label())?;
    state
        .player
        .scoped_action(&app, load_id, action, value, mode)
        .await
}
#[tauri::command]
pub async fn retry_player_overlay(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "forbidden",
            "Only the main window can retry controls.",
        ));
    }
    crate::overlay::retry(&app).await?;
    state.player.publish_presentation(&app);
    let bounds = state.player.bounds.lock().map_err(AppError::io)?.clone();
    crate::overlay::sync(&app, bounds, state.player.video_visible());
    Ok(())
}
fn ensure_control_window(label: &str) -> AppResult<()> {
    if matches!(label, "main" | "player-overlay") {
        Ok(())
    } else {
        Err(AppError::new(
            "forbidden",
            "Playback controls are available only in the app.",
        ))
    }
}

#[tauri::command]
pub async fn play_video(
    app: AppHandle,
    state: State<'_, AppState>,
    item: MediaItem,
    quality: u32,
    start_seconds: Option<f64>,
    playback_mode: Option<String>,
) -> AppResult<()> {
    state
        .player
        .play(&app, item, quality, start_seconds, playback_mode)
        .await
}
#[tauri::command]
pub async fn play_local(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<()> {
    state.player.play_download(&app, &task_id).await
}
#[tauri::command]
pub async fn player_action(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    value: Option<f64>,
) -> AppResult<()> {
    state.player.action(&app, &action, value).await
}
#[tauri::command]
pub async fn set_playback_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> AppResult<()> {
    state.player.set_mode(&app, &mode).await
}
#[tauri::command]
pub async fn player_ui_context(
    app: AppHandle,
    state: State<'_, AppState>,
    context: PlayerUiContext,
) -> AppResult<()> {
    state.player.ui_context(&app, context).await
}
#[tauri::command]
pub async fn player_bounds(
    app: AppHandle,
    state: State<'_, AppState>,
    bounds: PlayerBounds,
) -> AppResult<()> {
    state.player.set_bounds(&app, bounds).await
}
#[tauri::command]
pub fn player_state(state: State<'_, AppState>) -> PlayerState {
    state.player.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::path::PathBuf;
    #[test]
    fn volume_shortcuts_use_exact_five_point_steps_and_boundaries() {
        assert_eq!(stepped_volume(37., Some(5.)).unwrap(), 42.);
        assert_eq!(stepped_volume(37., Some(-5.)).unwrap(), 32.);
        assert_eq!(stepped_volume(98., Some(5.)).unwrap(), 100.);
        assert_eq!(stepped_volume(2., Some(-5.)).unwrap(), 0.);
        for invalid in [
            None,
            Some(10.),
            Some(-10.),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert!(stepped_volume(37., invalid).is_err());
        }
    }
    #[test]
    fn overlay_controls_are_scoped_to_local_windows_and_current_load() {
        assert!(ensure_control_window("main").is_ok());
        assert!(ensure_control_window("player-overlay").is_ok());
        assert!(ensure_control_window("youtube-sign-in").is_err());
        assert!(ensure_control_load(3, 3, false).is_ok());
        assert!(ensure_control_load(2, 3, false).is_err());
        assert!(ensure_control_load(0, 0, false).is_err());
        assert!(ensure_control_load(3, 3, true).is_err());
        assert!(serde_json::from_str::<OverlayAction>("\"adjust-volume\"").is_ok());
        assert!(serde_json::from_str::<OverlayAction>("\"stop\"").is_err());
        assert!(serde_json::from_str::<OverlayAction>("\"open_sign_in\"").is_err());
    }
    #[test]
    fn handles_invalid_seek_positions() {
        assert_eq!(valid_start(f64::NAN), 0.);
        assert_eq!(valid_start(-3.), 0.);
        assert_eq!(valid_start(12.5), 12.5);
    }
    #[test]
    fn fresh_play_commands_use_latest_saved_preferences() {
        let mut settings = AppSettings {
            theme: "system".into(),
            download_directory: String::new(),
            default_quality: 1080,
            volume: 80.,
            muted: false,
            playback_rate: 1.,
            always_audio_only: false,
            normalize_audio: true,
        };
        let old = preference_commands(&settings);
        settings.volume = 37.;
        settings.muted = true;
        settings.playback_rate = 1.75;
        assert_ne!(old, preference_commands(&settings));
        assert_eq!(
            preference_commands(&settings)[2],
            json!(["set_property", "speed", 1.75])
        );
    }
    #[test]
    fn old_entry_eof_cannot_end_new_source() {
        let old = SourceToken {
            load: 1,
            attempt: 1,
        };
        let current = SourceToken {
            load: 2,
            attempt: 2,
        };
        let mut tracker = EntryTracker::default();
        tracker.map.insert(10, old);
        tracker.begin(current);
        assert!(tracker
            .route(
                json!({"event":"end-file","playlist_entry_id":10,"reason":"eof"}),
                current
            )
            .is_none());
        let _ = tracker.route(
            json!({"event":"start-file","playlist_entry_id":11}),
            current,
        );
        let _ = tracker.route(json!({"event":"file-loaded"}), current);
        assert_eq!(tracker.bind(11, current).len(), 2);
        assert!(tracker
            .route(
                json!({"event":"end-file","playlist_entry_id":10,"reason":"error"}),
                current
            )
            .is_none());
    }
    #[test]
    fn retry_attempts_have_distinct_entry_identity() {
        let old = SourceToken {
            load: 7,
            attempt: 1,
        };
        let new = SourceToken {
            load: 7,
            attempt: 2,
        };
        let mut tracker = EntryTracker::default();
        tracker.map.insert(10, old);
        tracker.map.insert(11, new);
        assert!(tracker
            .route(
                json!({"event":"end-file","playlist_entry_id":10,"reason":"error"}),
                new
            )
            .is_none());
        assert!(tracker
            .route(
                json!({"event":"end-file","playlist_entry_id":11,"reason":"eof"}),
                new
            )
            .is_some());
    }
    #[test]
    fn source_options_clear_external_tracks_for_audio_mode() {
        let options = source_options(12.5, "audio", true, true);
        assert_eq!(options["vid"], "no");
        assert!(!options.contains_key("audio-files"));
        assert_eq!(
            audio_source_command(None),
            json!(["set_property", "audio-files", []])
        );
        assert_eq!(options["pause"], "yes");
        assert_eq!(options["start"], "12.5");
        assert_eq!(source_options(12.5, "video", false, true)["vid"], "auto");
        assert_eq!(source_options(12.5, "video", false, false)["cache"], "no");
    }
    #[test]
    fn premature_eof_is_not_success() {
        let mut state = PlayerState {
            duration: 366.,
            position: 2.,
            video: Some(MediaItem {
                duration: Some(366.),
                ..MediaItem::default()
            }),
            ..PlayerState::default()
        };
        assert!(premature_eof(&state));
        state.position = 365.;
        assert!(!premature_eof(&state));
    }
    #[test]
    fn diagnostics_never_return_raw_secrets() {
        assert_eq!(
            classify_media_failure("HTTP403 https://cdn/?secret=token"),
            MediaFailure::Rejected
        );
        assert_eq!(
            classify_media_failure("unsupported codec"),
            MediaFailure::Decoder
        );
        assert!(!MediaFailure::Rejected.code().contains("secret"));
    }
    #[test]
    fn http_rejection_survives_secondary_file_errors() {
        assert_eq!(
            merge_failure(MediaFailure::Rejected, MediaFailure::Unavailable),
            MediaFailure::Rejected
        );
        assert_eq!(
            merge_failure(MediaFailure::Unknown, MediaFailure::Unavailable),
            MediaFailure::Unavailable
        );
        assert_eq!(
            merge_failure(MediaFailure::Unavailable, MediaFailure::Rejected),
            MediaFailure::Rejected
        );
    }
    #[test]
    fn video_frames_do_not_imply_working_audio() {
        let tracks = parse_audio_tracks(&json!([
            {"type":"video","id":1,"selected":true},
            {"type":"audio","id":2,"external":true,"selected":false,"external-filename":"https://cdn.invalid/?secret=ignored"}
        ]));
        let mut audio = AudioState {
            tracks,
            expected_external: true,
            decoded: true,
            output: true,
            ..AudioState::default()
        };
        assert!(!audio.ready(false));
        assert_eq!(audio.preferred(), Some(2));
        audio.tracks[0].selected = true;
        assert!(audio.ready(false));
        audio.output = false;
        assert!(!audio.ready(false));
        assert!(audio.ready(true));
        assert!(!format!("{:?}", audio.tracks).contains("secret"));
    }
    #[test]
    fn intended_external_audio_wins_over_a_selected_internal_track() {
        let audio = AudioState {
            tracks: parse_audio_tracks(&json!([
                {"type":"audio","id":1,"selected":true,"external":false},
                {"type":"audio","id":3,"selected":false,"external":true}
            ])),
            expected_external: true,
            decoded: true,
            output: true,
            ..AudioState::default()
        };
        assert!(!audio.ready(false));
        assert_eq!(audio.preferred(), Some(3));
        assert_eq!(
            merge_failure(MediaFailure::Rejected, MediaFailure::AudioMissing),
            MediaFailure::Rejected
        );
    }
    #[test]
    #[cfg(windows)]
    fn native_pointer_requires_a_matching_press_and_never_reuses_a_previous_load() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let player = root.join("tools/mpv.exe");
        if !player.is_file() {
            return;
        }
        let scratch_root = root.join(".tools/test-data");
        std::fs::create_dir_all(&scratch_root).unwrap();
        let scratch = scratch_root.join(format!("osc-unit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let source = serde_json::to_string(
            &root
                .join("resources/player/tubedesk_osc.lua")
                .to_string_lossy(),
        )
        .unwrap();
        let lua=r#"
local real=require("mp")
local utils=require("mp.utils")
local handlers,observers,messages,timers={},{},{},{}
local requests={}
local render
local now=0
local overlay={update=function()end}
local fake={}
fake.create_osd_overlay=function() return overlay end
fake.get_time=function() return now end
fake.get_property_native=function() return {w=1000,h=560} end
fake.commandv=function(command,name,load,action,value)
 if command=="script-message"and name=="tubedesk-control"then requests[#requests+1]={load=load,action=action,value=value}end
end
fake.add_forced_key_binding=function(key,_,fn)handlers[key]=fn end
fake.observe_property=function(name,_,fn)observers[name]=fn end
fake.register_script_message=function(name,fn)messages[name]=fn end
fake.register_event=function()end
fake.add_periodic_timer=function(_,fn)render=fn;return{}end
fake.add_timeout=function(_,fn)local timer={fn=fn};timer.kill=function()timer.dead=true end;timers[#timers+1]=timer;return timer end
local function tests()
 package.loaded["mp"]=fake
 package.loaded["mp.utils"]=utils
 dofile($SOURCE)
 local function context(id)messages.context('{"loadId":'..id..',"mode":"video","quality":1080,"qualities":[1080,720],"hasPrevious":false,"hasNext":true}');render()end
 local function mouse(x,y,hover)observers["mouse-pos"]("",{x=x,y=y,hover=hover~=false});render()end
 local function pointer(kind,canceled)handlers.MBTN_LEFT({event=kind,canceled=canceled})end
 context(1);mouse(500,200)
 local hit_test
 for index=1,30 do local name,value=debug.getupvalue(handlers.MBTN_LEFT,index);if name=="find_hit"then hit_test=value;break end end
 assert(hit_test,"native pointer hit tester missing")
 local hx,hy
 for y=450,559,5 do for x=0,999,10 do local hit=hit_test(x,y);if hit and hit.action=="mode"then hx,hy=hit.x+hit.w/2,hit.y+hit.h/2;break end end;if hx then break end end
 assert(hx,"native Audio only button was not rendered")
 mouse(hx,hy)
 pointer("up");pointer("press")
 assert(#requests==0,"orphan up/press activated Audio only")
 pointer("down");pointer("up")
 assert(#requests==1 and requests[1].action=="mode"and requests[1].value=="audio","a complete pointer click did not activate the actual native control")
 requests={}
 mouse(500,200);pointer("down");mouse(hx,hy);pointer("up")
 assert(#requests==0,"a release on another control activated it")
 mouse(hx,hy);pointer("down");context(2);pointer("up")
 assert(#requests==0,"a previous-load press activated the current source")
 pointer("down");pointer("up",true);pointer("up")
 assert(#requests==0,"canceled press remained armed")
 mouse(hx,hy);pointer("down");mouse(hx,hy,false);mouse(hx,hy,true);pointer("up")
 assert(#requests==0,"leaving the native surface retained an armed press")
 observers.pause("",true);render()
 assert(#overlay.data>0,"paused controls missing while cursor is over video")
 mouse(hx,hy,false)
 assert(overlay.data==""and not hit_test(hx,hy),"paused controls or progress remained after pointer leave")
 mouse(hx,hy,true)
 assert(#overlay.data>0,"controls did not return when cursor re-entered at the same coordinates")
 local sx,sy
 for y=450,559,5 do for x=0,999,10 do local hit=hit_test(x,y);if hit and hit.action=="menu"and hit.value=="settings"then sx,sy=hit.x+hit.w/2,hit.y+hit.h/2;break end end;if sx then break end end
 assert(sx,"native settings trigger was not rendered")
 mouse(sx,sy);pointer("down");pointer("up");render()
 assert(overlay.data:find("Playback mode",1,true),"native settings menu did not open")
 assert(overlay.data:find("\\1a&H3A&",1,true),"settings panel lost its translucent glass fill")
 mouse(sx,sy,false)
 assert(overlay.data=="","open settings menu stayed visible outside the video")
 mouse(sx,sy,true)
 assert(not overlay.data:find("Playback mode",1,true),"dismissed settings menu reopened on re-entry")
 observers["paused-for-cache"]("",true);mouse(sx,sy,false)
 assert(not hit_test(hx,hy),"buffering kept controls active after pointer leave")
 observers["paused-for-cache"]("",false);observers.pause("",false)
 observers["mouse-pos"]("",nil);render()
 assert(overlay.data=="","missing native pointer state retained controls")
 mouse(1001,200,true)
 assert(overlay.data=="","out-of-bounds pointer coordinates kept controls visible")
 mouse(hx,hy,true);now=3;render()
 assert(overlay.data=="","idle hover controls did not auto-hide")
 mouse(hx-1,hy,true)
 assert(#overlay.data>0,"pointer movement did not restore hidden controls")
 context(3);mouse(500,200);pointer("down");pointer("up")
 handlers.MBTN_LEFT_DBL()
 for _,timer in ipairs(timers)do if not timer.dead then timer.fn()end end
 assert(#requests==1 and requests[1].action=="fullscreen","double click also paused or activated a setting")
 requests={};mouse(500,200,false);handlers["Ctrl+k"]()
 assert(#requests==1 and requests[1].action=="focus-controls","hidden native overlay blocked keyboard-accessible controls")
end
local success,error=xpcall(tests,debug.traceback)
package.loaded["mp"]=real
if not success then real.msg.error(error)end
real.commandv("quit",success and 0 or 1)
"#.replace("$SOURCE",&source);
        let driver = scratch.join("fixture.lua");
        std::fs::write(&driver, lua).unwrap();
        let mut command = std::process::Command::new(player);
        command
            .args([
                "--idle=yes",
                "--vo=null",
                "--ao=null",
                "--force-window=no",
                "--no-config",
                "--load-scripts=no",
                "--terminal=yes",
                "--msg-level=all=warn",
            ])
            .arg(format!("--script={}", driver.display()));
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        let result = command.output().unwrap();
        let target = scratch.canonicalize().unwrap();
        let allowed = scratch_root.canonicalize().unwrap();
        assert!(
            target.parent() == Some(allowed.as_path())
                && target
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("osc-unit-")
        );
        std::fs::remove_dir_all(target).unwrap();
        assert!(
            result.status.success(),
            "{}",
            format!(
                "{}{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            )
        );
    }
}
