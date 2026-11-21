//! Read-only, bounded comment browsing. Provider continuations are deliberately
//! hidden behind the bundled adapter; cursors contain stable comment identity,
//! never session secrets or provider request URLs.
use crate::{
    downloads::{hide_command, ProcessJob},
    models::{AppError, AppResult},
    youtube::{ensure_generation, normalize_video_ref},
    AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PAGE_SIZE: usize = 20;
const MAX_COMMENTS: usize = 300;
const MAX_COMMENT_CHARS: usize = 20_000;
const MAX_TRANSLATION_BYTES: usize = 160_000;
static TRANSLATION_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoComment {
    pub id: String,
    pub author: String,
    pub author_channel_id: Option<String>,
    pub author_thumbnail: Option<String>,
    pub text: String,
    pub like_count: Option<u64>,
    pub reply_count: Option<u64>,
    pub has_replies: bool,
    pub published: Option<String>,
    pub author_is_uploader: bool,
    pub is_pinned: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCommentsPage {
    pub video_id: String,
    pub parent_id: Option<String>,
    pub items: Vec<VideoComment>,
    pub next_cursor: Option<String>,
    // yt-dlp's comment_count is the number extracted within our limit, not the
    // video's full count. Do not misrepresent it as a provider total.
    pub total_count: Option<u64>,
    pub disabled: bool,
    pub sort: String,
    pub limited: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    generation: u64,
    video_id: String,
    sort: String,
    offset: usize,
    anchor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
}

fn bad_cursor() -> AppError {
    AppError::new(
        "comments_changed",
        "These comments changed or belong to an earlier session. Refresh comments to continue.",
    )
}

fn validate_sort(sort: &str) -> AppResult<()> {
    if matches!(sort, "top" | "newest") {
        Ok(())
    } else {
        Err(AppError::new(
            "invalid_comments_sort",
            "Choose top comments or newest first.",
        ))
    }
}

fn parse_cursor(
    value: Option<&str>,
    video_id: &str,
    sort: &str,
    generation: u64,
    parent_id: Option<&str>,
) -> AppResult<Option<Cursor>> {
    let Some(value) = value else { return Ok(None) };
    if value.len() > 1536 {
        return Err(bad_cursor());
    }
    let parsed: Cursor = serde_json::from_str(value).map_err(|_| bad_cursor())?;
    if parsed.version != 1
        || parsed.generation != generation
        || parsed.video_id != video_id
        || parsed.sort != sort
        || parsed.parent_id.as_deref() != parent_id
        || parsed.offset == 0
        || parsed.offset >= MAX_COMMENTS
        || !valid_comment_id(&parsed.anchor)
    {
        return Err(bad_cursor());
    }
    Ok(Some(parsed))
}

fn valid_comment_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn bounded_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(limit)
        .collect()
}

fn comment_parent(row: &Value) -> &str {
    row["parent"].as_str().unwrap_or("root")
}

fn safe_thumbnail(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str()?;
    let allowed = [
        "googleusercontent.com",
        "ggpht.com",
        "ytimg.com",
        "youtube.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && allowed)
        .then(|| url.to_string())
}

fn comment_from_json(value: &Value) -> Option<VideoComment> {
    let id = value.get("id")?.as_str()?;
    if !valid_comment_id(id) {
        return None;
    }
    let text = bounded_text(value.get("text")?.as_str()?, MAX_COMMENT_CHARS);
    if text.trim().is_empty() {
        return None;
    }
    Some(VideoComment {
        id: id.into(),
        author: bounded_text(
            value
                .get("author")
                .and_then(Value::as_str)
                .filter(|author| !author.is_empty())
                .unwrap_or("YouTube user"),
            256,
        ),
        author_channel_id: value
            .get("author_id")
            .and_then(Value::as_str)
            .filter(|id| crate::youtube::valid_channel_id(id))
            .map(str::to_owned),
        author_thumbnail: value
            .get("author_thumbnail")
            .and_then(Value::as_str)
            .and_then(safe_thumbnail),
        text,
        like_count: value.get("like_count").and_then(Value::as_u64),
        reply_count: value.get("reply_count").and_then(Value::as_u64),
        has_replies: value.get("viewsical_has_replies").and_then(Value::as_bool).unwrap_or(false),
        published: value
            .get("_time_text")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| bounded_text(value, 128)),
        author_is_uploader: value
            .get("author_is_uploader")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_pinned: value
            .get("is_pinned")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn page_from_json(
    value: &Value,
    video_id: &str,
    sort: &str,
    generation: u64,
    cursor: Option<Cursor>,
    parent_id: Option<&str>,
) -> AppResult<VideoCommentsPage> {
    if value.get("id").and_then(Value::as_str) != Some(video_id) {
        return Err(AppError::new(
            "comments_unavailable",
            "YouTube returned comments for a different video. Retry this video’s comments.",
        ));
    }
    let raw = value.get("comments").ok_or_else(|| {
        AppError::new(
            "comments_unavailable",
            "YouTube did not return a comment section. Retry or update the bundled YouTube engine.",
        )
    })?;
    let disabled = raw.is_null();
    let mut seen = HashSet::new();
    let comments = if disabled && parent_id.is_none() {
        Vec::new()
    } else {
        let rows = raw.as_array()
            .ok_or_else(|| {
                AppError::new(
                    "comments_unavailable",
                    "The comment response could not be read.",
                )
            })?;
        if let Some(parent) = parent_id {
            if !rows.iter().any(|row| row["id"].as_str() == Some(parent) && comment_parent(row) == "root") {
                return Err(bad_cursor());
            }
        }
        rows
            .iter()
            .filter(|row| comment_parent(row) == parent_id.unwrap_or("root"))
            .filter_map(comment_from_json)
            .filter(|comment| seen.insert(comment.id.clone()))
            .take(MAX_COMMENTS + 1)
            .collect::<Vec<_>>()
    };
    // Fresh extraction can shift sorted rows (particularly newest first).
    // Continue after stable identity rather than silently skipping an ordinal.
    let start = if let Some(cursor) = cursor {
        if disabled {
            0
        } else {
            comments
                .iter()
                .position(|comment| comment.id == cursor.anchor)
                .map(|position| position + 1)
                .ok_or_else(bad_cursor)?
        }
    } else {
        0
    };
    let end = (start + PAGE_SIZE).min(MAX_COMMENTS).min(comments.len());
    let items = comments.get(start..end).unwrap_or_default().to_vec();
    let more = end < comments.len();
    let next_cursor = if more && end < MAX_COMMENTS {
        items.last().map(|last| {
            serde_json::to_string(&Cursor {
                version: 1,
                generation,
                video_id: video_id.into(),
                sort: sort.into(),
                offset: end,
                anchor: last.id.clone(),
                parent_id: parent_id.map(str::to_owned),
            })
            .expect("serializing a comments cursor cannot fail")
        })
    } else {
        None
    };
    Ok(VideoCommentsPage {
        video_id: video_id.into(),
        parent_id: parent_id.map(str::to_owned),
        items,
        next_cursor,
        total_count: None,
        disabled,
        sort: sort.into(),
        limited: more && end == MAX_COMMENTS,
    })
}

#[tauri::command]
pub async fn video_comments(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    video_id: String,
    cursor: Option<String>,
    sort: String,
    request_id: String,
    parent_id: Option<String>,
) -> AppResult<VideoCommentsPage> {
    validate_sort(&sort)?;
    if parent_id.as_deref().is_some_and(|id| id == "root" || !valid_comment_id(id)) {
        return Err(AppError::new("invalid_comment", "Choose a valid comment to view its replies."));
    }
    let normalized = normalize_video_ref(&video_id)?;
    // The command accepts a stable video identity only; playlist routing and
    // arbitrary external URLs do not belong in comment extraction.
    if normalized.video_id != video_id {
        return Err(AppError::new(
            "invalid_video",
            "Choose a valid YouTube video.",
        ));
    }
    if request_id.is_empty()
        || request_id.len() > 96
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':'))
    {
        return Err(AppError::new(
            "invalid_request",
            "Retry this comments request.",
        ));
    }
    let generation = state.sessions.snapshot().generation;
    let parent_id = parent_id.as_deref();
    let cursor = parse_cursor(cursor.as_deref(), &video_id, &sort, generation, parent_id)?;
    let limit =
        (cursor.as_ref().map_or(0, |cursor| cursor.offset) + PAGE_SIZE + 1).min(MAX_COMMENTS + 1);
    let value = state
        .gateway
        .comments_document(&app, &video_id, &sort, limit, parent_id, &request_id)
        .await?;
    ensure_generation(generation, state.sessions.snapshot().generation)?;
    page_from_json(&value, &video_id, &sort, generation, cursor, parent_id)
}

#[tauri::command]
pub fn cancel_comments(state: tauri::State<'_, AppState>, request_id: String) {
    if request_id.len() <= 96 {
        state.gateway.cancel(&format!("comments:{request_id}"));
    }
}

fn translation_failed() -> AppError {
    AppError::new(
        "comment_translation",
        "Translation is unavailable. Try again.",
    )
}

#[tauri::command]
pub async fn translate_comment(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    generation: u64,
    text: String,
) -> AppResult<String> {
    ensure_generation(generation, state.sessions.snapshot().generation)?;
    if text.len() > MAX_COMMENT_CHARS * 4
        || text.chars().count() > MAX_COMMENT_CHARS
        || text.trim().is_empty()
    {
        return Err(AppError::new(
            "invalid_comment",
            "Choose a comment to translate.",
        ));
    }
    let _slot = TRANSLATION_SLOTS.try_acquire().map_err(|_| {
        AppError::new(
            "translation_busy",
            "Other translations are running. Try again shortly.",
        )
    })?;
    let translation = tokio::time::timeout(Duration::from_secs(12), async {
        let mut command = state.tools.youtube_python()?;
        command
            .arg(
                state
                    .tools
                    .youtube_plugins(&app)?
                    .join("comment_translate.py"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        hide_command(&mut command);
        let mut child = command.spawn().map_err(|_| translation_failed())?;
        let _job = ProcessJob::attach(&child)?;
        let mut input = child.stdin.take().ok_or_else(translation_failed)?;
        input
            .write_all(text.as_bytes())
            .await
            .map_err(|_| translation_failed())?;
        drop(input);
        let mut output = child
            .stdout
            .take()
            .ok_or_else(translation_failed)?
            .take((MAX_TRANSLATION_BYTES + 1) as u64);
        let mut bytes = Vec::new();
        output
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| translation_failed())?;
        if bytes.len() > MAX_TRANSLATION_BYTES
            || !child
                .wait()
                .await
                .map_err(|_| translation_failed())?
                .success()
        {
            return Err(translation_failed());
        }
        let translated = String::from_utf8(bytes).map_err(|_| translation_failed())?;
        let translated = bounded_text(&translated, MAX_TRANSLATION_BYTES);
        if translated.trim().is_empty() {
            return Err(translation_failed());
        }
        Ok(translated)
    })
    .await
    .map_err(|_| translation_failed())??;
    ensure_generation(generation, state.sessions.snapshot().generation)?;
    Ok(translation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const VIDEO: &str = "fzQ6gRAEoy0";

    fn document(count: usize) -> Value {
        json!({"id":VIDEO,"comments":(0..count).map(|index|json!({
            "id":format!("comment-{index}"),"parent":"root","author":"@viewer",
            "text":format!("Comment {index}"),"like_count":index,"_time_text":"2 days ago"
        })).collect::<Vec<_>>(),"comment_count":count})
    }

    #[test]
    fn pages_anchor_to_comment_identity_when_newest_rows_shift() {
        let first = page_from_json(&document(21), VIDEO, "newest", 7, None, None).unwrap();
        assert_eq!(first.items.len(), 20);
        assert_eq!(first.total_count, None);
        let cursor = parse_cursor(first.next_cursor.as_deref(), VIDEO, "newest", 7, None).unwrap();
        let mut next = document(42);
        next["comments"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!({"id":"new-comment","text":"New","parent":"root"}));
        let second = page_from_json(&next, VIDEO, "newest", 7, cursor, None).unwrap();
        assert_eq!(second.items.first().unwrap().id, "comment-20");
    }

    #[test]
    fn cursors_are_bounded_and_scoped_to_video_sort_and_account_generation() {
        let first = page_from_json(&document(21), VIDEO, "top", 7, None, None).unwrap();
        let token = first.next_cursor.as_deref();
        assert!(parse_cursor(token, VIDEO, "top", 8, None).is_err());
        assert!(parse_cursor(token, VIDEO, "newest", 7, None).is_err());
        assert!(parse_cursor(token, "BaW_jenozKc", "top", 7, None).is_err());
        assert!(parse_cursor(Some(&"x".repeat(1537)), VIDEO, "top", 7, None).is_err());
        assert!(parse_cursor(Some("{}"), VIDEO, "top", 7, None).is_err());
    }

    #[test]
    fn disabled_empty_and_missing_sections_are_distinct() {
        let disabled =
            page_from_json(&json!({"id":VIDEO,"comments":null}), VIDEO, "top", 1, None, None).unwrap();
        assert!(disabled.disabled);
        let empty = page_from_json(&document(0), VIDEO, "top", 1, None, None).unwrap();
        assert!(!empty.disabled);
        assert!(empty.items.is_empty());
        assert!(page_from_json(&json!({"id":VIDEO}), VIDEO, "top", 1, None, None).is_err());
        assert!(page_from_json(
            &json!({"id":"BaW_jenozKc","comments":[]}),
            VIDEO,
            "top",
            1,
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn read_only_normalization_drops_replies_duplicates_and_unsafe_thumbnails() {
        let mut value = document(2);
        let rows = value["comments"].as_array_mut().unwrap();
        rows.push(rows[0].clone());
        rows.push(json!({"id":"reply","parent":"comment-0","text":"Reply"}));
        rows[0]["author_thumbnail"] = json!("https://googleusercontent.com.attacker.test/x");
        rows[1]["author_thumbnail"] = json!("https://yt3.ggpht.com/avatar");
        rows[0]["author_id"] = json!("https://example.com/channel/other");
        rows[1]["author_id"] = json!("UC1234567890123456789012");
        rows[1]["is_pinned"] = json!(true);
        let page = page_from_json(&value, VIDEO, "top", 1, None, None).unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.items[0].author_thumbnail.is_none());
        assert!(page.items[1].author_thumbnail.is_some());
        assert!(page.items[0].author_channel_id.is_none());
        assert_eq!(page.items[1].author_channel_id.as_deref(), Some("UC1234567890123456789012"));
        assert!(page.items[1].is_pinned);
        assert_eq!(page.items[0].reply_count, None);
    }

    #[test]
    fn removed_anchor_requests_refresh_instead_of_silently_skipping() {
        let first = page_from_json(&document(21), VIDEO, "top", 1, None, None).unwrap();
        let cursor = parse_cursor(first.next_cursor.as_deref(), VIDEO, "top", 1, None).unwrap();
        let error = page_from_json(&document(2), VIDEO, "top", 1, cursor, None).unwrap_err();
        assert_eq!(error.code, "comments_changed");
    }

    #[test]
    fn reply_pages_are_scoped_to_the_requested_parent() {
        let mut value = document(2);
        let rows = value["comments"].as_array_mut().unwrap();
        rows[0]["reply_count"] = json!(21);
        rows[0]["viewsical_has_replies"] = json!(true);
        for index in 0..21 {
            rows.push(json!({"id":format!("reply-{index}"),"parent":"comment-0","text":"Thread reply"}));
        }
        rows.push(json!({"id":"unrelated","parent":"comment-1","text":"Unrelated reply"}));
        let comments = page_from_json(&value, VIDEO, "top", 1, None, None).unwrap();
        assert!(comments.items[0].has_replies);
        let parent = Some("comment-0");
        let page = page_from_json(&value, VIDEO, "top", 1, None, parent).unwrap();
        assert_eq!(page.parent_id.as_deref(), parent);
        assert_eq!(page.items.len(), 20);
        let token = page.next_cursor.as_deref();
        assert!(parse_cursor(token, VIDEO, "top", 1, Some("comment-1")).is_err());
        let cursor = parse_cursor(token, VIDEO, "top", 1, parent).unwrap();
        let next = page_from_json(&value, VIDEO, "top", 1, cursor, parent).unwrap();
        assert_eq!(next.items[0].id, "reply-20");
        assert_eq!(next.items.len(), 1);
        assert!(page_from_json(&value, VIDEO, "top", 1, None, Some("missing")).is_err());
    }

    #[test]
    fn overall_limit_is_explicit_and_has_no_further_cursor() {
        let cursor = Cursor {
            version: 1,
            generation: 1,
            video_id: VIDEO.into(),
            sort: "top".into(),
            offset: 280,
            anchor: "comment-279".into(),
            parent_id: None,
        };
        let page = page_from_json(&document(301), VIDEO, "top", 1, Some(cursor), None).unwrap();
        assert_eq!(page.items.len(), 20);
        assert!(page.limited);
        assert!(page.next_cursor.is_none());
    }
}
