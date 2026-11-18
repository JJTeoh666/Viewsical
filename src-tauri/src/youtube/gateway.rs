//! Adapter state, request ownership, cancellation, and shutdown.
use super::playback::PlaybackPlan;
use crate::{runtime::ToolPaths, session::SessionManager};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio_util::sync::CancellationToken;

type Active = Arc<Mutex<HashMap<String, (uuid::Uuid, CancellationToken)>>>;

pub(super) struct RequestGuard {
    id: String,
    nonce: uuid::Uuid,
    pub(super) token: CancellationToken,
    active: Active,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if active
            .get(&self.id)
            .is_some_and(|(id, _)| *id == self.nonce)
        {
            active.remove(&self.id);
        }
    }
}

pub struct YoutubeGateway {
    pub(super) tools: Arc<ToolPaths>,
    pub(super) sessions: Arc<SessionManager>,
    active: Active,
    pub(super) closing: AtomicBool,
    pub(super) sources: Mutex<HashMap<String, PlaybackPlan>>,
    pub(super) resolving: tokio::sync::Mutex<()>,
}
impl YoutubeGateway {
    pub fn new(tools: Arc<ToolPaths>, sessions: Arc<SessionManager>) -> Self {
        Self {
            tools,
            sessions,
            active: Arc::new(Mutex::new(HashMap::new())),
            closing: AtomicBool::new(false),
            sources: Mutex::new(HashMap::new()),
            resolving: tokio::sync::Mutex::new(()),
        }
    }

    pub(super) fn begin(&self, request_id: &str) -> RequestGuard {
        let token = CancellationToken::new();
        let nonce = uuid::Uuid::new_v4();
        if let Some((_, old)) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(request_id.into(), (nonce, token.clone()))
        {
            old.cancel();
        }
        RequestGuard {
            id: request_id.into(),
            nonce,
            token,
            active: self.active.clone(),
        }
    }

    pub fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.cancel_all();
    }

    pub fn cancel_all(&self) {
        self.sources
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        for (_, token) in active.values() {
            token.cancel();
        }
        active.clear();
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some((_, token)) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(request_id)
        {
            token.cancel();
        }
    }
}
