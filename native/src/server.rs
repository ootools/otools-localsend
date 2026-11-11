//! LocalSend v2 HTTPS server endpoints and the receive-session state machine
//! (Task 7).
//!
//! Layout: the axum layer (`build_router`, `run_server`, thin handlers) only
//! extracts transport facts (query params, remote IP, raw request body) and
//! delegates to plain, directly testable functions:
//!
//! - [`prepare_upload`] — the whole prepare-upload state machine (PIN check,
//!   single-active-session 409 rule, session creation, token issuance,
//!   `incoming-request` event) without any HTTP types.
//! - [`upload_stream`] — query/token/IP validation plus the streaming body
//!   write: chunks hit the disk as they arrive and the body is never buffered
//!   in memory (Review Focus #2), with incremental sha256 verification and the
//!   Done/Failed terminal transitions.
//! - [`session_accept`] / [`session_decline`] / [`session_cancel`] /
//!   [`transfer_records`] — the invoke-method surface used by the runtime.
//!
//! TLS wiring (axum-server + rustls) is exercised through the DLL smoke test;
//! the unit tests below drive the state machine directly, no sockets involved.

use crate::crypto::CertMaterial;
use crate::discovery::{self, DiscoveryShared};
use crate::event_bridge::{coalesce_progress, WebEventBroadcaster};
use crate::models::{DeviceInfo, Direction, FileEntry, TransferRecord, TransferStatus};
use crate::settings::Settings;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;

/// A stalled receive session older than this is swept so it cannot pin the
/// single-active-session rule forever (cancelled with a `transfer-done`).
const SESSION_EXPIRY_MS: u64 = 30 * 60 * 1000;
/// Pause between HTTPS bind attempts (matches the discovery loop's cadence).
const BIND_RETRY_PAUSE: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Receive-session state machine
// ---------------------------------------------------------------------------

/// State of one incoming transfer, keyed by session id. Mirrors the v2
/// receiver lifecycle: Pending (manual accept) or Transferring (auto-save) →
/// Done | Cancelled | Failed.
pub struct ReceiveSession {
    pub session_id: String,
    pub sender: DeviceInfo,
    pub files: HashMap<String, FileEntry>,
    /// fileId → upload token; only files accepted by the receiver get one.
    pub tokens: HashMap<String, String>,
    pub status: TransferStatus,
    pub sender_ip: IpAddr,
    pub pin_ok: bool,
    pub created_at: u64,
    pub temp_dir: PathBuf,
    /// File ids whose upload completed (sha256 verified when provided).
    pub uploaded: HashSet<String>,
    /// File ids that failed (sha256 mismatch, IO error, aborted body).
    pub failed: HashSet<String>,
}

struct Inner {
    sessions: HashMap<String, ReceiveSession>,
    records: Vec<TransferRecord>,
    /// Coalescing state for `transfer-progress` per (sessionId, fileId).
    progress: HashMap<(String, String), (u32, Value, Instant)>,
}

impl TransferStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TransferStatus::Done | TransferStatus::Cancelled | TransferStatus::Failed
        )
    }
}

/// The receive state machine store plus its persisted transfer history
/// (transfers.json). All mutations go through one mutex; the upload handler
/// only ever holds it for bookkeeping, never across body streaming.
pub struct ReceiveSessions {
    inner: Mutex<Inner>,
    tmp_root: PathBuf,
    transfers_path: PathBuf,
    events: Arc<WebEventBroadcaster>,
}

#[derive(Deserialize)]
#[serde(default)]
struct TransfersFile {
    transfers: Vec<TransferRecord>,
}

impl Default for TransfersFile {
    fn default() -> Self {
        Self { transfers: Vec::new() }
    }
}

impl ReceiveSessions {
    /// Create the store for `data_dir`, loading transfers.json history.
    /// A missing or unreadable history file starts with an empty list.
    pub fn new(data_dir: &Path, events: Arc<WebEventBroadcaster>) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|error| format!("create data dir {}: {error}", data_dir.display()))?;
        let transfers_path = data_dir.join("transfers.json");
        let records = match std::fs::read(&transfers_path) {
            Ok(bytes) => match serde_json::from_slice::<TransfersFile>(&bytes) {
                Ok(file) => file.transfers,
                Err(error) => {
                    eprintln!(
                        "otools-localsend server: unreadable transfers.json ({error}); starting with an empty history"
                    );
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Ok(Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                records,
                progress: HashMap::new(),
            }),
            tmp_root: data_dir.join("tmp"),
            transfers_path,
            events,
        })
    }

    /// Root of the per-session temp directories: `<data_dir>/tmp/<sessionId>`.
    pub fn tmp_root(&self) -> &Path {
        &self.tmp_root
    }

    fn has_active(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.sessions.values().any(|session| !session.status.is_terminal())
    }

    /// Cancel every non-terminal session older than [`SESSION_EXPIRY_MS`].
    /// Called from prepare-upload so a dead transfer cannot hold the
    /// single-session slot forever.
    fn sweep_expired(&self) {
        let now = now_ms();
        let expired: Vec<(String, PathBuf)> = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let expired: Vec<(String, PathBuf)> = inner
                .sessions
                .values()
                .filter(|session| {
                    !session.status.is_terminal()
                        && now.saturating_sub(session.created_at) >= SESSION_EXPIRY_MS
                })
                .map(|session| (session.session_id.clone(), session.temp_dir.clone()))
                .collect();
            for (session_id, _) in &expired {
                inner.sessions.remove(session_id);
                self.update_record(&mut inner, session_id, TransferStatus::Cancelled, None);
            }
            expired
        };
        for (session_id, temp_dir) in expired {
            let _ = std::fs::remove_dir_all(temp_dir);
            self.events.send(
                "transfer-done",
                json!({ "sessionId": session_id, "status": "cancelled" }),
            );
        }
    }

    /// Decline (UI action) — the sender side sees the same failure surface as
    /// after a cancel: the session is gone, so any upload attempt is rejected.
    pub fn session_decline(&self, session_id: &str) -> Result<(), String> {
        self.cancel_session(session_id)
    }

    /// Sender-initiated cancel (HTTP `/cancel`) or UI cancel.
    pub fn session_cancel(&self, session_id: &str) -> Result<(), String> {
        self.cancel_session(session_id)
    }

    fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        let temp_dir = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let Some(session) = inner.sessions.get(session_id) else {
                return Err(format!("session not found: {session_id}"));
            };
            let temp_dir = session.temp_dir.clone();
            let was_active = !session.status.is_terminal();
            inner.sessions.remove(session_id);
            if was_active {
                self.update_record(&mut inner, session_id, TransferStatus::Cancelled, None);
            }
            temp_dir
        };
        let _ = std::fs::remove_dir_all(temp_dir);
        self.events.send(
            "transfer-done",
            json!({ "sessionId": session_id, "status": "cancelled" }),
        );
        Ok(())
    }

    /// Issue tokens for the requested files of a Pending session and move it
    /// to Transferring. `None` accepts every file; unknown ids are skipped.
    /// Returns the sorted accepted file ids.
    pub fn session_accept(
        &self,
        session_id: &str,
        file_ids: Option<Vec<String>>,
    ) -> Result<Vec<String>, String> {
        let accepted = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let session = inner
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| format!("session not found: {session_id}"))?;
            if session.status != TransferStatus::Pending {
                return Err(format!(
                    "session {session_id} is not pending (status {:?})",
                    session.status
                ));
            }
            let requested: Vec<String> = match file_ids {
                None => {
                    let mut all: Vec<String> = session.files.keys().cloned().collect();
                    all.sort();
                    all
                }
                Some(ids) => ids.into_iter().filter(|id| session.files.contains_key(id)).collect(),
            };
            let mut accepted = Vec::new();
            for file_id in requested {
                if session.tokens.contains_key(&file_id) {
                    continue;
                }
                session
                    .tokens
                    .insert(file_id.clone(), uuid::Uuid::new_v4().to_string());
                accepted.push(file_id);
            }
            if accepted.is_empty() {
                return Err("no matching files to accept".into());
            }
            accepted.sort();
            session.status = TransferStatus::Transferring;
            accepted
        };
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            self.update_record(&mut inner, session_id, TransferStatus::Transferring, None);
        }
        Ok(accepted)
    }

    /// Append/update the persisted history entry of `session_id`.
    /// Called with the inner lock already held; must not re-lock.
    fn update_record(
        &self,
        inner: &mut Inner,
        session_id: &str,
        status: TransferStatus,
        destinations: Option<HashMap<String, String>>,
    ) {
        if let Some(record) = inner
            .records
            .iter_mut()
            .find(|record| record.session_id == session_id)
        {
            record.status = status;
            if let Some(destinations) = destinations {
                record.destinations = destinations;
            }
        }
        let payload = json!({ "transfers": inner.records });
        match serde_json::to_vec_pretty(&payload) {
            Ok(bytes) => {
                if let Err(error) = std::fs::write(&self.transfers_path, bytes) {
                    eprintln!("otools-localsend server: persist transfers: {error}");
                }
            }
            Err(error) => eprintln!("otools-localsend server: serialize transfers: {error}"),
        }
    }

    fn patch_record_destinations(&self, session_id: &str, destinations: HashMap<String, String>) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        self.update_record(&mut inner, session_id, TransferStatus::Done, Some(destinations));
    }

    /// Snapshot of the persisted history for `transfer_list`.
    pub fn transfer_records(&self) -> Vec<TransferRecord> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.records.clone()
    }
}

/// History snapshot for the runtime `transfer_list` method.
pub fn transfer_records(sessions: &ReceiveSessions) -> Vec<TransferRecord> {
    sessions.transfer_records()
}

/// Invoke-method surface: `session_accept {sessionId, fileIds?}` — `None`
/// accepts every pending file. Returns the sorted accepted file ids.
pub fn session_accept(
    sessions: &ReceiveSessions,
    session_id: &str,
    file_ids: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    sessions.session_accept(session_id, file_ids)
}

/// Invoke-method surface: `session_decline {sessionId}` — the sender side
/// sees the same failure surface as after a cancel (any upload attempt is
/// rejected because the session is gone).
pub fn session_decline(sessions: &ReceiveSessions, session_id: &str) -> Result<(), String> {
    sessions.session_decline(session_id)
}

/// Invoke-method surface: `session_cancel {sessionId}`.
pub fn session_cancel(sessions: &ReceiveSessions, session_id: &str) -> Result<(), String> {
    sessions.session_cancel(session_id)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Length-independent string comparison for PIN and token checks.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// File ids become path components below the session temp dir; reject
/// anything that could traverse or smuggle Windows path syntax.
fn is_safe_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id.contains(['/', '\\', ':'])
        && !id.chars().any(char::is_control)
}

/// Reduce a peer-provided file name to a bare file-name component (the
/// destination for download-dir moves).
fn safe_file_name(entry: &FileEntry) -> String {
    let cleaned: String = entry
        .file_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':') && !c.is_control())
        .collect();
    match Path::new(cleaned.trim()).file_name().and_then(|name| name.to_str()) {
        Some(name) if !name.is_empty() && name != "." && name != ".." => name.to_string(),
        _ => format!("file-{}", entry.id),
    }
}

/// The prepare-upload state machine (v2 `POST /prepare-upload`).
///
/// Returns `(status, body)`:
/// - `204` — no file transfer needed (empty files map);
/// - `401` — a PIN is set and missing/mismatched;
/// - `409` — another non-terminal receive session is active;
/// - `400` — a file id is unsafe as a path component;
/// - `200` — `{sessionId, files: {fileId: token}}` where `files` only
///   contains accepted files: all of them when auto-save is on (session
///   Transferring), none while a manual decision is pending (session
///   Pending; tokens are issued later by [`session_accept`], partial
///   accepts included).
pub fn prepare_upload(
    sessions: &ReceiveSessions,
    settings: &Settings,
    sender: DeviceInfo,
    files: HashMap<String, FileEntry>,
    pin: Option<String>,
    remote_ip: IpAddr,
) -> (u16, Value) {
    sessions.sweep_expired();
    if files.is_empty() {
        return (204, Value::Null);
    }
    if let Some(expected) = &settings.pin {
        let pin_ok = pin
            .as_deref()
            .map(|provided| constant_time_eq(provided, expected))
            .unwrap_or(false);
        if !pin_ok {
            return (401, json!({ "error": "Invalid PIN" }));
        }
    }
    if files.keys().any(|id| !is_safe_file_id(id)) {
        return (400, json!({ "error": "Invalid body" }));
    }
    if sessions.has_active() {
        return (409, json!({ "error": "Blocked by another session" }));
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let status = if settings.auto_save {
        TransferStatus::Transferring
    } else {
        TransferStatus::Pending
    };
    let temp_dir = sessions.tmp_root.join(&session_id);
    if let Err(error) = std::fs::create_dir_all(&temp_dir) {
        return (500, json!({ "error": format!("create temp dir: {error}") }));
    }
    let tokens: HashMap<String, String> = if settings.auto_save {
        files
            .keys()
            .map(|id| (id.clone(), uuid::Uuid::new_v4().to_string()))
            .collect()
    } else {
        HashMap::new()
    };
    let mut files_list: Vec<FileEntry> = files.values().cloned().collect();
    files_list.sort_by(|a, b| a.id.cmp(&b.id));
    let created_at = now_ms();
    let session = ReceiveSession {
        session_id: session_id.clone(),
        sender: sender.clone(),
        files,
        tokens,
        status,
        sender_ip: remote_ip,
        pin_ok: true,
        created_at,
        temp_dir,
        uploaded: HashSet::new(),
        failed: HashSet::new(),
    };

    {
        let mut inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        // Two concurrent prepares raced past the pre-check; only one may win.
        if inner.sessions.values().any(|session| !session.status.is_terminal()) {
            let _ = std::fs::remove_dir_all(&session.temp_dir);
            return (409, json!({ "error": "Blocked by another session" }));
        }
        inner.sessions.insert(session_id.clone(), session);
        inner.records.push(TransferRecord {
            session_id: session_id.clone(),
            direction: Direction::Receive,
            peer_alias: sender.alias.clone(),
            files: files_list.clone(),
            status,
            created_at,
            destinations: HashMap::new(),
        });
        sessions.update_record(&mut inner, &session_id, status, None);
    }

    sessions.events.send(
        "incoming-request",
        json!({
            "sessionId": session_id,
            "sender": sender,
            "files": files_list,
        }),
    );

    let tokens = {
        let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner
            .sessions
            .get(&session_id)
            .map(|session| session.tokens.clone())
            .unwrap_or_default()
    };
    (200, json!({ "sessionId": session_id, "files": tokens }))
}

/// Terminal-state payload produced when the last file of a session completes.
struct TerminalPlan {
    session_id: String,
    status: TransferStatus,
    /// (fileId, source, target) moves — empty unless Done with a download dir.
    moves: Vec<(String, PathBuf, PathBuf)>,
    destinations: HashMap<String, String>,
    temp_dir: PathBuf,
}

impl ReceiveSessions {
    /// Mark one file terminal; when the last file settles, terminate the
    /// session itself (Done when every file uploaded, Failed otherwise),
    /// update the history record and produce the move plan. Called with the
    /// lock held only for the bookkeeping — the caller performs the IO.
    fn mark_file_terminal(
        &self,
        session_id: &str,
        file_id: &str,
        ok: bool,
        download_dir: Option<&Path>,
    ) -> Option<TerminalPlan> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let plan = {
            let session = inner.sessions.get_mut(session_id)?;
            if ok {
                session.uploaded.insert(file_id.to_string());
            } else {
                session.failed.insert(file_id.to_string());
            }
            let all_terminal = session
                .files
                .keys()
                .all(|id| session.uploaded.contains(id) || session.failed.contains(id));
            if !all_terminal {
                return None;
            }
            let status = if session.failed.is_empty() {
                TransferStatus::Done
            } else {
                TransferStatus::Failed
            };
            session.status = status;
            let mut moves = Vec::new();
            let mut destinations = HashMap::new();
            for id in &session.uploaded {
                let source = session.temp_dir.join(id);
                let target = match download_dir {
                    Some(dir) => dir.join(safe_file_name(&session.files[id])),
                    None => source.clone(),
                };
                destinations.insert(id.clone(), target.to_string_lossy().into_owned());
                if target != source {
                    moves.push((id.clone(), source, target));
                }
            }
            for id in &session.failed {
                let source = session.temp_dir.join(id);
                destinations.insert(id.clone(), source.to_string_lossy().into_owned());
            }
            TerminalPlan {
                session_id: session_id.to_string(),
                status,
                moves,
                destinations,
                temp_dir: session.temp_dir.clone(),
            }
        };
        self.update_record(&mut inner, session_id, plan.status, Some(plan.destinations.clone()));
        Some(plan)
    }
}

/// Execute a terminal plan: move temp files into the download dir (rename
/// with a copy+delete fallback for cross-volume moves), record the final
/// destinations and emit `transfer-done`.
async fn execute_terminal_plan(sessions: Arc<ReceiveSessions>, plan: TerminalPlan) {
    if plan.status == TransferStatus::Done {
        let mut final_destinations = plan.destinations.clone();
        let mut all_moved = true;
        for (file_id, source, target) in &plan.moves {
            let unique = pick_unique_path(target).await;
            match move_file(source, &unique).await {
                Ok(()) => {
                    final_destinations
                        .insert(file_id.clone(), unique.to_string_lossy().into_owned());
                }
                Err(error) => {
                    all_moved = false;
                    eprintln!("otools-localsend server: move {source:?}: {error}");
                    final_destinations
                        .insert(file_id.clone(), source.to_string_lossy().into_owned());
                }
            }
        }
        if final_destinations != plan.destinations {
            sessions.patch_record_destinations(&plan.session_id, final_destinations);
        }
        // Only clean the session dir when everything moved out; without a
        // download dir the received files intentionally stay in tmp.
        if all_moved && !plan.moves.is_empty() {
            let _ = tokio::fs::remove_dir_all(&plan.temp_dir).await;
        }
    }
    let status = if plan.status == TransferStatus::Done {
        "done"
    } else {
        "failed"
    };
    sessions.events.send(
        "transfer-done",
        json!({ "sessionId": plan.session_id, "status": status }),
    );
}

/// Rename with a copy+delete fallback (Windows refuses cross-volume renames).
async fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    match tokio::fs::rename(source, target).await {
        Ok(()) => Ok(()),
        Err(_) => {
            tokio::fs::copy(source, target).await?;
            tokio::fs::remove_file(source).await
        }
    }
}

/// Never overwrite an existing download: pick `name (n).ext`.
async fn pick_unique_path(target: &Path) -> PathBuf {
    if !tokio::fs::try_exists(target).await.unwrap_or(false) {
        return target.to_path_buf();
    }
    let stem = target
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("file")
        .to_string();
    let extension = target
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    for index in 1..1000u32 {
        let candidate = target.with_file_name(format!("{stem} ({index}){extension}"));
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }
    target.to_path_buf()
}

/// Throttled `transfer-progress` emission during the streaming write.
fn emit_progress(
    sessions: &ReceiveSessions,
    session_id: &str,
    file_id: &str,
    received: u64,
    total: u64,
) {
    let percent = if total == 0 {
        100u32
    } else {
        ((received.saturating_mul(100)) / total).min(100) as u32
    };
    let payload = json!({
        "sessionId": session_id,
        "fileId": file_id,
        "percent": percent,
    });
    let flush = {
        let mut inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        coalesce_progress(
            &mut inner.progress,
            session_id,
            file_id,
            percent,
            payload,
            Instant::now(),
        )
    };
    if let Some(payload) = flush {
        sessions.events.send("transfer-progress", payload);
    }
}

/// The upload endpoint state machine (v2 `POST /upload`).
///
/// `(400)` missing parameters, `(403)` wrong token or peer IP, `(409)` wrong
/// session state / file not accepted, `(422)` sha256 mismatch (temp file
/// deleted), `(500)` IO failure, `(200)` success. The body is streamed to
/// `tmp/<sessionId>/<fileId>` chunk by chunk — never buffered in memory.
pub async fn upload_stream(
    sessions: Arc<ReceiveSessions>,
    download_dir: Option<PathBuf>,
    session_id: String,
    file_id: String,
    token: String,
    remote_ip: IpAddr,
    body: Body,
) -> (u16, Value) {
    if session_id.is_empty() || file_id.is_empty() || token.is_empty() {
        return (400, json!({ "error": "Missing parameters" }));
    }

    // Phase 1 — authorize and compute the target path (short lock, no awaits).
    let (temp_path, temp_dir, expected_size) = {
        let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(session) = inner.sessions.get(&session_id) else {
            return (403, json!({ "error": "Invalid token or IP address" }));
        };
        if session.sender_ip != remote_ip {
            return (403, json!({ "error": "Invalid token or IP address" }));
        }
        let Some(entry) = session.files.get(&file_id) else {
            return (403, json!({ "error": "Invalid token or IP address" }));
        };
        if let Some(issued) = session.tokens.get(&file_id) {
            if !constant_time_eq(&token, issued) {
                return (403, json!({ "error": "Invalid token or IP address" }));
            }
        }
        if session.status != TransferStatus::Transferring {
            return (409, json!({ "error": "Blocked by another session" }));
        }
        if !session.tokens.contains_key(&file_id) {
            return (409, json!({ "error": "File not accepted for upload" }));
        }
        if session.uploaded.contains(&file_id) || session.failed.contains(&file_id) {
            return (409, json!({ "error": "File already transferred" }));
        }
        (session.temp_dir.join(&file_id), session.temp_dir.clone(), entry.size)
    };

    if let Err(error) = tokio::fs::create_dir_all(&temp_dir).await {
        return (500, json!({ "error": format!("create temp dir: {error}") }));
    }

    // Phase 2 — stream the body to disk. No lock is held: chunks are written
    // as they arrive and the sha256 is computed incrementally, so memory use
    // stays flat regardless of file size (Review Focus #2).
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut write_error: Option<String> = None;
    let mut body_error = false;
    let mut file = match tokio::fs::File::create(&temp_path).await {
        Ok(file) => file,
        Err(error) => return (500, json!({ "error": format!("open temp file: {error}") })),
    };
    let mut body = body;
    loop {
        let frame = match body.frame().await {
            Some(frame) => frame,
            None => break,
        };
        match frame {
            Ok(frame) => {
                if let Some(data) = frame.data_ref() {
                    hasher.update(data);
                    if let Err(error) = file.write_all(data).await {
                        write_error = Some(format!("write temp file: {error}"));
                        break;
                    }
                    received += data.len() as u64;
                    emit_progress(&sessions, &session_id, &file_id, received, expected_size);
                }
            }
            Err(_) => {
                body_error = true;
                break;
            }
        }
    }
    if let Err(error) = file.flush().await {
        write_error = Some(format!("flush temp file: {error}"));
    }
    drop(file);

    // Phase 3 — verify and finalize.
    if let Some(error) = write_error {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let plan = sessions.mark_file_terminal(&session_id, &file_id, false, download_dir.as_deref());
        if let Some(plan) = plan {
            execute_terminal_plan(Arc::clone(&sessions), plan).await;
        }
        return (500, json!({ "error": error }));
    }
    if body_error {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let plan = sessions.mark_file_terminal(&session_id, &file_id, false, download_dir.as_deref());
        if let Some(plan) = plan {
            execute_terminal_plan(Arc::clone(&sessions), plan).await;
        }
        return (400, json!({ "error": "Upload aborted by the sender" }));
    }
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let expected_sha = {
        let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner
            .sessions
            .get(&session_id)
            .and_then(|session| session.files.get(&file_id))
            .and_then(|entry| entry.sha256.clone())
    };
    let Some(expected_sha) = expected_sha else {
        // The session vanished while streaming (cancelled by UI/sender).
        let _ = tokio::fs::remove_file(&temp_path).await;
        return (409, json!({ "error": "Blocked by another session" }));
    };
    if !expected_sha.eq_ignore_ascii_case(&digest) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let plan = sessions.mark_file_terminal(&session_id, &file_id, false, download_dir.as_deref());
        if let Some(plan) = plan {
            execute_terminal_plan(Arc::clone(&sessions), plan).await;
        }
        return (422, json!({ "error": "Checksum mismatch (sha256)" }));
    }
    let plan = sessions.mark_file_terminal(&session_id, &file_id, true, download_dir.as_deref());
    if let Some(plan) = plan {
        execute_terminal_plan(Arc::clone(&sessions), plan).await;
    }
    (200, Value::Null)
}

// ---------------------------------------------------------------------------
// HTTPS server (axum-server + rustls)
// ---------------------------------------------------------------------------

/// State shared between the HTTPS server task and the runtime dispatch
/// methods. `settings` is a live snapshot (`settings_set` refreshes it);
/// `server_port` records the port actually bound after fallback.
pub struct ServerShared {
    pub sessions: Arc<ReceiveSessions>,
    pub settings: Arc<RwLock<Settings>>,
    pub broadcaster: Arc<WebEventBroadcaster>,
    pub data_dir: PathBuf,
    pub cert: CertMaterial,
    pub server_port: AtomicU16,
    pub bind_error: Mutex<Option<String>>,
    /// Discovery hook: on a successful (possibly fallback) bind the announce
    /// payload is reconciled through `DiscoveryShared::update_local_info`.
    pub discovery: Option<Arc<DiscoveryShared>>,
}

fn our_info(state: &ServerShared) -> DeviceInfo {
    if let Some(discovery) = &state.discovery {
        return discovery.snapshot_local_info();
    }
    let settings = state
        .settings
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    discovery::local_info_from_settings(&settings, &state.cert.fingerprint)
}

/// The v2 route table. No auth on register/info; prepare-upload enforces the
/// PIN; upload/cancel validate query params themselves.
pub fn build_router(state: Arc<ServerShared>) -> Router {
    Router::new()
        .route("/api/localsend/v2/register", post(register_handler))
        .route("/api/localsend/v2/prepare-upload", post(prepare_upload_handler))
        .route("/api/localsend/v2/upload", post(upload_handler))
        .route("/api/localsend/v2/cancel", post(cancel_handler))
        .route("/api/localsend/v2/info", get(info_handler))
        // File bodies can exceed axum's 2 MiB default limit; uploads stream
        // straight to disk, so no limit is needed.
        .layer(DefaultBodyLimit::disable())
        .with_state(state)
}

fn json_response(status: u16, value: Value) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    if value.is_null() {
        return code.into_response();
    }
    (code, Json(value)).into_response()
}


/// `POST /api/localsend/v2/register` — announce our own device info. No auth.
async fn register_handler(State(state): State<Arc<ServerShared>>) -> Response {
    Json(our_info(&state)).into_response()
}

/// `GET /api/localsend/v2/info` — debug route, same payload as register.
async fn info_handler(State(state): State<Arc<ServerShared>>) -> Response {
    Json(our_info(&state)).into_response()
}

#[derive(Debug, Deserialize)]
struct PrepareQuery {
    pin: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PrepareBody {
    info: DeviceInfo,
    files: HashMap<String, FileEntry>,
}

async fn prepare_upload_handler(
    State(state): State<Arc<ServerShared>>,
    Query(query): Query<PrepareQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PrepareBody>,
) -> Response {
    let settings = state
        .settings
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    // The map key is the canonical fileId; keep entries consistent with it.
    let files: HashMap<String, FileEntry> = body
        .files
        .into_iter()
        .map(|(key, mut entry)| {
            entry.id = key.clone();
            (key, entry)
        })
        .collect();
    let (status, value) = prepare_upload(
        &state.sessions,
        &settings,
        body.info,
        files,
        query.pin,
        addr.ip(),
    );
    json_response(status, value)
}

#[derive(Debug, Deserialize)]
struct UploadQuery {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "fileId")]
    file_id: Option<String>,
    token: Option<String>,
}

async fn upload_handler(
    State(state): State<Arc<ServerShared>>,
    Query(query): Query<UploadQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Body,
) -> Response {
    let download_dir = state
        .settings
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .download_dir
        .clone()
        .map(PathBuf::from);
    let (status, value) = upload_stream(
        Arc::clone(&state.sessions),
        download_dir,
        query.session_id.unwrap_or_default(),
        query.file_id.unwrap_or_default(),
        query.token.unwrap_or_default(),
        addr.ip(),
        body,
    )
    .await;
    json_response(status, value)
}

#[derive(Debug, Deserialize)]
struct CancelQuery {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

/// `POST /api/localsend/v2/cancel` — idempotent: an unknown session still
/// answers 200 with an empty body (v2 semantics).
async fn cancel_handler(
    State(state): State<Arc<ServerShared>>,
    Query(query): Query<CancelQuery>,
) -> Response {
    if let Some(session_id) = query.session_id.filter(|id| !id.is_empty()) {
        let _ = session_cancel(&state.sessions, &session_id);
    }
    StatusCode::OK.into_response()
}

/// Bind TCP on `0.0.0.0:port` with the discovery-style fallback window
/// (`port..=port + PORT_FALLBACK_ATTEMPTS`). TCP and UDP discovery ports are
/// independent; each may fall back separately.
fn bind_https_listener(port: u16) -> io::Result<(std::net::TcpListener, u16)> {
    let mut last_error = None;
    for candidate in port..=port.saturating_add(discovery::PORT_FALLBACK_ATTEMPTS) {
        match std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, candidate)) {
            Ok(listener) => return Ok((listener, candidate)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::AddrNotAvailable, "no HTTPS port candidate")
    }))
}

/// Serve the v2 HTTPS endpoints until the owning runtime is dropped.
///
/// Binds the configured port with fallback, records the actual port, feeds it
/// back into the discovery announce payload (`update_local_info`) and emits
/// `server-status {port, protocol: "https", fingerprint}` — or
/// `server-status {error}` when no port could be bound (Review Focus #1: the
/// UI must show the failure instead of "searching forever").
pub async fn run_server(state: Arc<ServerShared>) {
    // axum-server is built with `tls-rustls-no-provider`; install the ring
    // provider once for the process (same baseline as otools-ai-switch).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let config = match axum_server::tls_rustls::RustlsConfig::from_der(
        vec![state.cert.cert_der.clone()],
        state.cert.key_der.clone(),
    )
    .await
    {
        Ok(config) => config,
        Err(error) => {
            let message = format!("TLS setup failed: {error}");
            *state
                .bind_error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(message.clone());
            state.broadcaster.send("server-status", json!({ "error": message }));
            return;
        }
    };

    let settings_port = state
        .settings
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .port;
    let mut last_error: Option<String> = None;
    loop {
        match bind_https_listener(settings_port) {
            Ok((listener, port)) => {
                state.server_port.store(port, Ordering::SeqCst);
                *state
                    .bind_error
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
                last_error = None;
                // Handoff from Task 6: the announce payload must carry the
                // REAL bound port after a fallback.
                if let Some(discovery) = &state.discovery {
                    let mut info = discovery.snapshot_local_info();
                    if info.port != port {
                        info.port = port;
                        discovery.update_local_info(info);
                    }
                }
                state.broadcaster.send(
                    "server-status",
                    json!({
                        "port": port,
                        "protocol": "https",
                        "fingerprint": state.cert.fingerprint,
                    }),
                );
                let app = build_router(Arc::clone(&state));
                if let Err(error) = axum_server::from_tcp_rustls(listener, config.clone())
                    .serve(app.into_make_service_with_connect_info::<SocketAddr>())
                    .await
                {
                    eprintln!("otools-localsend server: serve: {error}");
                }
                // The listener died; report unbound and retry after a pause.
                state.server_port.store(0, Ordering::SeqCst);
                tokio::time::sleep(BIND_RETRY_PAUSE).await;
            }
            Err(error) => {
                let message = format!(
                    "HTTPS bind failed on ports {settings_port}..={} (already in use or blocked): {error}",
                    settings_port.saturating_add(discovery::PORT_FALLBACK_ATTEMPTS)
                );
                // Only surface the first failure (or a changed message) so a
                // permanently busy port does not flood the event queue.
                if last_error.as_deref() != Some(message.as_str()) {
                    state.broadcaster.send("server-status", json!({ "error": message }));
                    last_error = Some(message.clone());
                }
                *state
                    .bind_error
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(message);
                tokio::time::sleep(BIND_RETRY_PAUSE).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        prepare_upload, session_accept, session_cancel, session_decline, transfer_records,
        upload_stream, ReceiveSessions,
    };
    use crate::crypto::sha256_hex;
    use crate::event_bridge::WebEventBroadcaster;
    use crate::models::{DeviceInfo, Direction, FileEntry, TransferRecord, TransferStatus};
    use crate::settings::Settings;
    use axum::body::{Body, Bytes};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::net::{IpAddr, Ipv4Addr};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    const SENDER_IP: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
    const OTHER_IP: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 99));

    fn sender_info() -> DeviceInfo {
        DeviceInfo {
            alias: "Mock Sender".into(),
            version: "2.2".into(),
            device_model: Some("Pixel 9".into()),
            device_type: Some("phone".into()),
            fingerprint: "f".repeat(64),
            port: 53317,
            protocol: "https".into(),
            download: false,
        }
    }

    fn file_entry(id: &str, size: u64, sha256: Option<&str>) -> FileEntry {
        FileEntry {
            id: id.to_string(),
            file_name: format!("{id}.bin"),
            size,
            file_type: "application/octet-stream".into(),
            sha256: sha256.map(str::to_string),
            preview: None,
            metadata: None,
        }
    }

    fn files_map(entries: &[FileEntry]) -> HashMap<String, FileEntry> {
        entries
            .iter()
            .map(|entry| (entry.id.clone(), entry.clone()))
            .collect()
    }

    fn settings(auto_save: bool, pin: Option<&str>) -> Settings {
        Settings {
            auto_save,
            pin: pin.map(str::to_string),
            ..Default::default()
        }
    }

    fn empty_body() -> Body {
        Body::from_stream(tokio_stream::iter(
            Vec::<Result<Bytes, std::io::Error>>::new(),
        ))
    }

    fn body_from_chunks(chunks: &[&[u8]]) -> Body {
        let items: Vec<Result<Bytes, std::io::Error>> = chunks
            .iter()
            .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
            .collect();
        Body::from_stream(tokio_stream::iter(items))
    }

    fn prepare(
        sessions: &ReceiveSessions,
        settings: &Settings,
        entries: &[FileEntry],
        pin: Option<&str>,
        ip: IpAddr,
    ) -> (u16, Value) {
        prepare_upload(
            sessions,
            settings,
            sender_info(),
            files_map(entries),
            pin.map(str::to_string),
            ip,
        )
    }

    fn session_status(sessions: &ReceiveSessions, session_id: &str) -> Option<TransferStatus> {
        let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.sessions.get(session_id).map(|session| session.status)
    }

    fn record_for<'a>(
        records: &'a [TransferRecord],
        session_id: &str,
    ) -> &'a TransferRecord {
        records
            .iter()
            .find(|record| record.session_id == session_id)
            .expect("record present")
    }

    /// Clone of the history record for a session (avoids temporary borrows).
    fn record_snapshot(sessions: &ReceiveSessions, session_id: &str) -> TransferRecord {
        transfer_records(sessions)
            .into_iter()
            .find(|record| record.session_id == session_id)
            .expect("record present")
    }

    fn event_data(events: &WebEventBroadcaster, name: &str) -> Vec<Value> {
        events
            .drain()
            .into_iter()
            .filter(|event| event["event"] == name)
            .map(|event| event["data"].clone())
            .collect()
    }

    /// Poll until the temp file on disk holds at least `expected` bytes.
    async fn wait_for_size(path: &Path, expected: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(metadata) = tokio::fs::metadata(path).await {
                if metadata.len() >= expected {
                    return;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "temp file never reached {expected} bytes: {path:?}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[test]
    fn prepare_upload_issues_tokens() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, None);

        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];
        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);

        assert_eq!(status, 200, "auto-accept prepare must succeed: {body}");
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token1 = body["files"]["f1"].as_str().expect("f1 token").to_string();
        let token2 = body["files"]["f2"].as_str().expect("f2 token").to_string();
        assert!(!token1.is_empty() && !token2.is_empty(), "tokens are issued");
        assert_ne!(token1, token2, "tokens are unique per file");

        {
            let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
            let session = inner.sessions.get(&session_id).expect("session stored");
            assert_eq!(session.status, TransferStatus::Transferring);
            assert_eq!(session.tokens["f1"], token1);
            assert_eq!(session.tokens["f2"], token2);
            assert_eq!(session.sender.alias, "Mock Sender");
            assert_eq!(session.sender_ip, SENDER_IP);
            assert!(session.pin_ok);
        }
        assert!(
            sessions.tmp_root().join(&session_id).is_dir(),
            "per-session temp dir prepared"
        );

        let incoming = event_data(&events, "incoming-request");
        assert_eq!(incoming.len(), 1, "exactly one incoming-request event");
        assert_eq!(incoming[0]["sessionId"], session_id);
        assert_eq!(incoming[0]["sender"]["alias"], "Mock Sender");
        assert_eq!(
            incoming[0]["files"].as_array().expect("files array").len(),
            2,
            "incoming-request carries the file list"
        );

        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.direction, Direction::Receive);
        assert_eq!(record.peer_alias, "Mock Sender");
        assert_eq!(record.status, TransferStatus::Transferring);
        assert_eq!(record.files.len(), 2);
    }

    #[test]
    fn prepare_upload_requires_pin_when_set() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, Some("123456"));
        let entries = [file_entry("f1", 10, None)];

        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 401, "missing pin: {body}");
        let (status, _) = prepare(&sessions, &config, &entries, Some("000000"), SENDER_IP);
        assert_eq!(status, 401, "wrong pin");
        let (status, body) = prepare(&sessions, &config, &entries, Some("123456"), SENDER_IP);
        assert_eq!(status, 200, "correct pin passes: {body}");

        // The failed attempts must not have occupied the single-session slot.
        let (status, _) = prepare(&sessions, &config, &entries, Some("123456"), SENDER_IP);
        assert_eq!(status, 409, "the accepted session now blocks a second one");

        let incoming = event_data(&events, "incoming-request");
        assert_eq!(
            incoming.len(),
            1,
            "rejected PIN attempts emit no incoming-request"
        );
    }

    #[test]
    fn prepare_upload_rejects_second_session() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, None);
        let entries = [file_entry("f1", 10, None)];

        let (status, first) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let first_id = first["sessionId"].as_str().expect("sessionId").to_string();

        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 409, "second active session blocked: {body}");

        session_cancel(&sessions, &first_id).expect("cancel the first session");
        let (status, _) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200, "a terminal session frees the single slot");
    }

    #[test]
    fn prepare_upload_pending_when_manual() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(false, None);

        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];
        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);

        assert_eq!(status, 200, "manual prepare answers immediately: {body}");
        assert_eq!(
            body["files"],
            json!({}),
            "no tokens before the user accepts"
        );
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        {
            let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
            let session = inner.sessions.get(&session_id).expect("session stored");
            assert_eq!(session.status, TransferStatus::Pending);
            assert!(session.tokens.is_empty(), "no tokens in pending state");
        }

        let incoming = event_data(&events, "incoming-request");
        assert_eq!(incoming.len(), 1, "manual mode still notifies the panel");
        assert_eq!(incoming[0]["sessionId"], session_id);
        assert_eq!(
            incoming[0]["files"].as_array().expect("files array").len(),
            2
        );
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Pending);
    }

    #[tokio::test]
    async fn accept_after_pending_issues_remaining_tokens() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(false, None);
        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];

        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();

        let accepted = session_accept(&sessions, &session_id, Some(vec!["f1".into()]))
            .expect("partial accept");
        assert_eq!(accepted, vec!["f1".to_string()]);
        {
            let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
            let session = inner.sessions.get(&session_id).expect("session stored");
            assert_eq!(session.status, TransferStatus::Transferring);
            assert_eq!(session.tokens.len(), 1, "only the accepted file got a token");
            assert!(session.tokens.contains_key("f1"));
        }

        // The file without a token is not uploadable.
        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f2".into(),
            "whatever".into(),
            SENDER_IP,
            empty_body(),
        )
        .await;
        assert_eq!(status, 409, "file without a token is not accepted for upload");

        // Accept-all: fileIds omitted means every file of the session.
        session_cancel(&sessions, &session_id).expect("cancel the first session");
        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let accepted = session_accept(&sessions, &session_id, None).expect("accept all");
        assert_eq!(accepted, vec!["f1".to_string(), "f2".to_string()]);
        let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        let session = inner.sessions.get(&session_id).expect("session stored");
        assert_eq!(session.status, TransferStatus::Transferring);
        assert_eq!(session.tokens.len(), 2);
    }

    #[tokio::test]
    async fn upload_rejects_bad_token_and_wrong_ip() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);
        let entries = [file_entry("f1", 10, None)];

        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token = body["files"]["f1"].as_str().expect("token").to_string();

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f1".into(),
            "wrong-token".into(),
            SENDER_IP,
            empty_body(),
        )
        .await;
        assert_eq!(status, 403, "forged token rejected");

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f1".into(),
            token.clone(),
            OTHER_IP,
            empty_body(),
        )
        .await;
        assert_eq!(status, 403, "upload from a foreign IP rejected");

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            "no-such-session".into(),
            "f1".into(),
            token.clone(),
            SENDER_IP,
            empty_body(),
        )
        .await;
        assert_eq!(status, 403, "unknown session cannot verify a token");

        {
            let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
            let session = inner.sessions.get(&session_id).expect("session stored");
            assert_eq!(session.status, TransferStatus::Transferring);
            assert!(session.uploaded.is_empty(), "no file was marked done");
        }
        assert!(
            !sessions.tmp_root().join(&session_id).join("f1").exists(),
            "rejected uploads must not create temp files"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn upload_stream_verify_sha256() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);

        // Success path: three chunks streamed over a capacity-1 channel; the
        // file must grow chunk-by-chunk on disk (Review Focus #2) before the
        // session terminates.
        let digest = sha256_hex(b"abcdefghi");
        let entries = [file_entry("f1", 9, Some(&digest))];
        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200, "{body}");
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token = body["files"]["f1"].as_str().expect("token").to_string();

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
        let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
        let temp_path = sessions.tmp_root().join(&session_id).join("f1");
        let handle = tokio::spawn(upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f1".into(),
            token.clone(),
            SENDER_IP,
            body,
        ));

        tx.send(Ok(Bytes::from_static(b"abc"))).await.expect("send chunk 1");
        wait_for_size(&temp_path, 3).await;
        tx.send(Ok(Bytes::from_static(b"def"))).await.expect("send chunk 2");
        wait_for_size(&temp_path, 6).await;
        tx.send(Ok(Bytes::from_static(b"ghi"))).await.expect("send chunk 3");
        wait_for_size(&temp_path, 9).await;
        drop(tx);

        let (status, body) = handle.await.expect("upload task");
        assert_eq!(status, 200, "sha256 matches: {body}");
        assert!(temp_path.is_file(), "no download dir: file stays in tmp");
        let stored = std::fs::metadata(&temp_path).expect("final file").len();
        assert_eq!(stored, 9, "every chunk reached the disk");
        assert_eq!(session_status(&sessions, &session_id), Some(TransferStatus::Done));

        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Done);
        assert_eq!(
            record.destinations["f1"],
            temp_path.to_string_lossy(),
            "destination recorded even without a download dir"
        );

        // One drain, two filters: drain() clears the queue, so both event
        // kinds must come from the same snapshot.
        let drained = events.drain();
        let done: Vec<Value> = drained
            .iter()
            .filter(|event| event["event"] == "transfer-done")
            .map(|event| event["data"].clone())
            .collect();
        assert_eq!(done.len(), 1, "exactly one transfer-done");
        assert_eq!(done[0]["sessionId"], session_id);
        assert_eq!(done[0]["status"], "done");
        let progress: Vec<Value> = drained
            .iter()
            .filter(|event| event["event"] == "transfer-progress")
            .map(|event| event["data"].clone())
            .collect();
        assert!(
            progress.iter().any(|event| event["percent"] == 100),
            "progress events streamed during the upload"
        );

        // Corruption path: a wrong expected hash fails the upload, deletes the
        // temp file and fails the whole session.
        let entries = [file_entry("f2", 9, Some(&"0".repeat(64)))];
        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200, "{body}");
        let bad_session = body["sessionId"].as_str().expect("sessionId").to_string();
        let bad_token = body["files"]["f2"].as_str().expect("token").to_string();

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            bad_session.clone(),
            "f2".into(),
            bad_token,
            SENDER_IP,
            body_from_chunks(&[b"abc", b"def", b"ghi"]),
        )
        .await;
        assert_eq!(status, 422, "checksum mismatch");
        assert!(
            !sessions.tmp_root().join(&bad_session).join("f2").exists(),
            "corrupt temp file deleted"
        );
        assert_eq!(
            session_status(&sessions, &bad_session),
            Some(TransferStatus::Failed),
            "the last (failed) file terminates the session"
        );
        let record = record_snapshot(&sessions, &bad_session);
        assert_eq!(record.status, TransferStatus::Failed);
        let done = event_data(&events, "transfer-done");
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["status"], "failed");
    }

    #[tokio::test]
    async fn cancel_clears_session_and_temp() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);
        let entries = [file_entry("f1", 10, None)];

        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token = body["files"]["f1"].as_str().expect("token").to_string();

        // Simulate a partial upload before cancelling.
        let partial = sessions.tmp_root().join(&session_id).join("f1");
        std::fs::write(&partial, b"partial").expect("write partial temp file");

        session_cancel(&sessions, &session_id).expect("cancel");
        assert!(
            !sessions.tmp_root().join(&session_id).exists(),
            "session temp dir cleared"
        );
        assert_eq!(session_status(&sessions, &session_id), None, "session removed");

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f1".into(),
            token,
            SENDER_IP,
            empty_body(),
        )
        .await;
        assert_eq!(status, 403, "uploads against a cancelled session fail");

        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Cancelled);
        let done = event_data(&events, "transfer-done");
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["sessionId"], session_id);
        assert_eq!(done[0]["status"], "cancelled");
    }

    #[tokio::test]
    async fn decline_marks_record_cancelled() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(false, None);
        let entries = [file_entry("f1", 10, None)];

        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();

        session_decline(&sessions, &session_id).expect("decline");
        assert_eq!(session_status(&sessions, &session_id), None, "session removed");
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Cancelled);
        let done = event_data(&events, "transfer-done");
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["status"], "cancelled");

        // The single slot is free again.
        let (status, _) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
    }

    #[tokio::test]
    async fn second_upload_blocked_when_done() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);

        let digest = sha256_hex(b"payload");
        let entries = [file_entry("f1", 7, Some(&digest))];
        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token = body["files"]["f1"].as_str().expect("token").to_string();

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f1".into(),
            token.clone(),
            SENDER_IP,
            body_from_chunks(&[b"payload"]),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(session_status(&sessions, &session_id), Some(TransferStatus::Done));

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id,
            "f1".into(),
            token,
            SENDER_IP,
            empty_body(),
        )
        .await;
        assert_eq!(status, 409, "replay upload against a Done session blocked");
    }

    #[tokio::test]
    async fn upload_moves_files_into_download_dir() {
        let temp = tempfile::tempdir().expect("temp dir");
        let downloads = tempfile::tempdir().expect("downloads dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);

        let digest = sha256_hex(b"payload");
        let entries = [file_entry("f1", 7, Some(&digest))];
        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token = body["files"]["f1"].as_str().expect("token").to_string();

        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            Some(downloads.path().to_path_buf()),
            session_id.clone(),
            "f1".into(),
            token,
            SENDER_IP,
            body_from_chunks(&[b"payload"]),
        )
        .await;
        assert_eq!(status, 200);
        assert!(
            !sessions.tmp_root().join(&session_id).exists(),
            "session temp dir removed after the move"
        );
        let target = downloads.path().join("f1.bin");
        assert!(target.is_file(), "file moved into the download dir");
        assert_eq!(std::fs::read(&target).expect("read moved file"), b"payload");
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.destinations["f1"], target.to_string_lossy());
    }

    #[test]
    fn transfers_persist_and_reload() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(false, None);
        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];

        let (status, body) = prepare(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        session_accept(&sessions, &session_id, None).expect("accept all");
        drop(sessions);

        assert!(temp.path().join("transfers.json").is_file());
        let reloaded =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("reload sessions");
        let records = transfer_records(&reloaded);
        assert_eq!(records.len(), 1, "history survives a restart");
        let record = record_for(&records, &session_id);
        assert_eq!(record.status, TransferStatus::Transferring);
        assert_eq!(record.files.len(), 2);
    }

    #[test]
    fn prepare_rejects_unsafe_file_ids() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, None);

        for evil in ["../evil", "sub\\dir", "..", ".", "con:stream", ""] {
            let mut files = files_map(&[file_entry("f1", 10, None)]);
            files.insert(evil.to_string(), file_entry("x", 10, None));
            let (status, body) = prepare_upload(
                &sessions,
                &config,
                sender_info(),
                files,
                None,
                SENDER_IP,
            );
            assert_eq!(status, 400, "unsafe file id {evil:?} rejected: {body}");
        }

        let inner = sessions.inner.lock().unwrap_or_else(|error| error.into_inner());
        assert!(
            inner.sessions.is_empty(),
            "no session is created from an invalid body"
        );
    }

    #[test]
    fn bogus_session_actions_fail() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");

        assert!(session_accept(&sessions, "nope", None).is_err());
        assert!(session_decline(&sessions, "nope").is_err());
        assert!(session_cancel(&sessions, "nope").is_err());
        assert!(transfer_records(&sessions).is_empty());
    }
}
