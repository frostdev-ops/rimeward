//! A request's cancellation follows its native work, including time spent queued.
use std::sync::Arc;
use tokio::sync::watch;

pub struct Cancellation(watch::Sender<bool>);

impl Cancellation {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(watch::channel(false).0))
    }
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    pub async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
}

pub fn control(op: &str) -> bool {
    matches!(
        op,
        "lens-start" | "lens-stop" | "lens-pause" | "lens-resume" | "lens-status" | "overlay-clear"
    )
}

pub async fn permit(
    slots: Arc<tokio::sync::Semaphore>,
    request: Arc<Cancellation>,
    session: Option<Arc<Cancellation>>,
    deadline: i64,
) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    tokio::select! { biased;
        _ = request.cancelled() => Err("cancelled".into()),
        _ = async { if let Some(session) = session { session.cancelled().await; } else { std::future::pending::<()>().await; } } => Err("cancelled".into()),
        _ = tokio::time::sleep(std::time::Duration::from_millis((deadline - super::bridge::now_ms()).max(0) as u64)) => Err("deadline".into()),
        permit = slots.acquire_owned() => permit.map_err(|_| "cancelled".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_before_a_wait_is_retained() {
        let cancellation = Cancellation::new();
        cancellation.cancel();
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            cancellation.cancelled(),
        )
        .await
        .unwrap();
        assert!(cancellation.is_cancelled());
        assert!(control("lens-start"));
        assert!(control("lens-pause"));
        assert!(!control("lens-ocr"));
    }
    #[tokio::test]
    async fn cancelled_queued_reads_never_take_a_permit() {
        let slots = Arc::new(tokio::sync::Semaphore::new(0));
        let request = Cancellation::new();
        let session = Cancellation::new();
        let wait = permit(
            slots.clone(),
            request.clone(),
            Some(session.clone()),
            super::super::bridge::now_ms() + 30_000,
        );
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut wait)
                .await
                .is_err()
        );
        session.cancel();
        slots.add_permits(1);
        assert_eq!(wait.await.unwrap_err(), "cancelled");
        assert_eq!(slots.available_permits(), 1);
        request.cancel();
        assert_eq!(
            permit(
                slots.clone(),
                request,
                None,
                super::super::bridge::now_ms() + 30_000
            )
            .await
            .unwrap_err(),
            "cancelled"
        );
        assert_eq!(slots.available_permits(), 1);
    }
}
