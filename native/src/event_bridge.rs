use serde_json::Value;

/// Placeholder broadcaster; Task 5 replaces this with the bounded queue
/// (2048 entries / 8 MB, drop-oldest) plus progress coalescing.
#[derive(Default)]
pub struct WebEventBroadcaster;

impl WebEventBroadcaster {
    pub fn new() -> Self {
        Self
    }

    pub fn drain(&self) -> Vec<Value> {
        Vec::new()
    }
}
