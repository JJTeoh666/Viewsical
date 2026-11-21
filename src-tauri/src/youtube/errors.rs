//! Public, redacted error categories; never expose provider stderr or secrets.
use crate::models::AppError;

pub fn classify_error(stderr: &str) -> AppError {
    let lower = stderr.to_ascii_lowercase();
    let (code, message) = if lower.contains("cookies are no longer valid")
        || lower.contains("cookies have expired")
    {
        (
            "session_expired",
            "Your YouTube session has expired. Sign in again in the app.",
        )
    } else if lower.contains("not a bot") || lower.contains("po token") {
        ("youtube_challenge", "YouTube requires a browser verification or a playback token for this request. Reconnect in the app and retry. Some videos may remain unavailable.")
    } else if lower.contains("login required")
        || lower.contains("login details are needed")
        || lower.contains("sign in")
        || lower.contains("requires authentication")
    {
        (
            "sign_in_required",
            "YouTube requires a signed-in account for this request. Sign in in the app and retry.",
        )
    } else if lower.contains("private video") {
        (
            "private_video",
            "This video is private. Connect an account that has access, or choose another video.",
        )
    } else if lower.contains("age") && (lower.contains("restrict") || lower.contains("confirm")) {
        (
            "age_restricted",
            "This video requires age verification in a supported YouTube session.",
        )
    } else if lower.contains("requested format") || lower.contains("no video formats") {
        ("format_unavailable", "The requested quality is unavailable. Try another quality or update the YouTube engine.")
    } else if lower.contains("403") || lower.contains("forbidden") {
        ("access_denied", "YouTube rejected this media source. Retry to resolve a fresh source, or choose another video.")
    } else if lower.contains("unavailable")
        || lower.contains("removed")
        || lower.contains("not available")
    {
        (
            "unavailable",
            "This video or library is unavailable to the current session or region.",
        )
    } else if ["featured", "videos", "streams", "playlists"]
        .iter()
        .any(|tab| lower.contains(&format!("this channel does not have a {tab} tab")))
    {
        ("channel_tab_missing", "This channel does not have this section.")
    } else if lower.contains("unsupported url") {
        ("unsupported_library", "This YouTube library is not supported by the installed engine. Update the engine or try a direct playlist link.")
    } else if lower.contains("timed out")
        || lower.contains("unable to download")
        || lower.contains("connection")
        || lower.contains("name resolution")
    {
        (
            "network",
            "Could not reach YouTube. Check your connection and retry.",
        )
    } else {
        ("extraction_failed", "The YouTube engine could not read this request. Retry or update the bundled engine from a trusted release.")
    };
    AppError::new(code, message)
}
