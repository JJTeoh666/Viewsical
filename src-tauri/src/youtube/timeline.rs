//! Session-bound chapters and signed storyboard sheets. The sheets are never stored on disk.
use super::{
    canonical_video, ensure_generation,
    gateway::YoutubeGateway,
    identity::valid_video_id,
    metadata::{video_chapters, video_storyboard},
};
use crate::{
    models::{AppError, AppResult, Storyboard, VideoChapter},
    runtime::now,
};
use std::{collections::VecDeque, sync::atomic::Ordering, time::Duration};
use url::Url;

const BOARD_TTL: u64 = 30 * 60;
const MISSING_TTL: u64 = 5 * 60;
const MAX_TIMELINES: usize = 64;
type Timeline = (Option<Vec<VideoChapter>>, Option<Storyboard>);

struct TimelineEntry {
    video_id: String,
    generation: u64,
    chapters: Option<Vec<VideoChapter>>,
    storyboard: Option<(Storyboard, u64)>,
    missing_until: u64,
}

impl TimelineEntry {
    fn storyboard_at(&self, timestamp: u64) -> Option<&Storyboard> {
        self.storyboard
            .as_ref()
            .filter(|(_, expiry)| *expiry > timestamp)
            .map(|(board, _)| board)
    }
}

#[derive(Default)]
pub(super) struct TimelineCache(VecDeque<TimelineEntry>);

impl TimelineCache {
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }

    fn find(&self, video_id: &str, generation: u64) -> Option<&TimelineEntry> {
        self.0
            .iter()
            .find(|entry| entry.video_id == video_id && entry.generation == generation)
    }

    fn get(
        &self,
        video_id: &str,
        generation: u64,
        want_storyboard: bool,
        timestamp: u64,
    ) -> Option<Timeline> {
        let entry = self.find(video_id, generation)?;
        let board = want_storyboard
            .then(|| entry.storyboard_at(timestamp))
            .flatten();
        let checked_missing = entry.missing_until > timestamp;
        let complete = if want_storyboard {
            board.is_some() || (entry.storyboard.is_none() && checked_missing)
        } else {
            entry.chapters.is_some() || checked_missing
        };
        complete.then(|| (entry.chapters.clone(), board.cloned()))
    }

    fn insert(
        &mut self,
        video_id: &str,
        generation: u64,
        (chapters, storyboard): Timeline,
        checked_missing: bool,
        timestamp: u64,
    ) {
        if !checked_missing && chapters.is_none() && storyboard.is_none() {
            return;
        }
        let prior = self
            .0
            .iter()
            .position(|entry| entry.video_id == video_id && entry.generation == generation)
            .and_then(|index| self.0.remove(index));
        self.0.retain(|entry| entry.generation == generation);
        let prior_missing = prior.as_ref().map(|entry| entry.missing_until).unwrap_or(0);
        let (prior_chapters, prior_board) = prior
            .map(|entry| (entry.chapters, entry.storyboard))
            .unwrap_or_default();
        let storyboard = storyboard
            .and_then(|board| {
                storyboard_expiry(&board.url_template, timestamp).map(|expiry| (board, expiry))
            })
            .or_else(|| prior_board.filter(|(_, expiry)| *expiry > timestamp));
        self.0.push_back(TimelineEntry {
            video_id: video_id.into(),
            generation,
            chapters: chapters.or(prior_chapters),
            storyboard,
            missing_until: if checked_missing {
                timestamp + MISSING_TTL
            } else {
                prior_missing
            },
        });
        if self.0.len() > MAX_TIMELINES {
            self.0.pop_front();
        }
    }
}

fn storyboard_expiry(template: &str, timestamp: u64) -> Option<u64> {
    let url = Url::parse(template).ok()?;
    let mut expiry = timestamp + BOARD_TTL;
    for (name, value) in url.query_pairs() {
        if matches!(name.as_ref(), "expire" | "expires") {
            expiry = expiry.min(value.parse::<u64>().ok()?.saturating_sub(30));
        }
    }
    (expiry > timestamp).then_some(expiry)
}

impl YoutubeGateway {
    pub(super) fn remember_timeline(&self, video_id: &str, generation: u64, metadata: Timeline) {
        let mut cache = self.timelines.lock().unwrap_or_else(|p| p.into_inner());
        if !self.closing.load(Ordering::SeqCst) && self.sessions.snapshot().generation == generation
        {
            cache.insert(video_id, generation, metadata, false, now());
        }
    }

    pub(crate) fn cached_storyboard(&self, video_id: &str, generation: u64) -> Option<Storyboard> {
        self.timelines
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .find(video_id, generation)
            .and_then(|entry| entry.storyboard_at(now()))
            .cloned()
    }

    pub(crate) async fn lookup_timeline(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        generation: u64,
        want_storyboard: bool,
    ) -> AppResult<Timeline> {
        let _lookup = self.watch_metadata_lookup.lock().await;
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        let cached = || {
            self.timelines
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(video_id, generation, want_storyboard, now())
        };
        if let Some(timeline) = cached() {
            return Ok(timeline);
        }
        self.fetch_watch_metadata(app, video_id, generation, "playback-watch-metadata").await?;
        Ok(cached().unwrap_or_default())
    }

    // Callers share the watch metadata lock so the timeline and subtitle
    // menu can use the same extraction for cached files and downloads.
    pub(super) async fn fetch_watch_metadata(
        &self,
        app: &tauri::AppHandle,
        video_id: &str,
        generation: u64,
        request_id: &str,
    ) -> AppResult<()> {
        if !valid_video_id(video_id) {
            return Err(AppError::new(
                "invalid_video",
                "Open a YouTube video first.",
            ));
        }
        let request = self.begin(request_id);
        let url = canonical_video(video_id);
        let args = [
            "--no-playlist",
            "--ignore-no-formats-error",
            "--extractor-args",
            "youtube:player_skip=configs,js;skip=hls,dash,translated_subs",
        ]
        .map(String::from)
        .to_vec();
        let lookup = async {
            match self
                .run(
                    app,
                    &url,
                    args.clone(),
                    None,
                    generation,
                    request.token.clone(),
                )
                .await
            {
                Err(error)
                    if matches!(
                        error.code.as_str(),
                        "sign_in_required"
                            | "private_video"
                            | "age_restricted"
                            | "youtube_challenge"
                    ) && self.sessions.snapshot().status == "connected" =>
                {
                    let cookies = self.sessions.cookie_snapshot(app).await?;
                    self.run(
                        app,
                        &url,
                        args,
                        cookies.as_ref(),
                        generation,
                        request.token.clone(),
                    )
                    .await
                }
                result => result,
            }
        };
        let json = tokio::time::timeout(Duration::from_secs(15), lookup)
            .await
            .map_err(|_| {
                AppError::new(
                    "timeout",
                    "YouTube took too long to load video details. Try again.",
                )
            })??;
        if json["id"].as_str() != Some(video_id) {
            return Err(AppError::new(
                "video_details",
                "YouTube returned different video details.",
            ));
        }
        let timeline = (video_chapters(&json), video_storyboard(&json, video_id));
        self.cache_captions(video_id, generation, &json, true);
        self.cache_watch_details(video_id, generation, &json);
        let mut cache = self.timelines.lock().unwrap_or_else(|p| p.into_inner());
        ensure_generation(generation, self.sessions.snapshot().generation)?;
        if request.token.is_cancelled() || self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "cancelled",
                "The video details lookup was cancelled.",
            ));
        }
        cache.insert(video_id, generation, timeline, true, now());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(query: &str) -> Storyboard {
        Storyboard {
            url_template: format!(
                "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg?{query}"
            ),
            width: 160,
            height: 90,
            rows: 5,
            columns: 5,
            frame_count: 100,
            frame_duration: 3.0,
        }
    }

    #[test]
    fn cached_storyboards_expire_without_discarding_chapters() {
        let id = "dQw4w9WgXcQ";
        let mut cache = TimelineCache::default();
        cache.insert(
            id,
            1,
            (
                Some(vec![VideoChapter {
                    start_time: 0.,
                    end_time: 20.,
                    title: "Intro".into(),
                }]),
                Some(board("sigh=signature&expire=300")),
            ),
            true,
            100,
        );
        assert!(cache.get(id, 1, true, 269).unwrap().1.is_some());
        assert!(cache.get(id, 2, true, 269).is_none());
        assert!(cache.get(id, 1, true, 270).is_none());
        assert!(cache.get(id, 1, true, 401).is_none());
        assert!(cache.get(id, 1, false, 401).unwrap().0.is_some());
        assert!(cache.get(id, 1, false, 101).unwrap().1.is_none());
    }

    #[test]
    fn unsigned_expiry_falls_back_to_a_bounded_window() {
        assert_eq!(
            storyboard_expiry(&board("sigh=signature").url_template, 100),
            Some(1900)
        );
        assert_eq!(
            storyboard_expiry(&board("expire=100").url_template, 100),
            None
        );
        assert_eq!(
            storyboard_expiry(&board("expire=invalid").url_template, 100),
            None
        );
    }
}
