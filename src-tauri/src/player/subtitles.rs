//! The selected subtitle belongs to one item and account session.
use super::{PlayerManager, SourceToken};
use crate::{
    models::{AppError, AppResult, SubtitleTrack},
    AppState,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

pub(super) struct SelectedSubtitle {
    video_id: String,
    generation: u64,
    track: SubtitleTrack,
    file: SubtitleFile,
    attachment: Option<(SourceToken, i64)>,
}

struct SubtitleFile(PathBuf);

impl SubtitleFile {
    async fn write(directory: &Path, bytes: &[u8]) -> AppResult<Self> {
        let path = directory.join(format!("subtitles-{}.vtt", uuid::Uuid::new_v4()));
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .map_err(AppError::io)?;
        let file_guard = Self(path);
        let result = file.write_all(bytes).await;
        drop(file);
        result.map_err(AppError::io)?;
        Ok(file_guard)
    }
}

impl Drop for SubtitleFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn cancelled() -> AppError {
    AppError::new(
        "cancelled",
        "A newer video or account replaced this subtitle request.",
    )
}

impl PlayerManager {
    fn subtitle_video(&self, app: &AppHandle, load_id: u64, generation: u64) -> AppResult<String> {
        if self.closing.load(std::sync::atomic::Ordering::SeqCst)
            || self.token().load != load_id
            || app.state::<AppState>().sessions.snapshot().generation != generation
        {
            return Err(cancelled());
        }
        let state = self.state.lock().map_err(AppError::io)?;
        if state.load_id != load_id
            || state.playback_mode != "video"
            || matches!(state.status.as_str(), "failed" | "idle")
        {
            return Err(cancelled());
        }
        state
            .video
            .as_ref()
            .map(|item| item.id.clone())
            .ok_or_else(cancelled)
    }

    pub(super) async fn list_subtitles(
        &self,
        app: &AppHandle,
        load_id: u64,
    ) -> AppResult<Vec<SubtitleTrack>> {
        let app_state = app.state::<AppState>();
        let generation = app_state.sessions.snapshot().generation;
        let video_id = self.subtitle_video(app, load_id, generation)?;
        let tracks = app_state
            .gateway
            .subtitle_tracks(app, &video_id, generation)
            .await?;
        self.subtitle_video(app, load_id, generation)?;
        Ok(tracks)
    }

    pub(super) async fn select_subtitle(
        &self,
        app: &AppHandle,
        load_id: u64,
        track_id: Option<String>,
    ) -> AppResult<()> {
        // Duplicate controls share one selection operation. The source lock
        // below covers only the mpv changes, leaving network I/O off that path.
        let _request = self.subtitle_selection.lock().await;
        let app_state = app.state::<AppState>();
        let generation = app_state.sessions.snapshot().generation;
        let video_id = self.subtitle_video(app, load_id, generation)?;
        let mut requested = match track_id.as_deref() {
            Some(id) => {
                if self.snapshot().subtitle_track_id.as_deref() == Some(id) {
                    return Ok(());
                }
                if id.len() > 40 {
                    return Err(AppError::new(
                        "subtitle_track",
                        "Choose an available subtitle track.",
                    ));
                }
                let (track, bytes) = app_state
                    .gateway
                    .download_subtitle(app, &video_id, generation, id)
                    .await?;
                self.subtitle_video(app, load_id, generation)?;
                Some(SelectedSubtitle {
                    video_id,
                    generation,
                    track,
                    file: SubtitleFile::write(&app_state.paths.temp, &bytes).await?,
                    attachment: None,
                })
            }
            None => None,
        };

        let _switch = self.switching.lock().await;
        self.subtitle_video(app, load_id, generation)?;
        let token = self.token();
        let mut current = self.current_subtitle.lock().await;
        let prior_id = current.as_ref().and_then(|track| attached_id(track, token));
        if self.loaded.load(std::sync::atomic::Ordering::SeqCst)
            && !matches!(self.snapshot().status.as_str(), "resolving" | "preparing")
        {
            match &mut requested {
                Some(track) => {
                    let id = self.attach_subtitle(track).await?;
                    track.attachment = Some((token, id));
                    self.remove_subtitle_track(prior_id.filter(|prior| *prior != id))
                        .await;
                }
                None => {
                    self.send(json!(["set_property", "sid", "no"])).await?;
                    self.remove_subtitle_track(prior_id).await;
                }
            }
        }
        let id = requested
            .as_ref()
            .map(|selection| selection.track.id.clone());
        *current = requested;
        self.change(app, move |state| {
            if state.load_id == load_id {
                state.subtitle_track_id = id;
            }
        });
        Ok(())
    }

    async fn attach_subtitle(&self, selection: &SelectedSubtitle) -> AppResult<i64> {
        self.send(json!([
            "sub-add",
            selection.file.0,
            "select",
            selection.track.label,
            selection.track.language,
        ]))
        .await?;
        let sid = self.send(json!(["get_property", "sid"])).await?;
        native_track_id(&sid).ok_or_else(|| {
            AppError::new(
                "subtitle_open",
                "The player couldn’t open this subtitle track.",
            )
        })
    }

    async fn remove_subtitle_track(&self, id: Option<i64>) {
        if let Some(id) = id {
            let _ = self.send(json!(["sub-remove", id])).await;
        }
    }

    pub(super) async fn restore_subtitle(&self, app: &AppHandle, token: SourceToken) {
        let _switch = self.switching.lock().await;
        let mut selected = self.current_subtitle.lock().await;
        let Some(track) = selected.as_mut() else {
            return;
        };
        if self.token() != token
            || attached_id(track, token).is_some()
            || !self
                .subtitle_video(app, token.load, track.generation)
                .is_ok_and(|id| id == track.video_id)
        {
            return;
        }
        match self.attach_subtitle(track).await {
            Ok(id) => track.attachment = Some((token, id)),
            Err(error) => {
                tracing::warn!(category = %error.code, "Subtitle restore failed");
                selected.take();
                self.change(app, |state| {
                    if state.load_id == token.load {
                        state.subtitle_track_id = None;
                    }
                });
            }
        }
    }

    pub(super) async fn clear_subtitle(&self, detach: bool) {
        let mut selected = self.current_subtitle.lock().await;
        if detach {
            if let Some(id) = selected
                .as_ref()
                .and_then(|track| attached_id(track, self.token()))
            {
                let _ = self.send(json!(["set_property", "sid", "no"])).await;
                self.remove_subtitle_track(Some(id)).await;
            }
        }
        selected.take();
    }
}

fn attached_id(subtitle: &SelectedSubtitle, token: SourceToken) -> Option<i64> {
    subtitle
        .attachment
        .filter(|(source, _)| *source == token)
        .map(|(_, id)| id)
}

fn native_track_id(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|id| *id > 0)
}
