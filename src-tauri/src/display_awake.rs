use crate::models::PlayerState;
#[cfg(windows)]
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::Mutex,
};
#[cfg(windows)]
use windows::{
    core::{w, Result, PWSTR},
    Win32::{
        Foundation::HANDLE,
        System::{
            Power::{
                PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
                PowerRequestSystemRequired, PowerSetRequest,
            },
            Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
        },
    },
};

#[derive(Default)]
pub struct DisplayAwake {
    #[cfg(windows)]
    request: Mutex<Option<PowerRequest>>,
}

fn needs_display(state: &PlayerState, pause_requested: bool, closing: bool) -> bool {
    state.video.is_some()
        && state.playback_mode == "video"
        && state.status == "playing"
        && !pause_requested
        && !closing
}

impl DisplayAwake {
    pub fn update(&self, state: &PlayerState, pause_requested: bool, closing: bool) {
        let active = needs_display(state, pause_requested, closing);
        #[cfg(windows)]
        {
            let mut request = self.request.lock().unwrap_or_else(|lock| lock.into_inner());
            if !active {
                request.take();
            } else if request.is_none() {
                match PowerRequest::new() {
                    Ok(new) => *request = Some(new),
                    Err(error) => tracing::warn!(%error, "Could not keep the display awake"),
                }
            }
        }
        #[cfg(not(windows))]
        let _ = active;
    }
}

#[cfg(windows)]
struct PowerRequest(OwnedHandle);

#[cfg(windows)]
impl PowerRequest {
    fn new() -> Result<Self> {
        let context = REASON_CONTEXT {
            Version: 0, // POWER_REQUEST_CONTEXT_VERSION
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                // PowerCreateRequest only reads the reason string.
                SimpleReasonString: PWSTR(w!("Viewsical is playing a video.").as_ptr().cast_mut()),
            },
        };
        unsafe {
            let handle = PowerCreateRequest(&context)?;
            let owned = OwnedHandle::from_raw_handle(handle.0);
            PowerSetRequest(handle, PowerRequestDisplayRequired)?;
            // Windows requires a system request as well for the display to stay on.
            if let Err(error) = PowerSetRequest(handle, PowerRequestSystemRequired) {
                let _ = PowerClearRequest(handle, PowerRequestDisplayRequired);
                return Err(error);
            }
            Ok(Self(owned))
        }
    }
}

#[cfg(windows)]
impl Drop for PowerRequest {
    fn drop(&mut self) {
        let handle = HANDLE(self.0.as_raw_handle());
        unsafe {
            let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
            let _ = PowerClearRequest(handle, PowerRequestDisplayRequired);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MediaItem;

    #[test]
    fn only_active_video_playback_requires_the_display() {
        let mut state = PlayerState {
            video: Some(MediaItem::default()),
            status: "playing".into(),
            ..Default::default()
        };
        assert!(needs_display(&state, false, false));
        assert!(!needs_display(&state, true, false));
        assert!(!needs_display(&state, false, true));

        state.playback_mode = "audio".into();
        assert!(!needs_display(&state, false, false));
        state.playback_mode = "video".into();
        for status in [
            "paused",
            "ended",
            "idle",
            "failed",
            "preparing",
            "buffering",
        ] {
            state.status = status.into();
            assert!(!needs_display(&state, false, false), "{status}");
        }
    }
}
