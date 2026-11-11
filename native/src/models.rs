use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// LocalSend v2 device announcement/registration DTO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub alias: String,
    pub version: String,
    pub device_model: Option<String>,
    pub device_type: Option<String>,
    pub fingerprint: String,
    pub port: u16,
    pub protocol: String,
    pub download: bool,
}

/// Optional file timestamps from the v2 protocol (ISO 8601 strings, nullable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub modified: Option<String>,
    pub accessed: Option<String>,
}

/// LocalSend v2 file entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    pub file_type: String,
    pub sha256: Option<String>,
    pub preview: Option<String>,
    pub metadata: Option<Metadata>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    Send,
    Receive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransferStatus {
    Pending,
    Transferring,
    Done,
    Cancelled,
    Failed,
}

/// Persisted transfer history entry (transfers.json); `created_at` is unix epoch millis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRecord {
    pub session_id: String,
    pub direction: Direction,
    pub peer_alias: String,
    pub files: Vec<FileEntry>,
    pub status: TransferStatus,
    pub created_at: u64,
    /// Final destination (absolute path) of every received file, keyed by
    /// fileId. Filled when a receive session reaches a terminal state; empty
    /// for send-direction records.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub destinations: HashMap<String, String>,
}
