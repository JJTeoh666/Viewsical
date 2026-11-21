use crate::models::{AppError, AppResult, ToolStatus};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Clone)]
pub struct AppPaths {
    pub data: PathBuf,
    pub auth: PathBuf,
    pub temp: PathBuf,
    pub downloads: PathBuf,
}
impl AppPaths {
    pub fn new(app: &tauri::AppHandle) -> AppResult<Self> {
        let override_data = if cfg!(debug_assertions) {
            std::env::var_os("TUBEDESK_DATA_DIR").map(PathBuf::from)
        } else {
            None
        };
        let data = override_data
            .clone()
            .unwrap_or(app.path().app_local_data_dir().map_err(AppError::io)?);
        let paths = Self {
            auth: data.join("session"),
            temp: data.join("temporary"),
            downloads: if override_data.is_some() {
                data.join("downloads")
            } else {
                app.path()
                    .download_dir()
                    .unwrap_or_else(|_| data.clone())
                    .join("Viewsical")
            },
            data,
        };
        for path in [&paths.data, &paths.auth, &paths.temp, &paths.downloads] {
            std::fs::create_dir_all(path).map_err(AppError::io)?;
        }
        // Only job snapshots live here. Remove leftovers from terminated processes before use.
        for entry in std::fs::read_dir(&paths.temp)
            .map_err(AppError::io)?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.starts_with("cookies-") && name.ends_with(".txt"))
                || (name.starts_with("session-") && name.ends_with(".cookies"))
                || name.strip_prefix("subtitles-").and_then(|name| name.strip_suffix(".vtt"))
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(paths)
    }
}

pub struct ToolPaths {
    root: PathBuf,
}
impl ToolPaths {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let resource = app.path().resource_dir().unwrap_or_default().join("tools");
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools");
        Self {
            root: if cfg!(debug_assertions) && development.join("python/python.exe").is_file() {
                development
            } else {
                resource
            },
        }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// Only our explicitly bundled adapter is loaded; user plugin paths stay disabled.
    pub fn youtube_plugins(&self, app: &tauri::AppHandle) -> AppResult<PathBuf> {
        let development =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/ytdlp-plugins");
        let path = if cfg!(debug_assertions) && development.is_dir() {
            development
        } else {
            app.path()
                .resource_dir()
                .map_err(AppError::io)?
                .join("ytdlp-plugins")
        };
        if path
            .join("viewsical/yt_dlp_plugins/extractor/viewsical_loudness.py")
            .is_file()
        {
            Ok(path)
        } else {
            Err(AppError::new(
                "player_resources",
                "The YouTube audio adapter is missing. Reinstall Viewsical.",
            ))
        }
    }
    fn locate(&self, name: &str) -> AppResult<PathBuf> {
        let path = self.root.join(name);
        if path.is_file() {
            Ok(path)
        } else {
            Err(AppError::new(
                "missing_tool",
                format!(
                    "Bundled {name} is missing. Run scripts/setup-tools.ps1 or reinstall Viewsical."
                ),
            ))
        }
    }
    pub fn youtube_python(&self) -> AppResult<tokio::process::Command> {
        self.locate("python/packages/yt_dlp/__init__.py")?;
        let mut command = tokio::process::Command::new(self.locate("python/python.exe")?);
        command.args(["-I", "-B", "-u", "-X", "utf8"]);
        Ok(command)
    }
    pub fn youtube_cli(&self) -> AppResult<tokio::process::Command> {
        let mut command = self.youtube_python()?;
        command.args(["-m", "yt_dlp"]);
        Ok(command)
    }
    pub fn deno(&self) -> AppResult<PathBuf> {
        self.locate("deno.exe")
    }
    pub fn mpv(&self) -> AppResult<PathBuf> {
        self.locate("mpv.exe")
    }
    pub fn ffmpeg(&self) -> AppResult<PathBuf> {
        self.locate("ffmpeg.exe")
    }
    pub fn ffprobe(&self) -> AppResult<PathBuf> {
        self.locate("ffprobe.exe")
    }
    pub fn status(&self) -> Vec<ToolStatus> {
        let manifest: serde_json::Value = std::fs::read_to_string(self.root.join("manifest.json"))
            .ok()
            .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_default();
        [
            ("yt-dlp", "python/packages/yt_dlp/__init__.py"),
            ("Deno", "deno.exe"),
            ("mpv", "mpv.exe"),
            ("FFmpeg", "ffmpeg.exe"),
            ("FFprobe", "ffprobe.exe"),
        ]
        .iter()
        .map(|(name, file)| ToolStatus {
            name: (*name).into(),
            available: self.root.join(file).is_file()
                && (*name != "yt-dlp" || self.root.join("python/python.exe").is_file()),
            version: manifest
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["file"] == *file))
                .and_then(|row| row["version"].as_str())
                .map(str::to_owned),
        })
        .collect()
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
