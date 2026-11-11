//! Bounded native→frontend event queue (Task 5).
//!
//! The host only polls `poll_events` at ~200ms intervals while a panel is
//! subscribed, so events emitted by background workers must survive until the
//! next drain without growing unbounded (design 约束：面板关闭期间事件不无限
//! 堆积). [`WebEventBroadcaster`] caps the queue at 2048 entries / 8 MiB
//! (whichever binds first) and drops the oldest entries on overflow. Progress
//! style high-frequency events go through [`coalesce_progress`] before
//! reaching the broadcaster.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Hard entry cap: at most this many queued events.
const MAX_ENTRIES: usize = 2048;
/// Hard size cap: at most this many approximate serialized bytes (8 MiB).
const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Minimum spacing between flushed `transfer-progress` emissions for one file.
const PROGRESS_FLUSH_INTERVAL: Duration = Duration::from_millis(250);

struct Entry {
    event: String,
    data: Value,
    /// Approximate serialized cost, computed once at push time so eviction
    /// never has to re-serialize the dropped payload.
    size: usize,
}

struct Queue {
    entries: VecDeque<Entry>,
    bytes: usize,
    dropped: u64,
}

/// Thread-safe bounded event queue between native workers and the frontend.
///
/// The broadcaster carries its own [`Mutex`]; callers that already hold the
/// global plugin slot mutex must not do long-running work with it held —
/// [`drain`](Self::drain) is a cheap `VecDeque` take, and payload
/// serialization happens after the slot mutex has been released.
pub struct WebEventBroadcaster {
    queue: Mutex<Queue>,
}

impl WebEventBroadcaster {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(Queue {
                entries: VecDeque::new(),
                bytes: 0,
                dropped: 0,
            }),
        }
    }

    /// Approximate serialized cost of one entry: payload length plus the event
    /// name (the `{"event":…, "data":…}` wrapper adds only constant overhead).
    fn entry_size(event: &str, data: &Value) -> usize {
        serde_json::to_vec(data)
            .map(|bytes| bytes.len())
            .unwrap_or(0)
            + event.len()
    }

    /// Queue one event, evicting oldest entries until both caps hold again.
    /// An event whose payload alone exceeds the byte budget can never fit and
    /// is dropped (counted) instead of being queued.
    pub fn send(&self, event: &str, data: Value) {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        let size = Self::entry_size(event, &data);
        if size > MAX_BYTES {
            queue.dropped += 1;
            return;
        }
        queue.entries.push_back(Entry {
            event: event.to_string(),
            data,
            size,
        });
        queue.bytes += size;
        while queue.entries.len() > MAX_ENTRIES || queue.bytes > MAX_BYTES {
            match queue.entries.pop_front() {
                Some(evicted) => {
                    queue.bytes -= evicted.size;
                    queue.dropped += 1;
                }
                None => break,
            }
        }
    }

    /// Take all queued events in FIFO order as `{"event": <name>, "data":
    /// <data>}` values and clear the queue.
    pub fn drain(&self) -> Vec<Value> {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        let entries = std::mem::take(&mut queue.entries);
        queue.bytes = 0;
        entries
            .into_iter()
            .map(|entry| json!({"event": entry.event, "data": entry.data}))
            .collect()
    }

    /// How many events have been dropped by the caps so far.
    pub fn dropped(&self) -> u64 {
        self.queue
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .dropped
    }
}

impl Default for WebEventBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

/// Rate-limit `transfer-progress` emissions per `(sessionId, fileId)`.
///
/// `pending` tracks the last flush of every file key: `(percent, payload,
/// flush instant)`. A call flushes — returns `Some(data)` — when it is the
/// first observation for the key, when at least
/// [`PROGRESS_FLUSH_INTERVAL`] (250ms) has elapsed since the last flush, or
/// when the percent advanced by ≥1 since the last flush. Otherwise the event
/// is coalesced away: the pending payload is refreshed and `None` is returned
/// while the flush clock and percent keep their last-flush values, so a burst
/// of sub-1% updates can never starve the 250ms cadence. `now` is injected to
/// keep tests deterministic; callers pass `Instant::now()`.
pub fn coalesce_progress(
    pending: &mut HashMap<(String, String), (u32, Value, Instant)>,
    session_id: &str,
    file_id: &str,
    percent: u32,
    data: Value,
    now: Instant,
) -> Option<Value> {
    let key = (session_id.to_string(), file_id.to_string());
    let flush = match pending.get(&key) {
        None => true,
        Some(&(last_percent, _, last_flush)) => {
            now.saturating_duration_since(last_flush) >= PROGRESS_FLUSH_INTERVAL
                || percent.saturating_sub(last_percent) >= 1
        }
    };
    if flush {
        pending.insert(key, (percent, data.clone(), now));
        return Some(data);
    }
    if let Some(entry) = pending.get_mut(&key) {
        entry.1 = data;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{coalesce_progress, WebEventBroadcaster};
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    #[test]
    fn drain_returns_sent_events_in_order() {
        let broadcaster = WebEventBroadcaster::new();
        broadcaster.send("device-found", json!({"alias": "测试机"}));
        broadcaster.send("transfer-done", json!({"sessionId": "s1"}));
        assert_eq!(broadcaster.dropped(), 0);

        let drained = broadcaster.drain();
        assert_eq!(drained.len(), 2);
        assert_eq!(
            drained[0],
            json!({"event": "device-found", "data": {"alias": "测试机"}})
        );
        assert_eq!(
            drained[1],
            json!({"event": "transfer-done", "data": {"sessionId": "s1"}})
        );
        assert!(broadcaster.drain().is_empty(), "drain must clear the queue");
    }

    #[test]
    fn queue_caps_at_2048_drop_oldest() {
        let broadcaster = WebEventBroadcaster::new();
        for index in 1..=2100u32 {
            broadcaster.send("tick", json!({"i": index}));
        }
        assert_eq!(broadcaster.dropped(), 52, "2100 - 2048 oldest dropped");

        let drained = broadcaster.drain();
        assert_eq!(drained.len(), 2048);
        assert_eq!(drained[0], json!({"event": "tick", "data": {"i": 53}}));
        assert_eq!(drained[2047], json!({"event": "tick", "data": {"i": 2100}}));
    }

    #[test]
    fn queue_caps_at_8mb() {
        let broadcaster = WebEventBroadcaster::new();
        let payload = "x".repeat(2 * 1024 * 1024);
        for index in 1..=6u32 {
            broadcaster.send("bulk", json!({"i": index, "payload": payload}));
        }

        let drained = broadcaster.drain();
        let total: usize = drained
            .iter()
            .map(|event| serde_json::to_vec(event).expect("serialize event").len())
            .sum();
        assert!(
            total <= 8 * 1024 * 1024,
            "queue must stay within 8 MiB, got {total} bytes"
        );
        assert!(
            (3..=4).contains(&drained.len()),
            "2 MiB payloads: expected 3-4 survivors, got {}",
            drained.len()
        );
        assert_eq!(
            drained.last().expect("non-empty")["data"]["i"].as_u64(),
            Some(6),
            "newest event must survive"
        );
        assert!(
            drained[0]["data"]["i"].as_u64().expect("index") > 1,
            "oldest events must be dropped first"
        );
        assert!(broadcaster.dropped() >= 1, "evictions must be counted");
    }

    #[test]
    fn progress_coalescing_helper() {
        let mut pending = HashMap::new();
        let start = Instant::now();

        // First observation for a (sessionId, fileId) flushes immediately.
        let first = coalesce_progress(&mut pending, "s1", "f1", 0, json!({"p": 0}), start);
        assert_eq!(first, Some(json!({"p": 0})));

        // Same key, inside the 250ms window, no percent jump → coalesced away.
        let second = coalesce_progress(
            &mut pending,
            "s1",
            "f1",
            0,
            json!({"p": 0}),
            start + Duration::from_millis(100),
        );
        assert_eq!(second, None);

        // Percent jumped by >=1 since the last flush → flush even inside the window.
        let third = coalesce_progress(
            &mut pending,
            "s1",
            "f1",
            1,
            json!({"p": 1}),
            start + Duration::from_millis(150),
        );
        assert_eq!(third, Some(json!({"p": 1})));

        // A different fileId is tracked independently → flushes immediately.
        let other = coalesce_progress(
            &mut pending,
            "s1",
            "f2",
            7,
            json!({"p": 7}),
            start + Duration::from_millis(160),
        );
        assert_eq!(other, Some(json!({"p": 7})));

        // 300ms after f1's last flush → time window elapsed → flush again.
        let later = coalesce_progress(
            &mut pending,
            "s1",
            "f1",
            1,
            json!({"p": 1}),
            start + Duration::from_millis(450),
        );
        assert_eq!(later, Some(json!({"p": 1})));
        assert_eq!(pending.len(), 2, "one pending entry per (sessionId, fileId)");
    }
}
