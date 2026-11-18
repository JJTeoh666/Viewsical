#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(windows)]
    if let Some(code) = tubedesk_lib::run_video_renderer() {
        std::process::exit(code);
    }
    tubedesk_lib::run()
}
