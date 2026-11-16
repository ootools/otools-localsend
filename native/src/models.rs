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
    #[serde(default)]
    pub download: bool,
}

/// Official register/info response: the contacted endpoint already supplies
/// port and protocol, so neither field is present in this wire DTO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    pub alias: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_type: Option<String>,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub download: bool,
}

impl From<DeviceInfo> for RegisterResponse {
    fn from(info: DeviceInfo) -> Self {
        Self {
            alias: info.alias,
            version: info.version,
            device_model: info.device_model,
            device_type: info.device_type,
            fingerprint: info.fingerprint,
            download: info.download,
        }
    }
}

impl RegisterResponse {
    pub fn into_device_info(self, port: u16, protocol: String) -> DeviceInfo {
        DeviceInfo {
            alias: self.alias,
            version: self.version,
            device_model: self.device_model,
            device_type: self.device_type,
            fingerprint: self.fingerprint,
            port,
            protocol,
            download: self.download,
        }
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: u64,
    /// Final destination (absolute path) of every received file, keyed by
    /// fileId. Filled when a receive session reaches a terminal state; empty
    /// for send-direction records.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub destinations: HashMap<String, String>,
    /// Absolute local send sources. Kept only in local history, never FileEntry.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub sources: HashMap<String, String>,
}
