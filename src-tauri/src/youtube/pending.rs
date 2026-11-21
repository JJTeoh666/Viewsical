//! Keep a queue lookup alive while the queue or a foreground load needs it.
use super::playback::SourceKey;
use crate::models::{AppError, AppResult};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

type Outcome = Option<AppResult<bool>>;

struct Lookup {
    cancellation: CancellationToken,
    result: watch::Receiver<Outcome>,
}

impl Drop for Lookup {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Clone)]
pub(crate) struct PrefetchLookup(Arc<Lookup>);

impl PrefetchLookup {
    // Observation alone does not prolong a queued lookup.
    pub(crate) fn completion(&self) -> impl Future<Output = AppResult<bool>> + 'static {
        let mut result = self.0.result.clone();
        async move {
            let outcome = result
                .wait_for(Option::is_some)
                .await
                .map_err(|_| AppError::new("cancelled", "The source lookup was cancelled."))?;
            outcome
                .as_ref()
                .expect("wait_for checked that a result exists")
                .clone()
        }
    }
}

pub(super) struct PrefetchWork {
    cancellation: CancellationToken,
    result: watch::Sender<Outcome>,
}

impl PrefetchWork {
    pub(super) fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(super) fn finish(self, outcome: AppResult<bool>) {
        self.result.send_replace(Some(outcome));
    }
}

#[derive(Default)]
pub(super) struct PendingPrefetches(Mutex<HashMap<SourceKey, Weak<Lookup>>>);

impl PendingPrefetches {
    pub(super) fn attach(&self, key: &SourceKey) -> Option<PrefetchLookup> {
        let pending = self.0.lock().unwrap_or_else(|lock| lock.into_inner());
        pending
            .get(key)
            .and_then(Weak::upgrade)
            .filter(|lookup| {
                !lookup.cancellation.is_cancelled() && lookup.result.borrow().is_none()
            })
            .map(PrefetchLookup)
    }

    pub(super) fn reserve(&self, key: SourceKey) -> (PrefetchLookup, Option<PrefetchWork>) {
        let mut pending = self.0.lock().unwrap_or_else(|lock| lock.into_inner());
        pending.retain(|_, lookup| lookup.strong_count() > 0);
        if let Some(lookup) = pending.get(&key).and_then(Weak::upgrade).filter(|lookup| {
            !lookup.cancellation.is_cancelled() && lookup.result.borrow().is_none()
        }) {
            return (PrefetchLookup(lookup), None);
        }
        let cancellation = CancellationToken::new();
        let (sender, result) = watch::channel(None);
        let lookup = Arc::new(Lookup {
            cancellation: cancellation.clone(),
            result,
        });
        pending.insert(key, Arc::downgrade(&lookup));
        let work = PrefetchWork {
            cancellation,
            result: sender,
        };
        (PrefetchLookup(lookup), Some(work))
    }

    pub(super) fn cancel_all(&self) {
        let mut pending = self.0.lock().unwrap_or_else(|lock| lock.into_inner());
        for lookup in pending.values().filter_map(Weak::upgrade) {
            lookup.cancellation.cancel();
        }
        pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn attaching_before_queue_cancellation_keeps_one_lookup() {
        let pending = PendingPrefetches::default();
        let key = SourceKey::background("jNQXAC9IVRw", 1, "video");
        let (queue, work) = pending.reserve(key.clone());
        let work = work.unwrap();
        let play = pending.attach(&key).unwrap();
        let completion = play.completion();
        let (_, duplicate) = pending.reserve(key.clone());
        assert!(duplicate.is_none());
        drop(queue);
        assert!(!work.token().is_cancelled());
        work.finish(Ok(true));
        assert!(completion.await.unwrap());
        assert!(pending.attach(&key).is_none());
    }

    #[test]
    fn final_subscriber_and_account_change_cancel_work() {
        let pending = PendingPrefetches::default();
        let key = SourceKey::background("jNQXAC9IVRw", 1, "video");
        let (lookup, work) = pending.reserve(key.clone());
        let work = work.unwrap();
        let _observer = lookup.completion();
        assert!(pending
            .attach(&SourceKey::background("jNQXAC9IVRw", 1, "audio"))
            .is_none());
        assert!(pending
            .attach(&SourceKey::background("jNQXAC9IVRw", 2, "video"))
            .is_none());
        drop(lookup);
        assert!(work.token().is_cancelled());
        let (_lookup, work) = pending.reserve(key.clone());
        let work = work.unwrap();
        pending.cancel_all();
        assert!(work.token().is_cancelled());
        assert!(pending.attach(&key).is_none());
    }
}
