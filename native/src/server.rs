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
use crate::service::{wait_cancelled, ServiceScope};
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
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, watch, Notify};

/// A stalled receive session older than this is swept so it cannot pin the
/// single-active-session rule forever (cancelled with a `transfer-done`).
const SESSION_EXPIRY_MS: u64 = 30 * 60 * 1000;
/// Maximum failed PIN attempts per IP before requests are blocked with 429
/// (official `MAX_PIN_ATTEMPTS`, packages/core/src/http/server/common/pin.rs).
const MAX_PIN_ATTEMPTS: u32 = 3;
/// How often an upload of the same file may be started, i.e. how often a
/// sender may retry after a checksum mismatch (official `MAX_UPLOAD_ATTEMPTS`,
/// packages/core/src/http/server/v2.rs, mirrored by the sender isolate's
/// `_maxUploadAttempts = 3`).
const MAX_UPLOAD_ATTEMPTS: u32 = 3;

// ---------------------------------------------------------------------------
// Receive-session state machine
// ---------------------------------------------------------------------------

/// The user's decision on a manual (Pending) receive session.
#[derive(Debug, Clone)]
pub enum Decision {
    /// Accept — carries the tokens issued for the accepted files (an empty
    /// map means nothing was accepted: the suspended sender gets 204).
    /// Carrying the tokens removes the post-decision session lookup, so the
    /// session can be evicted the moment it turns terminal.
    Accept(HashMap<String, String>),
    /// Decline — the suspended sender receives 403 "Rejected".
    Decline,
}

/// What [`prepare_upload`] decided to do with the request.
pub enum PrepareOutcome {
    /// Answer immediately (auto-accept path, PIN failures, busy slot, ...).
    Immediate { status: u16, body: Value },
    /// Manual mode: the session was stored as Pending and the HTTP response
    /// is held until the user decides (official v2 behavior). `decision_rx`
    /// resolves the suspended request.
    AwaitDecision {
        session_id: String,
        decision_rx: oneshot::Receiver<Decision>,
    },
}

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
    pub created_at: u64,
    pub temp_dir: PathBuf,
    /// File ids whose upload completed (sha256 verified when provided).
    pub uploaded: HashSet<String>,
    /// File ids that failed (sha256 mismatch, IO error, aborted body).
    pub failed: HashSet<String>,
    /// sha256 mismatch count per fileId; from [`MAX_UPLOAD_ATTEMPTS`] the file
    /// is terminal instead of being reset for another retry.
    pub attempts: HashMap<String, u32>,
    /// Manual mode only: resolves the suspended prepare-upload handler.
    /// Taken and sent outside the inner lock (never held across `send`).
    pub decision_tx: Option<oneshot::Sender<Decision>>,
    cancel_tx: watch::Sender<bool>,
    cancel_rx: watch::Receiver<bool>,
    /// Leases cover open writers and terminal file moves, not just body reads.
    uploads: Arc<UploadActivity>,
}

#[derive(Default)]
struct UploadActivity {
    count: AtomicUsize,
    changed: Notify,
}

impl UploadActivity {
    async fn wait_idle(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.count.load(Ordering::SeqCst) == 0 {
                return;
            }
            changed.await;
        }
    }
}

/// Created under the session lock before opening a file. Cancellation cannot
/// remove its directory until this lease (including flush/close/commit) ends.
struct UploadLease {
    session: Arc<UploadActivity>,
    all: Arc<UploadActivity>,
}

impl UploadLease {
    fn new(session: Arc<UploadActivity>, all: Arc<UploadActivity>) -> Self {
        session.count.fetch_add(1, Ordering::SeqCst);
        all.count.fetch_add(1, Ordering::SeqCst);
        Self { session, all }
    }
}

impl Drop for UploadLease {
    fn drop(&mut self) {
        for activity in [&self.session, &self.all] {
            activity.count.fetch_sub(1, Ordering::SeqCst);
            activity.changed.notify_waiters();
        }
    }
}

#[derive(Clone)]
struct CancelCleanup {
    temp_dir: PathBuf,
    keep: HashSet<String>,
    uploads: Arc<UploadActivity>,
}

fn clean_cancelled_files(plan: &CancelCleanup) -> io::Result<()> {
    if plan.keep.is_empty() {
        return match std::fs::remove_dir_all(&plan.temp_dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        };
    }
    // Never delete verified files, even when other files of the same session
    // were cancelled. A whole-tmp sweep would also erase earlier Done sessions.
    let entries = match std::fs::read_dir(&plan.temp_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        if !plan
            .keep
            .contains(&entry.file_name().to_string_lossy().into_owned())
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

struct Inner {
    sessions: HashMap<String, ReceiveSession>,
    records: Vec<TransferRecord>,
    /// Coalescing state for `transfer-progress` per (sessionId, fileId).
    progress: HashMap<(String, String), (u32, Value, Instant)>,
    /// Failed PIN attempts per source IP (official `pin_attempts`).
    pin_failures: HashMap<IpAddr, (u32, Instant)>,
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
    scope: RwLock<Option<Arc<ServiceScope>>>,
    uploads: Arc<UploadActivity>,
    cleanups: Mutex<Vec<tokio::task::JoinHandle<Result<(), String>>>>,
    retry_cleanups: Arc<Mutex<HashMap<PathBuf, CancelCleanup>>>,
}

/// A timeout drops the waiting future, not task ownership. Put unjoined
/// cleanups back so a retry/unload can still wait for every filesystem task.
struct CleanupBatch<'a> {
    owner: &'a Mutex<Vec<tokio::task::JoinHandle<Result<(), String>>>>,
    tasks: Vec<tokio::task::JoinHandle<Result<(), String>>>,
}

impl Drop for CleanupBatch<'_> {
    fn drop(&mut self) {
        self.owner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .append(&mut self.tasks);
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TransfersFile {
    transfers: Vec<TransferRecord>,
}

impl ReceiveSessions {
    /// Create the store for `data_dir`, loading transfers.json history.
    /// A missing or unreadable history file starts with an empty list.
    /// Residual non-terminal records (a restart happened mid-transfer) are
    /// marked Failed — the historical truth — and the correction is persisted.
    pub fn new(data_dir: &Path, events: Arc<WebEventBroadcaster>) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|error| format!("create data dir {}: {error}", data_dir.display()))?;
        let transfers_path = data_dir.join("transfers.json");
        let mut records = match std::fs::read(&transfers_path) {
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
        let mut residual_failed = false;
        for record in &mut records {
            if !record.status.is_terminal() {
                record.status = TransferStatus::Failed;
                residual_failed = true;
            }
        }
        if residual_failed {
            persist_records(&records, &transfers_path);
        }
        Ok(Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                records,
                progress: HashMap::new(),
                pin_failures: HashMap::new(),
            }),
            tmp_root: data_dir.join("tmp"),
            transfers_path,
            events,
            scope: RwLock::new(None),
            uploads: Arc::new(UploadActivity::default()),
            cleanups: Mutex::new(Vec::new()),
            retry_cleanups: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Root of the per-session temp directories: `<data_dir>/tmp/<sessionId>`.
    pub fn tmp_root(&self) -> &Path {
        &self.tmp_root
    }

    fn has_active(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner
            .sessions
            .values()
            .any(|session| !session.status.is_terminal())
    }

    pub(crate) fn set_scope(&self, scope: Arc<ServiceScope>) {
        *self
            .scope
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(scope);
    }

    fn scope(&self) -> Option<Arc<ServiceScope>> {
        self.scope
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Live sessions only; historical Pending records loaded after a crash are
    /// not jobs and are never used to decide whether stop needs confirmation.
    pub(crate) fn active_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sessions
            .values()
            .filter(|session| !session.status.is_terminal())
            .count()
    }

    pub(crate) fn cancel_all(&self) {
        let ids: Vec<String> = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sessions
            .values()
            .filter(|session| !session.status.is_terminal())
            .map(|session| session.session_id.clone())
            .collect();
        for id in ids {
            let _ = self.cancel_session(&id);
        }
    }

    pub(crate) fn writers_idle(&self) -> bool {
        self.uploads.count.load(Ordering::SeqCst) == 0
    }

    /// Wait outside every mutex. A writer's lease ends only after its file is
    /// closed and its terminal move is complete, then cancelled dirs can go.
    pub(crate) async fn drain(&self) -> Result<(), String> {
        self.uploads.wait_idle().await;
        loop {
            let tasks = std::mem::take(
                &mut *self
                    .cleanups
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
            );
            if tasks.is_empty() {
                let plans: Vec<CancelCleanup> = self
                    .retry_cleanups
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .values()
                    .cloned()
                    .collect();
                for plan in plans {
                    clean_cancelled_files(&plan)
                        .map_err(|error| format!("clean cancelled session: {error}"))?;
                    self.retry_cleanups
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .remove(&plan.temp_dir);
                }
                return Ok(());
            }
            let mut batch = CleanupBatch {
                owner: &self.cleanups,
                tasks,
            };
            while let Some(task) = batch.tasks.last_mut() {
                let result = task
                    .await
                    .map_err(|error| format!("receive cleanup task: {error}"));
                batch.tasks.pop();
                result??;
            }
        }
    }

    /// Cancel every non-terminal session older than [`SESSION_EXPIRY_MS`].
    /// Called from prepare-upload so a dead transfer cannot hold the
    /// single-active-session rule forever. A stale Pending session resolves its
    /// suspended sender with 403 (Decline path) instead of hanging forever.
    ///
    /// Also reaps sessions that cannot make progress anymore, so a new
    /// prepare is never answered 409 because of them:
    /// - terminal sessions (Done/Failed/Cancelled) are evicted — official
    ///   drops the slot on completion; the TransferRecord keeps the history;
    /// - a Pending session whose decision sender is closed (the suspended
    ///   prepare-upload handler was dropped — the sender vanished without a
    ///   decision) is aborted like the official PendingSessionGuard.
    fn sweep_expired(&self) {
        let now = now_ms();
        let expired: Vec<String> = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner
                .pin_failures
                .retain(|_, (_, last)| last.elapsed() < Duration::from_millis(SESSION_EXPIRY_MS));
            inner
                .sessions
                .values()
                .filter(|session| {
                    !session.status.is_terminal()
                        && (now.saturating_sub(session.created_at) >= SESSION_EXPIRY_MS
                            || (session.status == TransferStatus::Pending
                                && session
                                    .decision_tx
                                    .as_ref()
                                    .is_some_and(|tx| tx.is_closed())))
                })
                .map(|session| session.session_id.clone())
                .collect()
        };
        for id in expired {
            self.abort_session(&id);
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
        let (cleanup, decision_tx) = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let Some(mut session) = inner.sessions.remove(session_id) else {
                return Err(format!("session not found: {session_id}"));
            };
            let _ = session.cancel_tx.send(true);
            let destinations = session
                .uploaded
                .iter()
                .map(|id| {
                    (
                        id.clone(),
                        session.temp_dir.join(id).to_string_lossy().into_owned(),
                    )
                })
                .collect();
            inner.progress.retain(|(id, _), _| id != session_id);
            self.update_record(
                &mut inner,
                session_id,
                TransferStatus::Cancelled,
                Some(destinations),
            );
            (
                CancelCleanup {
                    temp_dir: session.temp_dir,
                    keep: session.uploaded,
                    uploads: session.uploads,
                },
                session.decision_tx.take(),
            )
        };
        if let Some(decision_tx) = decision_tx {
            let _ = decision_tx.send(Decision::Decline);
        }
        self.events.send(
            "transfer-done",
            json!({ "sessionId": session_id, "status": "cancelled" }),
        );
        if cleanup.uploads.count.load(Ordering::SeqCst) == 0 {
            if let Err(error) = clean_cancelled_files(&cleanup) {
                self.retry_cleanups
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(cleanup.temp_dir.clone(), cleanup);
                return Err(format!("clean cancelled session: {error}"));
            }
        } else {
            // The writer will wake on its sticky cancel, flush/close, and drop
            // its lease. Never unlink a directory while it is still writable.
            let retries = Arc::clone(&self.retry_cleanups);
            let task = tokio::spawn(async move {
                cleanup.uploads.wait_idle().await;
                if let Err(error) = clean_cancelled_files(&cleanup) {
                    retries
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .insert(cleanup.temp_dir.clone(), cleanup);
                    return Err(format!("clean cancelled session: {error}"));
                }
                Ok(())
            });
            self.cleanups
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(task);
        }
        Ok(())
    }

    /// Official `/cancel` without a sessionId: the sender does not know the
    /// session id yet (it is part of the pending response), so a cancel from
    /// the pending sender's address resolves that session as a decline.
    pub fn decline_pending_from(&self, ip: IpAddr) {
        let session_id = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner
                .sessions
                .values()
                .find(|session| {
                    session.status == TransferStatus::Pending && session.sender_ip == ip
                })
                .map(|session| session.session_id.clone())
        };
        if let Some(session_id) = session_id {
            let _ = self.cancel_session(&session_id);
        }
    }

    /// Sender-disconnect cleanup (official PendingSessionGuard): remove the
    /// session, record it Cancelled and free the single-session slot.
    fn abort_session(&self, session_id: &str) {
        let _ = self.cancel_session(session_id);
    }

    /// Issue tokens for the requested files of a Pending session, move it to
    /// Transferring and resolve the suspended prepare-upload sender with the
    /// Accept decision. `None` accepts every file; unknown ids are skipped.
    /// Returns the sorted accepted file ids (empty → the sender gets 204,
    /// nothing to transfer, and the terminal session is evicted at once).
    pub fn session_accept(
        &self,
        session_id: &str,
        file_ids: Option<Vec<String>>,
    ) -> Result<Vec<String>, String> {
        let scope = self.scope();
        let _admission = match &scope {
            Some(scope) => Some(scope.admit()?),
            None => None,
        };
        let (accepted, tokens, decision_tx, finished_empty) = {
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
                Some(ids) => ids
                    .into_iter()
                    .filter(|id| session.files.contains_key(id))
                    .collect(),
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
            accepted.sort();
            let decision_tx = session.decision_tx.take();
            let tokens = session.tokens.clone();
            let finished_empty = accepted.is_empty();
            let status = if finished_empty {
                // Nothing accepted: the suspended sender gets 204 (official
                // "Nothing to transfer") and the session is finished.
                TransferStatus::Done
            } else {
                TransferStatus::Transferring
            };
            if finished_empty {
                // Terminal: evict immediately (official drops the slot on
                // completion); the decision below still carries the (empty)
                // token map that turns into the 204 response.
                inner.sessions.remove(session_id);
            } else {
                session.status = status;
            }
            self.update_record(&mut inner, session_id, status, None);
            (accepted, tokens, decision_tx, finished_empty)
        };
        if finished_empty {
            self.events.send(
                "transfer-done",
                json!({ "sessionId": session_id, "status": "done" }),
            );
        }
        if let Some(decision_tx) = decision_tx {
            // Send OUTSIDE the inner lock. A failure means the sender
            // disconnected while the decision was pending (the suspended
            // handler was dropped): clean up like the official
            // PendingSessionGuard and report the abort.
            if decision_tx.send(Decision::Accept(tokens)).is_err() {
                self.abort_session(session_id);
                return Err(format!("sender disconnected before decision: {session_id}"));
            }
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
        persist_records(&inner.records, &self.transfers_path);
    }

    fn patch_record_destinations(&self, session_id: &str, destinations: HashMap<String, String>) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        self.update_record(
            &mut inner,
            session_id,
            TransferStatus::Done,
            Some(destinations),
        );
    }

    /// Snapshot of the persisted history for `transfer_list`.
    pub fn transfer_records(&self) -> Vec<TransferRecord> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.records.clone()
    }

    /// Insert or refresh the history record of an outbound (Send) session.
    /// The sender calls this at job start (Pending, entries as offered);
    /// persists to transfers.json like every other record change.
    pub fn upsert_send_record(&self, record: TransferRecord) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        match inner
            .records
            .iter_mut()
            .find(|existing| existing.session_id == record.session_id)
        {
            Some(existing) => {
                existing.peer_alias = record.peer_alias;
                existing.files = record.files;
                existing.status = record.status;
            }
            None => inner.records.push(record),
        }
        persist_records(&inner.records, &self.transfers_path);
    }

    /// Move an outbound record to a new status, optionally replacing its
    /// file entries (e.g. once the streamed checksums have been computed).
    pub fn set_send_record(
        &self,
        session_id: &str,
        status: TransferStatus,
        files: Option<Vec<FileEntry>>,
    ) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(record) = inner
            .records
            .iter_mut()
            .find(|record| record.session_id == session_id)
        {
            record.status = status;
            if let Some(files) = files {
                record.files = files;
            }
            persist_records(&inner.records, &self.transfers_path);
        }
    }
}

/// History snapshot for the runtime `transfer_list` method.
pub fn transfer_records(sessions: &ReceiveSessions) -> Vec<TransferRecord> {
    sessions.transfer_records()
}

/// Write the whole history to transfers.json (best effort).
fn persist_records(records: &[TransferRecord], path: &Path) {
    let payload = json!({ "transfers": records });
    match serde_json::to_vec_pretty(&payload) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(path, bytes) {
                eprintln!("otools-localsend server: persist transfers: {error}");
            }
        }
        Err(error) => eprintln!("otools-localsend server: serialize transfers: {error}"),
    }
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
    match Path::new(cleaned.trim())
        .file_name()
        .and_then(|name| name.to_str())
    {
        Some(name) if !name.is_empty() && name != "." && name != ".." => name.to_string(),
        _ => format!("file-{}", entry.id),
    }
}

/// PIN validation result (official `check_pin` semantics).
enum PinCheck {
    Ok,
    /// Wrong PIN — 401, counts against the per-IP budget.
    Wrong,
    /// PIN required — 401, does NOT count against the budget (official).
    Missing,
    /// Per-IP budget exhausted — 429, checked before correctness (official).
    TooMany,
}

/// Outcome of the PIN check for one prepare-upload request.
fn check_pin_attempt(
    sessions: &ReceiveSessions,
    remote_ip: IpAddr,
    provided: Option<&str>,
    expected: &str,
) -> PinCheck {
    let mut inner = sessions
        .inner
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let count = inner
        .pin_failures
        .get(&remote_ip)
        .copied()
        .unwrap_or((0, Instant::now()))
        .0;
    if count >= MAX_PIN_ATTEMPTS {
        return PinCheck::TooMany;
    }
    match provided {
        Some(pin) if constant_time_eq(pin, expected) => {
            inner.pin_failures.remove(&remote_ip);
            PinCheck::Ok
        }
        Some(_) => {
            inner
                .pin_failures
                .insert(remote_ip, (count + 1, Instant::now()));
            PinCheck::Wrong
        }
        None => PinCheck::Missing,
    }
}

/// The prepare-upload state machine (v2 `POST /prepare-upload`).
///
/// Immediate outcomes:
/// - `400` — empty files map ("No files provided") or an unsafe file id;
/// - `401` — a PIN is set and missing ("PIN required") or wrong ("Invalid
///   PIN", counts against the per-IP budget);
/// - `429` — the per-IP PIN budget is exhausted ("Too many requests");
/// - `409` — another non-terminal receive session is active;
/// - `200` — auto-save: `{sessionId, files: {fileId: token}}` for every file
///   (session Transferring).
///
/// Manual mode suspends instead ([`PrepareOutcome::AwaitDecision`]): the
/// session is stored Pending and the HTTP response is held until the user
/// decides (official v2 behavior). On Accept the suspended sender receives
/// `{sessionId, files: {acceptedId: token}}` (204 when nothing was accepted);
/// on Decline 403 "Rejected". A disconnected sender frees the session at the
/// next decision (`tx.send` fails → abort, official PendingSessionGuard).
pub fn prepare_upload(
    sessions: &ReceiveSessions,
    settings: &Settings,
    sender: DeviceInfo,
    files: HashMap<String, FileEntry>,
    pin: Option<String>,
    remote_ip: IpAddr,
) -> PrepareOutcome {
    let scope = sessions.scope();
    let _admission = match &scope {
        Some(scope) => match scope.admit() {
            Ok(gate) => Some(gate),
            Err(_) => {
                return PrepareOutcome::Immediate {
                    status: 503,
                    body: json!({ "error": "LocalSend service is not running" }),
                }
            }
        },
        None => None,
    };
    sessions.sweep_expired();
    // Official order: the PIN is validated before the body is even parsed,
    // so a wrong PIN beats an empty files map.
    if let Some(expected) = &settings.pin {
        match check_pin_attempt(sessions, remote_ip, pin.as_deref(), expected) {
            PinCheck::Ok => {}
            PinCheck::Wrong => {
                return PrepareOutcome::Immediate {
                    status: 401,
                    body: json!({ "error": "Invalid PIN" }),
                };
            }
            PinCheck::Missing => {
                return PrepareOutcome::Immediate {
                    status: 401,
                    body: json!({ "error": "PIN required" }),
                };
            }
            PinCheck::TooMany => {
                return PrepareOutcome::Immediate {
                    status: 429,
                    body: json!({ "error": "Too many requests" }),
                };
            }
        }
    }
    if files.is_empty() {
        return PrepareOutcome::Immediate {
            status: 400,
            body: json!({ "error": "No files provided" }),
        };
    }
    if files.keys().any(|id| !is_safe_file_id(id)) {
        return PrepareOutcome::Immediate {
            status: 400,
            body: json!({ "error": "Invalid body" }),
        };
    }
    if sessions.has_active() {
        return PrepareOutcome::Immediate {
            status: 409,
            body: json!({ "error": "Blocked by another session" }),
        };
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (status, tokens, session_tx, decision_rx) = if settings.auto_save {
        let tokens: HashMap<String, String> = files
            .keys()
            .map(|id| (id.clone(), uuid::Uuid::new_v4().to_string()))
            .collect();
        (TransferStatus::Transferring, tokens, None, None)
    } else {
        let (decision_tx, decision_rx) = oneshot::channel();
        (
            TransferStatus::Pending,
            HashMap::new(),
            Some(decision_tx),
            Some(decision_rx),
        )
    };
    let temp_dir = sessions.tmp_root.join(&session_id);
    if let Err(error) = std::fs::create_dir_all(&temp_dir) {
        return PrepareOutcome::Immediate {
            status: 500,
            body: json!({ "error": format!("create temp dir: {error}") }),
        };
    }
    let mut files_list: Vec<FileEntry> = files.values().cloned().collect();
    files_list.sort_by(|a, b| a.id.cmp(&b.id));
    let created_at = now_ms();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let session = ReceiveSession {
        session_id: session_id.clone(),
        sender: sender.clone(),
        files,
        tokens,
        status,
        sender_ip: remote_ip,
        created_at,
        temp_dir,
        uploaded: HashSet::new(),
        failed: HashSet::new(),
        attempts: HashMap::new(),
        decision_tx: session_tx,
        cancel_tx,
        cancel_rx,
        uploads: Arc::new(UploadActivity::default()),
    };

    {
        let mut inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Two concurrent prepares raced past the pre-check; only one may win.
        if inner
            .sessions
            .values()
            .any(|session| !session.status.is_terminal())
        {
            let _ = std::fs::remove_dir_all(&session.temp_dir);
            return PrepareOutcome::Immediate {
                status: 409,
                body: json!({ "error": "Blocked by another session" }),
            };
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

    // Only manual-confirm sessions surface an incoming request (Task 7):
    // auto-save sessions were answered 200 above and are already Transferring
    // — there is nothing for the user to decide.
    if status == TransferStatus::Pending {
        sessions.events.send(
            "incoming-request",
            json!({
                "sessionId": session_id,
                "sender": sender,
                "files": files_list,
            }),
        );
    }

    match decision_rx {
        None => {
            let tokens = {
                let inner = sessions
                    .inner
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                inner
                    .sessions
                    .get(&session_id)
                    .map(|session| session.tokens.clone())
                    .unwrap_or_default()
            };
            PrepareOutcome::Immediate {
                status: 200,
                body: json!({ "sessionId": session_id, "files": tokens }),
            }
        }
        Some(decision_rx) => PrepareOutcome::AwaitDecision {
            session_id,
            decision_rx,
        },
    }
}

/// Resolve a suspended manual prepare-upload (official v2 behavior).
///
/// Accept → the sender receives `{sessionId, files}` with the tokens carried
/// by the decision ([`session_accept`] gathered them under the session lock;
/// 204 "nothing to transfer" when the accepted set is empty); Decline →
/// 403 "Rejected". No timeout: the official server has none either — a stuck
/// sender is freed by its own client timeout, after which the session is
/// aborted (`tx.send` fails) or reaped by the next prepare-upload.
pub async fn await_user_decision(
    _sessions: Arc<ReceiveSessions>,
    session_id: String,
    decision_rx: oneshot::Receiver<Decision>,
) -> (u16, Value) {
    match decision_rx.await {
        Ok(Decision::Accept(tokens)) if !tokens.is_empty() => {
            (200, json!({ "sessionId": session_id, "files": tokens }))
        }
        Ok(Decision::Accept(_)) => (204, Value::Null),
        Ok(Decision::Decline) => (403, json!({ "error": "Rejected" })),
        // The decision channel closed without a decision (runtime shutdown).
        Err(_) => (403, json!({ "error": "Rejected" })),
    }
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
            if *session.cancel_rx.borrow() || session.status.is_terminal() {
                return None;
            }
            if ok {
                session.uploaded.insert(file_id.to_string());
            } else {
                session.failed.insert(file_id.to_string());
            }
            // Only accepted (tokenized) files participate in the session
            // lifecycle — the rest were skipped by a partial accept (official
            // keeps only the accepted files in the session). When every
            // accepted file is terminal the session is over.
            let all_terminal = session
                .files
                .keys()
                .filter(|id| session.tokens.contains_key(*id))
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
            let plan = TerminalPlan {
                session_id: session_id.to_string(),
                status,
                moves,
                destinations,
                temp_dir: session.temp_dir.clone(),
            };
            // Terminal: evict immediately (official drops the slot on
            // completion). The plan carries everything the caller performs
            // IO with; without a download dir the received files stay in tmp
            // and remain the recorded destinations, so the dir is NOT
            // removed here.
            inner.sessions.remove(session_id);
            plan
        };
        inner.progress.retain(|(id, _), _| id != session_id);
        self.update_record(
            &mut inner,
            session_id,
            plan.status,
            Some(plan.destinations.clone()),
        );
        Some(plan)
    }
}

impl ReceiveSessions {
    /// Count one sha256 mismatch against the file's retry budget
    /// ([`MAX_UPLOAD_ATTEMPTS`], official `_maxUploadAttempts`). While the
    /// budget lasts the file stays retransmittable with the same token
    /// (official resets it to Pending); once exhausted it is terminal.
    fn register_mismatch(&self, session_id: &str, file_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(session) = inner.sessions.get_mut(session_id) else {
            return false;
        };
        let attempts = session.attempts.entry(file_id.to_string()).or_insert(0);
        *attempts += 1;
        *attempts >= MAX_UPLOAD_ATTEMPTS
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
        let mut inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if inner
            .sessions
            .get(session_id)
            .is_none_or(|session| *session.cancel_rx.borrow())
        {
            return;
        }
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
    let scope = sessions.scope();
    // The per-session watch also covers ordinary UI /cancel. The service
    // watch closes the generation even before the cancellation list is taken.
    let mut service_cancel = scope.as_ref().map(|scope| scope.subscribe());
    let (temp_path, temp_dir, expected_size, mut cancel, _lease) = {
        let _admission = match &scope {
            Some(scope) => match scope.admit() {
                Ok(gate) => Some(gate),
                Err(_) => return (503, json!({ "error": "LocalSend service is not running" })),
            },
            None => None,
        };
        let inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
        (
            session.temp_dir.join(&file_id),
            session.temp_dir.clone(),
            entry.size,
            session.cancel_rx.clone(),
            UploadLease::new(Arc::clone(&session.uploads), Arc::clone(&sessions.uploads)),
        )
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
    let mut cancelled = false;
    loop {
        let frame = tokio::select! {
            biased;
            _ = wait_cancelled(&mut cancel) => { cancelled = true; break; }
            _ = async {
                match &mut service_cancel {
                    Some(cancel) => wait_cancelled(cancel).await,
                    None => std::future::pending::<()>().await,
                }
            } => { cancelled = true; break; }
            frame = body.frame() => match frame {
                Some(frame) => frame,
                None => break,
            },
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
    if cancelled || *cancel.borrow() || scope.as_ref().is_some_and(|scope| scope.is_cancelled()) {
        // Flush above closes any Tokio blocking write before the cancellation
        // cleanup can unlink the partial file/directory after our lease drops.
        let _ = sessions.session_cancel(&session_id);
        drop(body);
        return (409, json!({ "error": "Blocked by another session" }));
    }

    // Phase 3 — verify and finalize.
    if let Some(error) = write_error {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let plan =
            sessions.mark_file_terminal(&session_id, &file_id, false, download_dir.as_deref());
        if let Some(plan) = plan {
            execute_terminal_plan(Arc::clone(&sessions), plan).await;
        }
        return (500, json!({ "error": error }));
    }
    if body_error {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let plan =
            sessions.mark_file_terminal(&session_id, &file_id, false, download_dir.as_deref());
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
    // None can mean "no checksum promised for this file" (verify is skipped)
    // OR "the session vanished mid-stream" (cancelled by UI/sender) — the two
    // cases must be told apart before comparing.
    let session_gone;
    let expected_sha = {
        let inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match inner.sessions.get(&session_id) {
            None => {
                session_gone = true;
                None
            }
            Some(session) => {
                session_gone = false;
                session
                    .files
                    .get(&file_id)
                    .and_then(|entry| entry.sha256.clone())
            }
        }
    };
    if session_gone {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return (409, json!({ "error": "Blocked by another session" }));
    }
    let checksum_ok = match &expected_sha {
        Some(expected) => expected.eq_ignore_ascii_case(&digest),
        None => true, // no checksum promised for this file
    };
    if !checksum_ok {
        let _ = tokio::fs::remove_file(&temp_path).await;
        // Official semantics: the mismatched file is NOT terminal while its
        // retry budget lasts — the sender re-uploads it with the same token
        // (attempt 3 = the last one, official MAX_UPLOAD_ATTEMPTS).
        let exhausted = sessions.register_mismatch(&session_id, &file_id);
        if exhausted {
            let plan =
                sessions.mark_file_terminal(&session_id, &file_id, false, download_dir.as_deref());
            if let Some(plan) = plan {
                execute_terminal_plan(Arc::clone(&sessions), plan).await;
            }
        }
        return (422, json!({ "error": "Checksum mismatch" }));
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
    pub(crate) scope: Option<Arc<ServiceScope>>,
}

impl ServerShared {
    pub(crate) fn in_service(
        sessions: Arc<ReceiveSessions>,
        settings: Arc<RwLock<Settings>>,
        cert: CertMaterial,
        discovery: Arc<DiscoveryShared>,
        scope: Arc<ServiceScope>,
    ) -> Self {
        Self {
            sessions,
            settings,
            broadcaster: Arc::clone(&discovery.event),
            data_dir: PathBuf::new(),
            cert,
            server_port: AtomicU16::new(0),
            bind_error: Mutex::new(None),
            discovery: Some(discovery),
            scope: Some(scope),
        }
    }
}

/// Wrap the TLS accept phase too: axum's Handle only observes cancellation
/// after acceptor.accept completes, so a peer stalled in its handshake must
/// not leave a detached connection task behind on stop/unload.
#[derive(Clone)]
struct CancellableAccept<A> {
    inner: A,
    cancel: watch::Receiver<bool>,
}

impl<A, I, S> axum_server::accept::Accept<I, S> for CancellableAccept<A>
where
    A: axum_server::accept::Accept<I, S>,
    A::Future: Send + 'static,
    A::Stream: Send + 'static,
    A::Service: Send + 'static,
{
    type Stream = A::Stream;
    type Service = A::Service;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = io::Result<(Self::Stream, Self::Service)>> + Send>,
    >;

    fn accept(&self, stream: I, service: S) -> Self::Future {
        let accept = self.inner.accept(stream, service);
        let mut cancel = self.cancel.clone();
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = wait_cancelled(&mut cancel) => Err(io::Error::new(io::ErrorKind::Interrupted, "LocalSend service stopped")),
                result = accept => result,
            }
        })
    }
}

pub(crate) async fn serve_bound(
    state: Arc<ServerShared>,
    listener: std::net::TcpListener,
    config: axum_server::tls_rustls::RustlsConfig,
    handle: axum_server::Handle,
    cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    axum_server::from_tcp_rustls(listener, config)
        .map(|acceptor| CancellableAccept {
            inner: acceptor,
            cancel,
        })
        .handle(handle)
        .serve(build_router(state).into_make_service_with_connect_info::<SocketAddr>())
        .await
        .map_err(|error| format!("HTTPS server: {error}"))
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
        .route(
            "/api/localsend/v2/prepare-upload",
            post(prepare_upload_handler),
        )
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
    if state
        .scope
        .as_ref()
        .is_some_and(|scope| scope.is_cancelled())
    {
        return json_response(503, json!({ "error": "LocalSend service is not running" }));
    }
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
    match prepare_upload(
        &state.sessions,
        &settings,
        body.info,
        files,
        query.pin,
        addr.ip(),
    ) {
        PrepareOutcome::Immediate { status, body } => json_response(status, body),
        PrepareOutcome::AwaitDecision {
            session_id,
            decision_rx,
        } => {
            // Manual mode: the response is held until the user decides. If
            // the sender disconnects, hyper drops this future — the next
            // decision (accept/decline/sweep) detects the dead channel and
            // aborts the session (official PendingSessionGuard).
            let (status, value) =
                await_user_decision(Arc::clone(&state.sessions), session_id, decision_rx).await;
            json_response(status, value)
        }
    }
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
/// answers 200 with an empty body (v2 semantics). Without a sessionId, a
/// cancel from the pending sender's address declines that session (official:
/// the sender does not know the session id yet — it is part of the pending
/// response).
async fn cancel_handler(
    State(state): State<Arc<ServerShared>>,
    Query(query): Query<CancelQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    match query.session_id.filter(|id| !id.is_empty()) {
        Some(session_id) => {
            let _ = session_cancel(&state.sessions, &session_id);
        }
        None => {
            state.sessions.decline_pending_from(addr.ip());
        }
    }
    StatusCode::OK.into_response()
}

/// Bind TCP on `0.0.0.0:port` with the discovery-style fallback window
/// (`port..=port + PORT_FALLBACK_ATTEMPTS`). TCP and UDP discovery ports are
/// independent; each may fall back separately.
pub(crate) fn bind_https_listener(port: u16) -> io::Result<(std::net::TcpListener, u16)> {
    let mut last_error = None;
    for candidate in port..=port.saturating_add(discovery::PORT_FALLBACK_ATTEMPTS) {
        match std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, candidate)) {
            Ok(listener) => {
                let actual = listener.local_addr()?.port();
                return Ok((listener, actual));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::AddrNotAvailable, "no HTTPS port candidate")
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        await_user_decision, prepare_upload, session_accept, session_cancel, session_decline,
        transfer_records, upload_stream, Decision, PrepareOutcome, ReceiveSessions,
    };
    use crate::crypto::sha256_hex;
    use crate::event_bridge::WebEventBroadcaster;
    use crate::models::{DeviceInfo, Direction, FileEntry, TransferRecord, TransferStatus};
    use crate::settings::Settings;
    use axum::body::{Body, Bytes};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::net::{IpAddr, Ipv4Addr};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::oneshot;

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

    /// Run prepare_upload expecting an immediate answer (auto-save path and
    /// all error paths).
    fn prepare_now(
        sessions: &ReceiveSessions,
        settings: &Settings,
        entries: &[FileEntry],
        pin: Option<&str>,
        ip: IpAddr,
    ) -> (u16, Value) {
        match prepare_upload(
            sessions,
            settings,
            sender_info(),
            files_map(entries),
            pin.map(str::to_string),
            ip,
        ) {
            PrepareOutcome::Immediate { status, body } => (status, body),
            PrepareOutcome::AwaitDecision { .. } => {
                panic!("expected an immediate prepare outcome")
            }
        }
    }

    /// Run prepare_upload in manual mode expecting the request to suspend.
    /// Returns the session id plus the decision receiver; drop the receiver
    /// to simulate a sender disconnect (the suspended handler future died).
    fn prepare_manual(
        sessions: &ReceiveSessions,
        entries: &[FileEntry],
        ip: IpAddr,
    ) -> (String, oneshot::Receiver<Decision>) {
        match prepare_upload(
            sessions,
            &settings(false, None),
            sender_info(),
            files_map(entries),
            None,
            ip,
        ) {
            PrepareOutcome::AwaitDecision {
                session_id,
                decision_rx,
            } => (session_id, decision_rx),
            PrepareOutcome::Immediate { status, body } => {
                panic!("expected a suspended prepare, got {status} {body}")
            }
        }
    }

    /// Drive a suspended prepare to completion on a background task.
    fn spawn_waiter(
        sessions: &Arc<ReceiveSessions>,
        session_id: String,
        decision_rx: oneshot::Receiver<Decision>,
    ) -> tokio::task::JoinHandle<(u16, Value)> {
        let sessions = Arc::clone(sessions);
        tokio::spawn(await_user_decision(sessions, session_id, decision_rx))
    }

    fn session_status(sessions: &ReceiveSessions, session_id: &str) -> Option<TransferStatus> {
        let inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        inner.sessions.get(session_id).map(|session| session.status)
    }

    fn record_for<'a>(records: &'a [TransferRecord], session_id: &str) -> &'a TransferRecord {
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
    fn server_status_events_are_complete_snapshots() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        Settings {
            port: 0,
            ..Default::default()
        }
        .save(temp.path())
        .expect("settings");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .expect("runtime");
        let controller = Arc::new(crate::service::ServiceController::new(
            runtime.handle().clone(),
            temp.path().to_path_buf(),
            Arc::new(std::sync::RwLock::new(Settings::default())),
            sessions,
            Arc::clone(&events),
        ));
        controller.start().expect("start");
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while controller.status().state != crate::service::ServiceState::Running {
            assert!(
                std::time::Instant::now() < deadline,
                "startup must reach running"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        runtime.block_on(controller.shutdown());
        let snapshots: Vec<Value> = events
            .drain()
            .into_iter()
            .filter(|event| event["event"] == "server-status")
            .map(|event| event["data"].clone())
            .collect();
        assert!(snapshots.iter().any(|status| status["state"] == "running"));
        assert_eq!(snapshots.last().expect("stopped event")["state"], "stopped");
        for status in snapshots {
            let mut keys: Vec<&str> = status
                .as_object()
                .expect("snapshot object")
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                vec![
                    "activeTransfers",
                    "error",
                    "fingerprint",
                    "port",
                    "protocol",
                    "revision",
                    "state",
                    "udpPort"
                ]
            );
            assert_eq!(status["protocol"], "https");
            assert!(status["revision"]
                .as_u64()
                .is_some_and(|revision| revision > 0));
            assert_eq!(status["activeTransfers"], 0);
            assert!(status["error"].is_null());
        }
    }

    #[test]
    fn prepare_upload_issues_tokens() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, None);

        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];
        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);

        assert_eq!(status, 200, "auto-accept prepare must succeed: {body}");
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token1 = body["files"]["f1"].as_str().expect("f1 token").to_string();
        let token2 = body["files"]["f2"].as_str().expect("f2 token").to_string();
        assert!(
            !token1.is_empty() && !token2.is_empty(),
            "tokens are issued"
        );
        assert_ne!(token1, token2, "tokens are unique per file");

        {
            let inner = sessions
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let session = inner.sessions.get(&session_id).expect("session stored");
            assert_eq!(session.status, TransferStatus::Transferring);
            assert_eq!(session.tokens["f1"], token1);
            assert_eq!(session.tokens["f2"], token2);
            assert_eq!(session.sender.alias, "Mock Sender");
            assert_eq!(session.sender_ip, SENDER_IP);
        }
        assert!(
            sessions.tmp_root().join(&session_id).is_dir(),
            "per-session temp dir prepared"
        );

        // Auto-save answered 200 directly — the session is already
        // Transferring, so no confirm request may be raised (Task 7: only
        // manual Pending sessions emit incoming-request).
        let incoming = event_data(&events, "incoming-request");
        assert!(
            incoming.is_empty(),
            "auto-save prepare must not emit incoming-request: {incoming:?}"
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
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, Some("123456"));
        let entries = [file_entry("f1", 10, None)];

        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 401, "missing pin: {body}");
        assert_eq!(body["error"], "PIN required", "official message");
        let (status, body) = prepare_now(&sessions, &config, &entries, Some("000000"), SENDER_IP);
        assert_eq!(status, 401, "wrong pin");
        assert_eq!(body["error"], "Invalid PIN", "official message");
        let (status, body) = prepare_now(&sessions, &config, &entries, Some("123456"), SENDER_IP);
        assert_eq!(status, 200, "correct pin passes: {body}");

        // The failed attempts must not have occupied the single-session slot.
        let (status, _) = prepare_now(&sessions, &config, &entries, Some("123456"), SENDER_IP);
        assert_eq!(status, 409, "the accepted session now blocks a second one");

        let incoming = event_data(&events, "incoming-request");
        assert!(
            incoming.is_empty(),
            "neither rejected PIN attempts nor the auto-save accept may emit incoming-request: {incoming:?}"
        );
    }

    #[test]
    fn prepare_upload_rejects_second_session() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, None);
        let entries = [file_entry("f1", 10, None)];

        let (status, first) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200);
        let first_id = first["sessionId"].as_str().expect("sessionId").to_string();

        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 409, "second active session blocked: {body}");

        session_cancel(&sessions, &first_id).expect("cancel the first session");
        let (status, _) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200, "a terminal session frees the single slot");
    }

    #[tokio::test]
    async fn prepare_upload_pending_when_manual() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];

        // (a) The manual prepare suspends and stores a Pending session; the
        // incoming-request event still notifies the panel immediately.
        let (session_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        {
            let inner = sessions
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner());
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

        // Accept-all resolves the suspended sender with 200 and the tokens.
        let waiter = spawn_waiter(&sessions, session_id.clone(), decision_rx);
        let accepted = session_accept(&sessions, &session_id, None).expect("accept all");
        assert_eq!(accepted, vec!["f1".to_string(), "f2".to_string()]);
        let (status, body) = waiter.await.expect("waiter task");
        assert_eq!(status, 200, "accept resolves the suspended sender: {body}");
        assert_eq!(body["sessionId"], session_id);
        let token1 = body["files"]["f1"].as_str().expect("f1 token").to_string();
        let token2 = body["files"]["f2"].as_str().expect("f2 token").to_string();
        assert!(!token1.is_empty() && !token2.is_empty());
        assert_ne!(token1, token2);
        {
            let inner = sessions
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let session = inner.sessions.get(&session_id).expect("session stored");
            assert_eq!(session.status, TransferStatus::Transferring);
            assert_eq!(session.tokens["f1"], token1, "tokens match the response");
            assert_eq!(session.tokens["f2"], token2);
        }

        // (b) Decline resolves the suspended sender with 403 "Rejected".
        session_cancel(&sessions, &session_id).expect("cancel the accepted session");
        let (session_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        let waiter = spawn_waiter(&sessions, session_id.clone(), decision_rx);
        session_decline(&sessions, &session_id).expect("decline");
        let (status, body) = waiter.await.expect("waiter task");
        assert_eq!(status, 403, "declined sender");
        assert_eq!(body["error"], "Rejected");
        assert_eq!(
            session_status(&sessions, &session_id),
            None,
            "session removed"
        );
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Cancelled);

        // (c) Sender disconnect (handler future dropped): a late accept
        // detects the dead channel and cleans the session up, freeing the
        // single-session slot (official PendingSessionGuard).
        let (session_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        drop(decision_rx);
        let error = session_accept(&sessions, &session_id, None)
            .expect_err("late accept must detect the abort");
        assert!(error.contains("sender disconnected"), "unexpected: {error}");
        assert_eq!(session_status(&sessions, &session_id), None, "cleaned up");
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Cancelled);

        // (d) Accepting nothing resolves the suspended sender with 204
        // ("nothing to transfer", official) and finishes the session.
        let (session_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        let waiter = spawn_waiter(&sessions, session_id.clone(), decision_rx);
        let accepted = session_accept(&sessions, &session_id, Some(vec!["bogus-id".into()]))
            .expect("empty accept is allowed");
        assert!(accepted.is_empty());
        let (status, body) = waiter.await.expect("waiter task");
        assert_eq!(status, 204, "nothing to transfer: {body}");
        // Terminal Done session: evicted from the map, history kept.
        assert_eq!(session_status(&sessions, &session_id), None, "evicted");
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Done);
    }

    #[tokio::test]
    async fn accept_after_pending_issues_remaining_tokens() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];

        // Partial accept: the suspended sender learns ONLY the accepted
        // file's token; the rest stay tokenless (official files map).
        let (session_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        let waiter = spawn_waiter(&sessions, session_id.clone(), decision_rx);
        let accepted = session_accept(&sessions, &session_id, Some(vec!["f1".into()]))
            .expect("partial accept");
        assert_eq!(accepted, vec!["f1".to_string()]);
        let (status, body) = waiter.await.expect("waiter task");
        assert_eq!(status, 200, "{body}");
        assert!(body["files"]["f1"].as_str().is_some(), "accepted token");
        assert!(
            body["files"]["f2"].is_null(),
            "the skipped file has no token in the response"
        );
        {
            let inner = sessions
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let session = inner.sessions.get(&session_id).expect("session stored");
            assert_eq!(session.status, TransferStatus::Transferring);
            assert_eq!(
                session.tokens.len(),
                1,
                "only the accepted file got a token"
            );
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
        assert_eq!(
            status, 409,
            "file without a token is not accepted for upload"
        );

        // Accept-all on a fresh pending session: fileIds omitted means every
        // file of the session.
        session_cancel(&sessions, &session_id).expect("cancel the first session");
        let (session_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        let waiter = spawn_waiter(&sessions, session_id.clone(), decision_rx);
        let accepted = session_accept(&sessions, &session_id, None).expect("accept all");
        assert_eq!(accepted, vec!["f1".to_string(), "f2".to_string()]);
        let (status, body) = waiter.await.expect("waiter task");
        assert_eq!(status, 200, "{body}");
        let inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let session = inner.sessions.get(&session_id).expect("session stored");
        assert_eq!(session.status, TransferStatus::Transferring);
        assert_eq!(session.tokens.len(), 2);
        assert_eq!(
            session.tokens["f1"], body["files"]["f1"],
            "response tokens match"
        );
    }

    #[tokio::test]
    async fn upload_rejects_bad_token_and_wrong_ip() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);
        let entries = [file_entry("f1", 10, None)];

        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
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
            let inner = sessions
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner());
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
        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
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

        tx.send(Ok(Bytes::from_static(b"abc")))
            .await
            .expect("send chunk 1");
        wait_for_size(&temp_path, 3).await;
        tx.send(Ok(Bytes::from_static(b"def")))
            .await
            .expect("send chunk 2");
        wait_for_size(&temp_path, 6).await;
        tx.send(Ok(Bytes::from_static(b"ghi")))
            .await
            .expect("send chunk 3");
        wait_for_size(&temp_path, 9).await;
        drop(tx);

        let (status, body) = handle.await.expect("upload task");
        assert_eq!(status, 200, "sha256 matches: {body}");
        assert!(temp_path.is_file(), "no download dir: file stays in tmp");
        let stored = std::fs::metadata(&temp_path).expect("final file").len();
        assert_eq!(stored, 9, "every chunk reached the disk");
        // Terminal Done session: evicted from the map, history kept.
        assert_eq!(session_status(&sessions, &session_id), None, "evicted");

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

        // Corruption path: a checksum mismatch does NOT kill the file — the
        // sender retries the same token up to MAX_UPLOAD_ATTEMPTS (official
        // _maxUploadAttempts = 3). Only the third mismatch fails the session.
        let entries = [file_entry("f2", 9, Some(&"0".repeat(64)))];
        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200, "{body}");
        let bad_session = body["sessionId"].as_str().expect("sessionId").to_string();
        let bad_token = body["files"]["f2"].as_str().expect("token").to_string();
        let bad_path = sessions.tmp_root().join(&bad_session).join("f2");

        for attempt in 1..=3u32 {
            let (status, _) = upload_stream(
                Arc::clone(&sessions),
                None,
                bad_session.clone(),
                "f2".into(),
                bad_token.clone(),
                SENDER_IP,
                body_from_chunks(&[b"abc", b"def", b"ghi"]),
            )
            .await;
            assert_eq!(status, 422, "checksum mismatch on attempt {attempt}");
            assert!(
                !bad_path.exists(),
                "corrupt temp file deleted (attempt {attempt})"
            );
            if attempt < 3 {
                assert_eq!(
                    session_status(&sessions, &bad_session),
                    Some(TransferStatus::Transferring),
                    "file reset for retransmission after attempt {attempt}"
                );
            }
        }
        assert_eq!(
            session_status(&sessions, &bad_session),
            None,
            "budget exhausted on the third mismatch — terminal session evicted"
        );
        let record = record_snapshot(&sessions, &bad_session);
        assert_eq!(record.status, TransferStatus::Failed);
        let done = event_data(&events, "transfer-done");
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["status"], "failed");

        // A fourth upload against the failed file is blocked outright: the
        // evicted session can no longer validate any token.
        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            bad_session,
            "f2".into(),
            bad_token,
            SENDER_IP,
            empty_body(),
        )
        .await;
        assert_eq!(status, 403, "failed file is terminal");
    }

    #[tokio::test]
    async fn cancel_clears_session_and_temp() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);
        let entries = [file_entry("f1", 10, None)];

        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
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
        assert_eq!(
            session_status(&sessions, &session_id),
            None,
            "session removed"
        );

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
        let entries = [file_entry("f1", 10, None)];

        // The manual prepare suspends; the receiver stays held open here.
        let (session_id, _decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);

        session_decline(&sessions, &session_id).expect("decline");
        assert_eq!(
            session_status(&sessions, &session_id),
            None,
            "session removed"
        );
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Cancelled);
        let done = event_data(&events, "transfer-done");
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["status"], "cancelled");

        // The single slot is free again.
        let (session_id, _decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        assert_eq!(
            session_status(&sessions, &session_id),
            Some(TransferStatus::Pending),
            "fresh pending session"
        );
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
        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
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
        assert_eq!(
            session_status(&sessions, &session_id),
            None,
            "evicted on Done"
        );

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
        // The Done session was evicted (official drops the slot on
        // completion), so the replayed token can no longer be validated.
        assert_eq!(status, 403, "replay upload against a Done session blocked");
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
        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
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

    #[tokio::test]
    async fn transfers_persist_and_reload() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let entries = [file_entry("f1", 10, None), file_entry("f2", 20, None)];

        let (session_id, _decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        session_accept(&sessions, &session_id, None).expect("accept all");
        assert_eq!(
            record_snapshot(&sessions, &session_id).status,
            TransferStatus::Transferring
        );
        drop(sessions);

        assert!(temp.path().join("transfers.json").is_file());
        let reloaded =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("reload sessions");
        let records = transfer_records(&reloaded);
        assert_eq!(records.len(), 1, "history survives a restart");
        let record = record_for(&records, &session_id);
        assert_eq!(
            record.status,
            TransferStatus::Failed,
            "a residual Transferring record is dead after a restart"
        );
        assert_eq!(record.files.len(), 2);
        // The correction itself is persisted.
        let reloaded_again =
            ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("reload again");
        assert_eq!(
            record_for(&transfer_records(&reloaded_again), &session_id).status,
            TransferStatus::Failed
        );
    }

    #[test]
    fn prepare_rejects_unsafe_file_ids() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, None);

        for evil in ["../evil", "sub\\dir", "..", ".", "con:stream", ""] {
            let mut files = files_map(&[file_entry("f1", 10, None)]);
            files.insert(evil.to_string(), file_entry("x", 10, None));
            let (status, body) =
                match prepare_upload(&sessions, &config, sender_info(), files, None, SENDER_IP) {
                    PrepareOutcome::Immediate { status, body } => (status, body),
                    PrepareOutcome::AwaitDecision { .. } => panic!("must be rejected outright"),
                };
            assert_eq!(status, 400, "unsafe file id {evil:?} rejected: {body}");
        }

        let inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert!(
            inner.sessions.is_empty(),
            "no session is created from an invalid body"
        );
    }

    #[test]
    fn prepare_rejects_empty_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, None);

        let (status, body) = match prepare_upload(
            &sessions,
            &config,
            sender_info(),
            HashMap::new(),
            None,
            SENDER_IP,
        ) {
            PrepareOutcome::Immediate { status, body } => (status, body),
            PrepareOutcome::AwaitDecision { .. } => panic!("must be rejected outright"),
        };
        assert_eq!(status, 400, "empty files map: {body}");
        assert_eq!(body["error"], "No files provided", "official message");
        assert!(transfer_records(&sessions).is_empty());
    }

    #[test]
    fn prepare_pin_attempts_rate_limited() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");
        let config = settings(true, Some("123456"));
        let entries = [file_entry("f1", 10, None)];

        // Three wrong attempts are answered 401; the next request from the
        // same IP is blocked with 429 before the PIN is even compared
        // (official MAX_PIN_ATTEMPTS = 3).
        for attempt in 1..=3u32 {
            let (status, body) =
                prepare_now(&sessions, &config, &entries, Some("000000"), SENDER_IP);
            assert_eq!(status, 401, "wrong pin attempt {attempt}: {body}");
        }
        let (status, body) = prepare_now(&sessions, &config, &entries, Some("123456"), SENDER_IP);
        assert_eq!(
            status, 429,
            "budget exhausted, even the correct pin: {body}"
        );
        assert_eq!(body["error"], "Too many requests", "official message");

        // A different source IP keeps its own budget.
        let (status, body) = prepare_now(&sessions, &config, &entries, Some("000000"), OTHER_IP);
        assert_eq!(status, 401, "fresh IP: {body}");

        // No incoming request ever fired for the failed attempts.
        assert!(event_data(&events, "incoming-request").is_empty());
    }

    #[tokio::test]
    async fn partial_accept_terminates_when_accepted_files_done() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let entries = [file_entry("f1", 7, None), file_entry("f2", 9, None)];

        // Partial accept: only f1 is tokenized; f2 is skipped.
        let (session_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        let waiter = spawn_waiter(&sessions, session_id.clone(), decision_rx);
        session_accept(&sessions, &session_id, Some(vec!["f1".into()])).expect("partial accept");
        let (status, body) = waiter.await.expect("waiter task");
        assert_eq!(status, 200, "{body}");
        let token = body["files"]["f1"].as_str().expect("token").to_string();

        // The single accepted file completing ends the session even though
        // the skipped f2 was never uploaded.
        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f1".into(),
            token,
            SENDER_IP,
            body_from_chunks(&[b"payload"]),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(
            session_status(&sessions, &session_id),
            None,
            "accepted files all terminal → session done and evicted"
        );
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Done);
        assert!(record.destinations.contains_key("f1"));
        assert!(!record.destinations.contains_key("f2"), "skipped file");
        let done = event_data(&events, "transfer-done");
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["status"], "done");
    }

    #[test]
    fn dead_pending_slot_reclaimed_on_new_prepare() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let entries = [file_entry("f1", 10, None)];

        // Manual prepare whose sender vanishes without a decision: the
        // suspended prepare-upload handler future was dropped, so the
        // decision receiver is gone while the session sits in the map.
        let (dead_id, decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        drop(decision_rx);

        // The next prepare must NOT be answered 409: the dead pending slot
        // is reclaimed and the request becomes a fresh Pending session.
        let (new_id, _decision_rx) = prepare_manual(&sessions, &entries, SENDER_IP);
        assert_ne!(new_id, dead_id, "a fresh session was stored");
        assert_eq!(
            session_status(&sessions, &new_id),
            Some(TransferStatus::Pending)
        );
        assert_eq!(
            session_status(&sessions, &dead_id),
            None,
            "the dead pending session was aborted"
        );
        let record = record_snapshot(&sessions, &dead_id);
        assert_eq!(record.status, TransferStatus::Cancelled);
        let done = event_data(&events, "transfer-done");
        assert!(
            done.iter()
                .any(|data| data["sessionId"] == dead_id && data["status"] == "cancelled"),
            "the abort is reported: {done:?}"
        );
    }

    #[tokio::test]
    async fn terminal_sessions_evicted() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let config = settings(true, None);

        let digest = sha256_hex(b"payload");
        let entries = [file_entry("f1", 7, Some(&digest))];
        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200, "{body}");
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();
        let token = body["files"]["f1"].as_str().expect("token").to_string();

        let (status, body) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "f1".into(),
            token,
            SENDER_IP,
            body_from_chunks(&[b"payload"]),
        )
        .await;
        assert_eq!(status, 200, "{body}");

        // Terminal: the session left the map (official drops the slot on
        // completion) while the history record stays in transfer_list.
        {
            let inner = sessions
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert!(
                inner.sessions.is_empty(),
                "terminal sessions must be evicted: {:?}",
                inner.sessions.keys().collect::<Vec<_>>()
            );
        }
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Done);
        // Without a download dir the received file stays in tmp as the
        // recorded destination — eviction must not touch it.
        assert!(sessions.tmp_root().join(&session_id).join("f1").is_file());

        // The freed slot accepts the next prepare immediately.
        let (status, body) = prepare_now(&sessions, &config, &entries, None, SENDER_IP);
        assert_eq!(status, 200, "slot free after completion: {body}");
    }

    /// Cancellation must wake a receiver whose sender has not closed the body.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_stalled_upload_before_body_eof() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let (status, prepared) = prepare_now(
            &sessions,
            &settings(true, None),
            &[file_entry("partial", 100, None)],
            None,
            SENDER_IP,
        );
        assert_eq!(status, 200);
        let session_id = prepared["sessionId"]
            .as_str()
            .expect("session id")
            .to_string();
        let token = prepared["files"]["partial"]
            .as_str()
            .expect("token")
            .to_string();
        let path = sessions.tmp_root().join(&session_id).join("partial");
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
        let mut upload = tokio::spawn(upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "partial".into(),
            token,
            SENDER_IP,
            Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)),
        ));
        tx.send(Ok(Bytes::from_static(b"partial")))
            .await
            .expect("first chunk");
        wait_for_size(&path, 7).await;

        session_cancel(&sessions, &session_id).expect("cancel active writer");
        let settled = tokio::time::timeout(Duration::from_millis(500), &mut upload).await;
        if settled.is_err() {
            upload.abort();
            let _ = upload.await;
        }
        assert!(
            settled.is_ok(),
            "cancel must finish the upload without waiting for EOF"
        );
        assert!(tx.is_closed(), "the stalled body must be dropped on cancel");
        sessions.drain().await.expect("closed-writer cleanup");
        assert!(
            !path.parent().expect("session dir").exists(),
            "closed writer's partial dir removed"
        );
        assert_eq!(
            record_snapshot(&sessions, &session_id).status,
            TransferStatus::Cancelled
        );
        let inner = sessions
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert!(
            inner.progress.is_empty(),
            "cancel must not leave coalesced receive progress"
        );
        drop(inner);
        let done = event_data(&events, "transfer-done");
        assert_eq!(
            done.len(),
            1,
            "one terminal event despite the upload settling after cancel"
        );
        assert_eq!(done[0]["status"], "cancelled");
    }

    /// Completed files in a partially cancelled session are still user data.
    #[tokio::test]
    async fn cancel_preserves_completed_files_in_partial_session() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions =
            Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions"));
        let (status, prepared) = prepare_now(
            &sessions,
            &settings(true, None),
            &[
                file_entry("finished", 4, None),
                file_entry("pending", 100, None),
            ],
            None,
            SENDER_IP,
        );
        assert_eq!(status, 200);
        let session_id = prepared["sessionId"]
            .as_str()
            .expect("session id")
            .to_string();
        let token = prepared["files"]["finished"]
            .as_str()
            .expect("token")
            .to_string();
        let (status, _) = upload_stream(
            Arc::clone(&sessions),
            None,
            session_id.clone(),
            "finished".into(),
            token,
            SENDER_IP,
            Body::from("kept"),
        )
        .await;
        assert_eq!(status, 200);
        let finished = sessions.tmp_root().join(&session_id).join("finished");
        std::fs::write(
            sessions.tmp_root().join(&session_id).join("pending"),
            b"unfinished",
        )
        .expect("partial file");

        session_cancel(&sessions, &session_id).expect("cancel remaining file");
        assert_eq!(
            std::fs::read(&finished).expect("completed file retained"),
            b"kept"
        );
        assert!(!sessions
            .tmp_root()
            .join(&session_id)
            .join("pending")
            .exists());
        let record = record_snapshot(&sessions, &session_id);
        assert_eq!(record.status, TransferStatus::Cancelled);
        assert_eq!(record.destinations["finished"], finished.to_string_lossy());
        assert_eq!(event_data(&events, "transfer-done").len(), 1);
    }

    #[test]
    fn stop_never_forces_axum_closed_while_receive_commit_is_active() {
        let temp = tempfile::tempdir().expect("temp dir");
        Settings {
            port: 0,
            ..Default::default()
        }
        .save(temp.path())
        .unwrap();
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = Arc::new(ReceiveSessions::new(temp.path(), Arc::clone(&events)).unwrap());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .unwrap();
        let controller = Arc::new(crate::service::ServiceController::new(
            runtime.handle().clone(),
            temp.path().to_path_buf(),
            Arc::new(std::sync::RwLock::new(Settings::default())),
            Arc::clone(&sessions),
            events,
        ));
        controller.start().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while controller.status().state != crate::service::ServiceState::Running {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let client = crate::sender::http_client();
        let port = controller.status().port;
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
        runtime
            .block_on(tx.send(Ok(Bytes::from_static(b"{"))))
            .unwrap();
        let request = runtime.spawn(async move {
            client
                .post(format!(
                    "https://127.0.0.1:{port}/api/localsend/v2/prepare-upload"
                ))
                .header("content-type", "application/json")
                .body(reqwest::Body::wrap_stream(
                    tokio_stream::wrappers::ReceiverStream::new(rx),
                ))
                .send()
                .await
        });
        std::thread::sleep(Duration::from_millis(100));
        let lease = super::UploadLease::new(
            Arc::new(super::UploadActivity::default()),
            Arc::clone(&sessions.uploads),
        );
        controller.stop(true);
        std::thread::sleep(Duration::from_millis(4300));
        let closed_while_committing = request.is_finished();
        assert_eq!(
            controller.status().state,
            crate::service::ServiceState::Stopping
        );
        drop(lease);
        runtime.block_on(controller.shutdown());
        let _ = runtime.block_on(request);
        drop(tx);
        assert!(
            !closed_while_committing,
            "force-close must wait for writer/commit lease instead of dropping filesystem futures"
        );
    }

    #[tokio::test]
    async fn cancelled_drain_keeps_cleanup_handles_owned() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = Arc::new(ReceiveSessions::new(temp.path(), events).expect("sessions"));
        let (tx, rx) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let _ = rx.await;
            Ok(())
        });
        sessions.cleanups.lock().unwrap().push(task);
        let result = tokio::time::timeout(Duration::from_millis(20), sessions.drain()).await;
        assert!(result.is_err(), "cleanup is still blocked");
        let retained = sessions.cleanups.lock().unwrap().len();
        tx.send(()).expect("release cleanup");
        sessions.drain().await.expect("drain completed");
        assert_eq!(
            retained, 1,
            "timed-out drain must not detach its cleanup task"
        );
    }

    #[test]
    fn bogus_session_actions_fail() {
        let temp = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let sessions = ReceiveSessions::new(temp.path(), Arc::clone(&events)).expect("sessions");

        assert!(session_accept(&sessions, "nope", None).is_err());
        assert!(session_decline(&sessions, "nope").is_err());
        assert!(session_cancel(&sessions, "nope").is_err());
        assert!(transfer_records(&sessions).is_empty());
    }
}
