use crate::{
    models::*,
    runtime::{now, AppPaths},
};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

pub struct Store {
    db: Mutex<Connection>,
    defaults: AppSettings,
    account_history: AtomicBool,
}
impl Store {
    pub fn new(paths: &AppPaths) -> AppResult<Self> {
        let db = Connection::open(paths.data.join("library.sqlite3")).map_err(AppError::io)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(AppError::io)?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_history (video_id TEXT NOT NULL, partition TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(video_id,partition)); CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS ui_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value IN (0,1)));").map_err(AppError::io)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_playlists (
                id TEXT PRIMARY KEY, summary TEXT NOT NULL, videos TEXT NOT NULL, imported_at INTEGER NOT NULL
            );",
        )
        .map_err(AppError::io)?;
        let version: u32 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(AppError::io)?;
        if version == 0 {
            db.execute_batch(
                "BEGIN IMMEDIATE;
                 UPDATE local_history SET json = json_remove(json, '$.position') WHERE json_valid(json);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(AppError::io)?;
        }
        Ok(Self {
            db: Mutex::new(db),
            account_history: AtomicBool::new(false),
            defaults: AppSettings {
                theme: "system".into(),
                download_directory: paths.downloads.to_string_lossy().into(),
                default_quality: 1080,
                volume: 80.,
                muted: false,
                playback_rate: 1.,
                always_audio_only: false,
                remember_playback_mode: false,
                normalize_audio: true,
                close_to_tray: false,
            },
        })
    }
    pub fn settings(&self) -> AppResult<AppSettings> {
        let db = self.db.lock().map_err(AppError::io)?;
        self.read_settings(&db)
    }
    pub fn migrate_download_directory(&self, previous_root: &Path) -> AppResult<()> {
        let mut db = self.db.lock().map_err(AppError::io)?;
        let transaction = db.transaction().map_err(AppError::io)?;
        let mut settings = self.read_settings(&transaction)?;
        let saved = Path::new(&settings.download_directory);
        if ["TubeDesk", "Viewsical"]
            .iter()
            .any(|name| saved == previous_root.join(name))
        {
            settings
                .download_directory
                .clone_from(&self.defaults.download_directory);
            write_settings(&transaction, &settings)?;
        }
        transaction.commit().map_err(AppError::io)
    }
    pub fn local_playlists(&self) -> AppResult<Vec<CollectionSummary>> {
        let db = self.db.lock().map_err(AppError::io)?;
        let mut query = db
            .prepare("SELECT summary FROM local_playlists ORDER BY imported_at DESC, id")
            .map_err(AppError::io)?;
        let rows = query.query_map([], |row| row.get::<_, String>(0)).map_err(AppError::io)?;
        rows.map(|row| serde_json::from_str(&row.map_err(AppError::io)?).map_err(AppError::io)).collect()
    }
    pub fn local_playlist(&self, id: &str) -> AppResult<BrowsePage> {
        let db = self.db.lock().map_err(AppError::io)?;
        Self::read_local_playlist(&db, id)
    }
    fn read_local_playlist(db: &Connection, id: &str) -> AppResult<BrowsePage> {
        let row = db.query_row(
            "SELECT summary, videos FROM local_playlists WHERE id=?1",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional().map_err(AppError::io)?;
        let (summary, videos) = row.ok_or_else(|| AppError::new(
            "playlist_missing", "This playlist is no longer in your local library."
        ))?;
        Ok(BrowsePage {
            collection: Some(serde_json::from_str(&summary).map_err(AppError::io)?),
            items: serde_json::from_str(&videos).map_err(AppError::io)?,
            next_cursor: None,
            channel: None,
        })
    }
    pub fn save_local_playlist(&self, summary: &CollectionSummary, items: &[MediaItem]) -> AppResult<()> {
        let db = self.db.lock().map_err(AppError::io)?;
        Self::write_local_playlist(&db, summary, items)
    }
    fn write_local_playlist(db: &Connection, summary: &CollectionSummary, items: &[MediaItem]) -> AppResult<()> {
        let summary_json = serde_json::to_string(summary).map_err(AppError::io)?;
        let videos_json = serde_json::to_string(items).map_err(AppError::io)?;
        db.execute(
            "INSERT INTO local_playlists(id, summary, videos, imported_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, videos=excluded.videos, imported_at=excluded.imported_at",
            params![summary.id, summary_json, videos_json, now()],
        ).map_err(AppError::io)?;
        Ok(())
    }
    pub fn append_local_playlist_video(&self, id: &str, mut item: MediaItem) -> AppResult<()> {
        let mut db = self.db.lock().map_err(AppError::io)?;
        let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(AppError::io)?;
        let page = Self::read_local_playlist(&transaction, id)?;
        let mut items = page.items;
        if items.iter().any(|saved| saved.id == item.id) {
            return Ok(());
        }
        if items.len() >= crate::youtube::local_playlists::MAX_PLAYLIST_ITEMS {
            return Err(AppError::new("playlist_too_large", "This playlist already has 5,000 videos."));
        }
        let mut summary = page.collection.ok_or_else(|| AppError::new("playlist_missing", "This playlist is no longer in your local library."))?;
        item.playlist_index = Some(items.iter().filter_map(|saved| saved.playlist_index)
            .max().unwrap_or_default().max(items.len() as u64).saturating_add(1));
        items.push(item);
        summary.item_count = Some(items.len() as u64);
        Self::write_local_playlist(&transaction, &summary, &items)?;
        transaction.commit().map_err(AppError::io)?;
        Ok(())
    }
    pub fn remove_local_playlist(&self, id: &str) -> AppResult<()> {
        self.db.lock().map_err(AppError::io)?
            .execute("DELETE FROM local_playlists WHERE id=?1", [id])
            .map_err(AppError::io)?;
        Ok(())
    }
    fn read_settings(&self, db: &Connection) -> AppResult<AppSettings> {
        let json = db.query_row("SELECT json FROM settings WHERE id=1", [], |r| {
            r.get::<_, String>(0)
        });
        match json {
            Ok(json) => serde_json::from_str(&json).map_err(AppError::io),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(self.defaults.clone()),
            Err(e) => Err(AppError::io(e)),
        }
    }
    pub fn save_settings(&self, settings: &AppSettings, initial_mode: Option<&str>) -> AppResult<()> {
        let mut db = self.db.lock().map_err(AppError::io)?;
        let transaction = db.transaction().map_err(AppError::io)?;
        write_settings(&transaction, settings)?;
        if let Some(mode) = initial_mode {
            write_preferred_playback_mode(&transaction, mode)?;
        }
        transaction.commit().map_err(AppError::io)
    }
    pub fn preferred_playback_mode(&self) -> AppResult<Option<&'static str>> {
        let db = self.db.lock().map_err(AppError::io)?;
        db.query_row("SELECT value FROM ui_state WHERE key='playback.audio_only'", [], |row| {
            Ok(if row.get::<_, bool>(0)? { "audio" } else { "video" })
        }).optional().map_err(AppError::io)
    }
    pub fn save_preferred_playback_mode(&self, mode: &str) -> AppResult<()> {
        let db = self.db.lock().map_err(AppError::io)?;
        write_preferred_playback_mode(&db, mode)
    }
    pub fn update_playback_controls(&self, volume: f64, muted: bool, speed: f64) -> AppResult<()> {
        let db = self.db.lock().map_err(AppError::io)?;
        let mut settings = self.read_settings(&db)?;
        settings.volume = volume;
        settings.muted = muted;
        settings.playback_rate = speed;
        write_settings(&db, &settings)
    }
    /// Native window state is separate from frontend settings and account data.
    /// A stale settings snapshot must never undo a recent maximize/restore.
    pub fn window_maximized(&self) -> AppResult<bool> {
        let db = self.db.lock().map_err(AppError::io)?;
        match db.query_row(
            "SELECT value FROM ui_state WHERE key='window.maximized'",
            [],
            |r| r.get::<_, bool>(0),
        ) {
            Ok(value) => Ok(value),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(error) => Err(AppError::io(error)),
        }
    }
    pub fn save_window_maximized(&self, maximized: bool) -> AppResult<()> {
        self.db.lock().map_err(AppError::io)?.execute(
            "INSERT INTO ui_state(key,value) VALUES('window.maximized',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [maximized],
        ).map_err(AppError::io)?;
        Ok(())
    }
    #[cfg(test)]
    fn history(&self) -> AppResult<Vec<HistoryItem>> {
        self.history_for(self.account_history.load(Ordering::SeqCst))
    }
    pub fn set_account_partition(&self, active: bool) {
        self.account_history.store(active, Ordering::SeqCst);
    }
    pub fn clear_private_history(&self) -> AppResult<()> {
        self.db
            .lock()
            .map_err(AppError::io)?
            .execute("DELETE FROM local_history WHERE partition='account'", [])
            .map_err(AppError::io)?;
        Ok(())
    }
    pub fn history_for(&self, account: bool) -> AppResult<Vec<HistoryItem>> {
        let db = self.db.lock().map_err(AppError::io)?;
        let mut stmt = db.prepare("SELECT json FROM local_history WHERE partition=?1 ORDER BY updated_at DESC LIMIT 200").map_err(AppError::io)?;
        let rows = stmt
            .query_map([if account { "account" } else { "guest" }], |r| {
                r.get::<_, String>(0)
            })
            .map_err(AppError::io)?;
        rows.map(|r| serde_json::from_str(&r.map_err(AppError::io)?).map_err(AppError::io))
            .collect()
    }
    pub fn record_history(&self, video: &MediaItem, duration: f64) -> AppResult<()> {
        let entry = HistoryItem {
            video: video.clone(),
            duration: duration.max(0.),
            updated_at: now(),
        };
        let db = self.db.lock().map_err(AppError::io)?;
        let partition = if self.account_history.load(Ordering::SeqCst) {
            "account"
        } else {
            "guest"
        };
        db.execute("INSERT INTO local_history(video_id,partition,json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(video_id,partition) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at",params![video.id,partition,serde_json::to_string(&entry).map_err(AppError::io)?,entry.updated_at]).map_err(AppError::io)?;
        Ok(())
    }
    pub fn clear_history(&self) -> AppResult<()> {
        self.db
            .lock()
            .map_err(AppError::io)?
            .execute("DELETE FROM local_history", [])
            .map_err(AppError::io)?;
        Ok(())
    }
    pub fn downloads(&self) -> AppResult<Vec<DownloadTask>> {
        let db = self.db.lock().map_err(AppError::io)?;
        let mut stmt = db
            .prepare("SELECT json FROM downloads ORDER BY created_at DESC")
            .map_err(AppError::io)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(AppError::io)?;
        rows.map(|r| serde_json::from_str(&r.map_err(AppError::io)?).map_err(AppError::io))
            .collect()
    }
    pub fn save_download(&self, task: &DownloadTask) -> AppResult<()> {
        let db = self.db.lock().map_err(AppError::io)?;
        db.execute("INSERT INTO downloads(id,json,created_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![task.id,serde_json::to_string(task).map_err(AppError::io)?,task.created_at]).map_err(AppError::io)?;
        Ok(())
    }
    pub fn remove_download(&self, id: &str) -> AppResult<()> {
        self.db
            .lock()
            .map_err(AppError::io)?
            .execute("DELETE FROM downloads WHERE id=?1", [id])
            .map_err(AppError::io)?;
        Ok(())
    }
}

fn write_settings(db: &Connection, settings: &AppSettings) -> AppResult<()> {
    db.execute("INSERT INTO settings(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json", [serde_json::to_string(settings).map_err(AppError::io)?]).map_err(AppError::io)?;
    Ok(())
}

fn write_preferred_playback_mode(db: &Connection, mode: &str) -> AppResult<()> {
    db.execute(
        "INSERT INTO ui_state(key,value) VALUES('playback.audio_only',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [mode == "audio"],
    ).map_err(AppError::io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_download_defaults_move_to_app_storage_and_custom_folders_stay_selected() {
        let dir = std::env::temp_dir().join(format!("viewsical-downloads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = AppPaths {
            data: dir.clone(),
            auth: dir.join("auth"),
            temp: dir.join("tmp"),
            downloads: dir.join("downloads"),
        };
        let previous_root = dir.join("user").join("Downloads");
        let store = Store::new(&paths).unwrap();
        let mut settings = store.settings().unwrap();
        assert_eq!(Path::new(&settings.download_directory), paths.downloads);
        for old_name in ["TubeDesk", "Viewsical"] {
            settings.download_directory = previous_root.join(old_name).to_string_lossy().into();
            store.save_settings(&settings, None).unwrap();
            store.migrate_download_directory(&previous_root).unwrap();
            assert_eq!(Path::new(&store.settings().unwrap().download_directory), paths.downloads);
        }
        let custom = previous_root.join("Personal videos");
        settings.download_directory = custom.to_string_lossy().into();
        store.save_settings(&settings, None).unwrap();
        store.migrate_download_directory(&previous_root).unwrap();
        assert_eq!(Path::new(&store.settings().unwrap().download_directory), custom);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn local_playlists_survive_reopening_and_reimport_replaces_the_snapshot() {
        let dir = std::env::temp_dir().join(format!("viewsical-local-playlist-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = AppPaths {
            data: dir.clone(),
            auth: dir.join("auth"),
            temp: dir.join("tmp"),
            downloads: dir.join("downloads"),
        };
        let summary = CollectionSummary {
            id: "PLtest".into(),
            title: "Saved playlist".into(),
            owner: "Owner".into(),
            thumbnail: None,
            item_count: Some(1),
            description: None,
            is_mix: false,
            url: "https://www.youtube.com/playlist?list=PLtest".into(),
        };
        {
            let store = Store::new(&paths).unwrap();
            let mut item = MediaItem { id: "jNQXAC9IVRw".into(), ..Default::default() };
            store.save_local_playlist(&summary, std::slice::from_ref(&item)).unwrap();
            item.id = "dQw4w9WgXcQ".into();
            item.playlist_index = Some(4);
            store.save_local_playlist(&summary, &[item]).unwrap();
            let appended = MediaItem { id: "jNQXAC9IVRw".into(), ..Default::default() };
            store.append_local_playlist_video(&summary.id, appended.clone()).unwrap();
            store.append_local_playlist_video(&summary.id, appended).unwrap();
        }
        {
            let store = Store::new(&paths).unwrap();
            store.set_account_partition(true);
            assert_eq!(store.local_playlists().unwrap().len(), 1);
            let saved = store.local_playlist(&summary.id).unwrap();
            let collection = saved.collection.unwrap();
            assert_eq!(collection.title, summary.title);
            assert_eq!(collection.item_count, Some(2));
            assert_eq!(saved.items.len(), 2);
            assert_eq!(saved.items[0].id, "dQw4w9WgXcQ");
            assert_eq!(saved.items[1].id, "jNQXAC9IVRw");
            assert_eq!(saved.items[1].playlist_index, Some(5));
            store.remove_local_playlist(&summary.id).unwrap();
            assert!(store.local_playlists().unwrap().is_empty());
            assert_eq!(store.local_playlist(&summary.id).unwrap_err().code, "playlist_missing");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn maximized_state_survives_reopening_and_stale_settings_saves() {
        let dir =
            std::env::temp_dir().join(format!("viewsical-window-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = AppPaths {
            data: dir.clone(),
            auth: dir.join("auth"),
            temp: dir.join("tmp"),
            downloads: dir.join("downloads"),
        };
        {
            let store = Store::new(&paths).unwrap();
            assert!(!store.window_maximized().unwrap());
            let stale = store.settings().unwrap();
            store.save_window_maximized(true).unwrap();
            store.save_settings(&stale, None).unwrap();
            store.set_account_partition(true);
            store.clear_private_history().unwrap();
            assert!(store.window_maximized().unwrap());
        }
        {
            let store = Store::new(&paths).unwrap();
            assert!(store.window_maximized().unwrap());
            store.save_window_maximized(false).unwrap();
        }
        {
            let store = Store::new(&paths).unwrap();
            assert!(!store.window_maximized().unwrap());
        }
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn legacy_settings_keep_preferences_when_audio_default_is_added() {
        let legacy = r#"{"theme":"dark","downloadDirectory":"C:\\Downloads","defaultQuality":720,"volume":37.0,"muted":true,"playbackRate":1.25}"#;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert!(!settings.always_audio_only);
        assert!(!settings.remember_playback_mode);
        assert!(!settings.close_to_tray);
        assert!(settings.normalize_audio);
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.volume, 37.);
        assert!(settings.muted);
        assert_eq!(settings.default_quality, 720);
    }
    #[test]
    fn remembered_mode_survives_reopening_and_other_setting_changes() {
        let dir = std::env::temp_dir().join(format!("viewsical-playback-mode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = AppPaths {
            data: dir.clone(),
            auth: dir.join("auth"),
            temp: dir.join("tmp"),
            downloads: dir.join("downloads"),
        };
        {
            let store = Store::new(&paths).unwrap();
            assert_eq!(store.preferred_playback_mode().unwrap(), None);
            let mut settings = store.settings().unwrap();
            settings.remember_playback_mode = true;
            store.save_settings(&settings, Some("video")).unwrap();
            store.save_preferred_playback_mode("audio").unwrap();
            store.save_settings(&settings, None).unwrap();
            store.update_playback_controls(53., true, 1.25).unwrap();
        }
        {
            let store = Store::new(&paths).unwrap();
            assert_eq!(store.preferred_playback_mode().unwrap(), Some("audio"));
            let settings = store.settings().unwrap();
            assert!(settings.remember_playback_mode);
            assert_eq!((settings.volume, settings.muted, settings.playback_rate), (53., true, 1.25));
            store.save_preferred_playback_mode("video").unwrap();
        }
        assert_eq!(Store::new(&paths).unwrap().preferred_playback_mode().unwrap(), Some("video"));
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn history_and_settings_survive_reopening() {
        let dir = std::env::temp_dir().join(format!("tubedesk-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = AppPaths {
            data: dir.clone(),
            auth: dir.join("auth"),
            temp: dir.join("tmp"),
            downloads: dir.join("downloads"),
        };
        {
            let store = Store::new(&paths).unwrap();
            let mut settings = store.settings().unwrap();
            settings.theme = "dark".into();
            settings.always_audio_only = true;
            settings.normalize_audio = false;
            store.save_settings(&settings, None).unwrap();
            let video = MediaItem {
                id: "BaW_jenozKc".into(),
                title: "Test".into(),
                kind: "video".into(),
                ..Default::default()
            };
            store.record_history(&video, 12.).unwrap();
            store.record_history(&video, 30.).unwrap();
            store
                .db
                .lock()
                .unwrap()
                .execute_batch(
                    "UPDATE local_history SET json = json_set(json, '$.position', 20);
                 PRAGMA user_version = 0;",
                )
                .unwrap();
        }
        let store = Store::new(&paths).unwrap();
        assert_eq!(store.settings().unwrap().theme, "dark");
        assert!(store.settings().unwrap().always_audio_only);
        assert!(!store.settings().unwrap().normalize_audio);
        assert_eq!(store.history().unwrap().len(), 1);
        assert_eq!(store.history().unwrap()[0].duration, 30.);
        let rows_with_positions: u32 = store.db.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM local_history WHERE json_type(json, '$.position') IS NOT NULL",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(rows_with_positions, 0);
        store.set_account_partition(true);
        assert!(store.history().unwrap().is_empty());
        store
            .record_history(
                &MediaItem {
                    id: "private".into(),
                    ..Default::default()
                },
                8.,
            )
            .unwrap();
        assert_eq!(store.history().unwrap().len(), 1);
        store.clear_private_history().unwrap();
        assert!(store.history().unwrap().is_empty());
        store.set_account_partition(false);
        assert_eq!(store.history().unwrap()[0].video.id, "BaW_jenozKc");
        store.clear_history().unwrap();
        assert!(store.history().unwrap().is_empty());
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
