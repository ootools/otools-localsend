//! Outbound LocalSend v2 sender (Task 9): prepare-upload against a peer,
//! parallel streaming uploads with coalesced `transfer-progress` events, a
//! checksum-mismatch retry budget, and cancellable sessions.
//!
//! Layout mirrors the receiver: wire details (URL building, reqwest bodies)
//! stay separate from plain, directly testable pieces (`build_entry`,
//! [`SendSessions::report_progress`], the prepare/upload outcome switches), so
//! the unit tests drive the same code paths over plain HTTP (`scheme: "http"`)
//! against tiny axum servers. Production always talks `https://` with a
//! self-signed-tolerant rustls client — `danger_accept_invalid_certs(true)`,
//! aligned with the official app (the certificate fingerprint is only used by
//! the discovery layer to dedupe devices).
//!
//! Protocol facts (localsend/protocol v2.2 + official app behavior):
//! - `POST /api/localsend/v2/prepare-upload?pin=` carries `{info, files}` and
//!   carries NO total timeout: the official receiver holds the response open
//!   until the user decides (accept/decline), which can take minutes. Only the
//!   TCP connect is bounded (5s connect timeout on the client builder).
//! - `200` → `{sessionId, files: {fileId: token}}` and the uploads begin;
//!   `204` → nothing was accepted (session Done with zero uploaded files);
//!   `403` → declined (record Cancelled); `409` → busy (record Failed).
//! - `POST /upload?sessionId&fileId&token` streams the body; a `422`
//!   checksum mismatch retries the SAME token up to [`MAX_UPLOAD_ATTEMPTS`]
//!   (official `_maxUploadAttempts = 3`) before the file fails; other files
//!   continue.
//! - Text messages travel as a virtual `.txt` file with in-memory bytes,
//!   named `<uuid v4>.txt` and carrying the text in `preview` — the exact
//!   official wire shape (AddMessageAction in
//!   `app/lib/provider/selection/selected_sending_files_provider.dart` builds
//!   `<uuid v4>.txt`; `send_provider.dart:121-122` embeds the text into
//!   `preview` for a single-text send, which the official receiver
//!   (`receive_session_state.dart`) requires to render a message bubble and
//!   accept the message without a plain-file transfer).
//! - Cancelling (official behavior): abort the in-flight uploads and POST
//!   `/api/localsend/v2/cancel?sessionId=` — without a sessionId while the
//!   prepare is still pending (the receiver resolves it by source IP).
//! - Uploads run with [`UPLOAD_CONCURRENCY`] parallel workers, files are
//!   streamed from disk in 64 KiB chunks (never buffered whole) and every
//!   chunk is reported through the coalescing helper with a monotonic
//!   percent; the final 100% tick is emitted with the file's success so no
//!   last tick is stranded in the pending map (Task 5 review handoff).

use crate::crypto::sha256_hex;
use crate::discovery::{DiscoveryShared, PROTOCOL_VERSION};
use crate::event_bridge::{coalesce_progress, WebEventBroadcaster};
use crate::models::{DeviceInfo, Direction, FileEntry, Metadata, TransferRecord, TransferStatus};
use crate::server::ReceiveSessions;
use crate::service::ServiceScope;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

/// v2 API root shared by every outbound request.
pub const API_ROOT: &str = "/api/localsend/v2";
/// Parallel upload workers (official sender uses 2; the Task 8 review of the
/// receiver confirmed it tolerates 2-3 — we take 3).
pub const UPLOAD_CONCURRENCY: usize = 3;
/// Checksum-mismatch retry budget per file, official `MAX_UPLOAD_ATTEMPTS`
/// (packages/core/src/http/server/v2.rs; sender `_maxUploadAttempts`).
pub const MAX_UPLOAD_ATTEMPTS: u32 = 3;
/// Per-request timeout for the short best-effort requests (register replies,
/// cancel notification). Deliberately NOT applied to prepare-upload/upload:
/// prepare stays open until the receiver decides (Task 8 review handoff).
pub const SHORT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Cancel is best effort; it must not consume the whole service drain budget.
const CANCEL_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// TCP connect timeout (the only timeout on transfer requests).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Disk read chunk for hashing and upload streaming.
const READ_CHUNK: usize = 64 * 1024;

/// reqwest client for every outbound v2 exchange: rustls, self-signed
/// certificates accepted (official behavior), 5s connect timeout and NO
/// default total timeout — per-request timeouts are applied only to the
/// short best-effort calls.
pub fn http_client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .use_rustls_tls()
        .danger_accept_invalid_certs(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .expect("reqwest client builds")
}

/// One item the user wants to send.
#[derive(Debug, Clone)]
pub enum SendItem {
    /// A file on disk; the wire name is its file-name component.
    File(PathBuf),
    /// A text message, sent as a virtual `.txt` file with in-memory bytes.
    Text(String),
}

/// The peer a job talks to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendPeer {
    pub ip: String,
    pub port: u16,
    /// Best-known alias (from the device table) for the history record.
    pub alias: String,
}

/// One outbound transfer. Cancelling flips a `watch<bool>`: the job task
/// observes it, aborts the in-flight requests, notifies the peer via
/// `POST /cancel` and finalizes the record.
pub struct SendJob {
    pub session_id: String,
    pub peer: SendPeer,
    pub file_ids: Vec<String>,
    cancel_tx: watch::Sender<bool>,
    cancel_rx: watch::Receiver<bool>,
    finalized: AtomicBool,
}

impl SendJob {
    /// Request cancellation. Idempotent; the job task performs the rest.
    pub fn cancel(&self) {
        let _ = self.cancel_tx.send(true);
    }

    /// Whether cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        *self.cancel_rx.borrow()
    }

    /// Independent handle for one upload task's `select` arm.
    fn subscribe_cancel(&self) -> watch::Receiver<bool> {
        self.cancel_rx.clone()
    }
}

/// Where the payload bytes of one entry come from.
#[derive(Debug)]
enum SendSource {
    /// Read from this path at upload time (streamed, never buffered whole).
    File(PathBuf),
    /// In-memory bytes (text message).
    Bytes(Vec<u8>),
}

/// Coalescing state for `transfer-progress` per (sessionId, fileId):
/// `(last-flushed percent, pending payload, last flush instant)`.
type PendingProgress = HashMap<(String, String), (u32, Value, Instant)>;

/// Per-file result feeding the session's final status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileOutcome {
    Uploaded,
    /// The receiver's response did not carry a token for this file.
    Skipped,
    Failed,
}

/// State shared by all outbound jobs: the session registry behind
/// `session_cancel`, the progress coalescing map, the event queue, the
/// history store and the HTTP client.
pub struct SendSessions {
    jobs: Mutex<HashMap<String, Arc<SendJob>>>,
    progress: Mutex<PendingProgress>,
    events: Arc<WebEventBroadcaster>,
    receive: Arc<ReceiveSessions>,
    discovery: Option<Arc<DiscoveryShared>>,
    client: reqwest::Client,
    /// "https" in production; "http" in the unit tests, which drive the same
    /// code paths against plain axum servers.
    scheme: &'static str,
    scope: Option<Arc<ServiceScope>>,
}

impl SendSessions {
    pub fn new(
        receive: Arc<ReceiveSessions>,
        events: Arc<WebEventBroadcaster>,
        discovery: Option<Arc<DiscoveryShared>>,
    ) -> Self {
        Self::build("https", receive, events, discovery)
    }

    pub(crate) fn in_service(
        receive: Arc<ReceiveSessions>,
        events: Arc<WebEventBroadcaster>,
        discovery: Arc<DiscoveryShared>,
        scope: Arc<ServiceScope>,
    ) -> Self {
        let mut sessions = Self::new(receive, events, Some(discovery));
        sessions.scope = Some(scope);
        sessions
    }

    #[cfg(test)]
    pub(crate) fn for_tests(
        receive: Arc<ReceiveSessions>,
        events: Arc<WebEventBroadcaster>,
        scheme: &'static str,
    ) -> Self {
        Self::build(scheme, receive, events, None)
    }

    fn build(
        scheme: &'static str,
        receive: Arc<ReceiveSessions>,
        events: Arc<WebEventBroadcaster>,
        discovery: Option<Arc<DiscoveryShared>>,
    ) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            events,
            receive,
            discovery,
            client: http_client(),
            scheme,
            scope: None,
        }
    }

    /// Our announcement payload for the prepare-upload body.
    fn local_info(&self) -> DeviceInfo {
        if let Some(discovery) = &self.discovery {
            return discovery.snapshot_local_info();
        }
        // Tests (no discovery shell): a stable placeholder identity.
        DeviceInfo {
            alias: "LocalSend".into(),
            version: PROTOCOL_VERSION.into(),
            device_model: None,
            device_type: Some("desktop".into()),
            fingerprint: "l".repeat(64),
            port: 0,
            protocol: "https".into(),
            download: false,
        }
    }

    /// Best-known alias for a peer, falling back to `ip:port`.
    fn peer_alias(&self, ip: &str, port: u16) -> String {
        if let Some(discovery) = &self.discovery {
            if let Some(entry) = discovery.devices.list().into_iter().find(|e| e.ip == ip) {
                return entry.info.alias;
            }
        }
        format!("{ip}:{port}")
    }

    /// UI cancel of an outbound session: flips the job's cancel flag. The job
    /// task observes it, aborts the in-flight requests, POSTs `/cancel` to
    /// the peer and finalizes (record Cancelled + `transfer-done`). Returns
    /// whether the id belonged to an outbound job.
    pub fn cancel_session(&self, session_id: &str) -> bool {
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(session_id)
            .cloned();
        match job {
            Some(job) => {
                job.cancel();
                true
            }
            None => false,
        }
    }

    pub(crate) fn active_count(&self) -> usize {
        self.jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .filter(|job| !job.finalized.load(Ordering::SeqCst))
            .count()
    }

    pub(crate) fn cancel_all(&self) {
        let jobs: Vec<Arc<SendJob>> = self
            .jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .cloned()
            .collect();
        for job in jobs {
            job.cancel();
        }
    }

    /// Compute the coalesced `transfer-progress` payload for one tick.
    /// Returns the payload to emit (`None` when coalesced away).
    fn report_progress(&self, session_id: &str, file_id: &str, percent: u32) -> Option<Value> {
        let payload = json!({
            "sessionId": session_id,
            "fileId": file_id,
            "percent": percent,
        });
        let mut pending = self
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        coalesce_progress(
            &mut pending,
            session_id,
            file_id,
            percent,
            payload,
            Instant::now(),
        )
    }

    /// Emit the final 100% tick for a finished file (suppressed when the last
    /// chunk already flushed 100) and drop the pending entry — no stranded
    /// last tick (Task 5 review handoff #2).
    fn finish_progress(&self, session_id: &str, file_id: &str) {
        if let Some(payload) = self.report_progress(session_id, file_id, 100) {
            self.events.send("transfer-progress", payload);
        }
        let key = (session_id.to_string(), file_id.to_string());
        self.progress
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&key);
    }

    /// Drop every coalescing entry of one session (Task 5 review handoff: the
    /// pending map must never outlive the session).
    fn cleanup_progress(&self, session_id: &str) {
        self.progress
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|key, _| key.0 != session_id);
    }

    #[cfg(test)]
    fn pending_progress(&self) -> usize {
        self.progress
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    /// Terminal transition: stop tracking progress for the session, move the
    /// history record to its final status, emit `transfer-done` and evict the
    /// job from the registry (official drops the slot on completion).
    fn finalize_job(&self, job: &SendJob, status: TransferStatus) {
        if job.finalized.swap(true, Ordering::SeqCst) {
            return;
        }
        self.cleanup_progress(&job.session_id);
        self.receive.set_send_record(&job.session_id, status, None);
        let status_name = match status {
            TransferStatus::Done => "done",
            TransferStatus::Cancelled => "cancelled",
            _ => "failed",
        };
        self.events.send(
            "transfer-done",
            json!({ "sessionId": job.session_id, "status": status_name }),
        );
        self.jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&job.session_id);
    }
}

/// Dropping a tracked send future (the bounded-stop fallback) still owns its
/// terminal transition. The atomic in finalize_job makes this and normal exit
/// share exactly one history/event/progress cleanup.
struct SendGuard {
    state: Arc<SendSessions>,
    job: Arc<SendJob>,
}

impl Drop for SendGuard {
    fn drop(&mut self) {
        let status = if self.job.is_cancelled() {
            TransferStatus::Cancelled
        } else {
            TransferStatus::Failed
        };
        self.state.finalize_job(&self.job, status);
    }
}

/// Create and register an outbound job. Synchronous so the invoke methods can
/// answer `{sessionId}` immediately: the session id is generated locally
/// (official app behavior — the peer's own sessionId is a separate wire
/// detail), the job is registered before any spawn, and the returned future
/// (prepare-upload + uploads + finalize) is spawned on the tokio runtime by
/// the caller.
pub fn start_send(
    state: Arc<SendSessions>,
    peer_ip: String,
    peer_port: u16,
    items: Vec<SendItem>,
    pin: Option<String>,
) -> Result<(String, impl Future<Output = ()> + Send + 'static), String> {
    if items.is_empty() {
        return Err("no items to send".into());
    }
    if peer_ip.is_empty() {
        return Err("peer ip is required".into());
    }
    if peer_port == 0 {
        return Err("peer port is required".into());
    }
    let mut entries_sources = Vec::with_capacity(items.len());
    for item in &items {
        entries_sources.push(build_entry(item)?);
    }

    let scope = state.scope.clone();
    let _admission = match &scope {
        Some(scope) => Some(scope.admit()?),
        None => None,
    };
    let session_id = uuid::Uuid::new_v4().to_string();
    let alias = state.peer_alias(&peer_ip, peer_port);
    let peer = SendPeer {
        ip: peer_ip,
        port: peer_port,
        alias,
    };
    let file_ids: Vec<String> = entries_sources
        .iter()
        .map(|(entry, _)| entry.id.clone())
        .collect();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let job = Arc::new(SendJob {
        session_id: session_id.clone(),
        peer: peer.clone(),
        file_ids,
        cancel_tx,
        cancel_rx,
        finalized: AtomicBool::new(false),
    });

    // Register before spawning so `session_cancel` finds the job even while
    // the first request (hashing / prepare) is still in flight.
    state
        .jobs
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(session_id.clone(), Arc::clone(&job));

    // Initial history record (Pending until prepare-upload answers).
    state.receive.upsert_send_record(TransferRecord {
        session_id: session_id.clone(),
        direction: Direction::Send,
        peer_alias: peer.alias,
        files: entries_sources
            .iter()
            .map(|(entry, _)| entry.clone())
            .collect(),
        status: TransferStatus::Pending,
        created_at: now_ms(),
        destinations: HashMap::new(),
    });

    let guard = SendGuard {
        state: Arc::clone(&state),
        job: Arc::clone(&job),
    };
    let run = async move {
        let _guard = guard;
        run_send_job(state, job, entries_sources, pin).await;
    };
    Ok((session_id, run))
}

/// Full send pipeline as one future: registers the job, runs prepare-upload,
/// uploads and finalizes. Resolves once the session reached a terminal state.
/// [`start_send`] exposes the session id synchronously for the runtime
/// methods, which spawn the job and answer immediately.
pub async fn send_to_peer(
    state: Arc<SendSessions>,
    peer_ip: String,
    peer_port: u16,
    items: Vec<SendItem>,
    pin: Option<String>,
) -> Result<String, String> {
    let (session_id, run) = start_send(state, peer_ip, peer_port, items, pin)?;
    run.await;
    Ok(session_id)
}

/// Build one wire entry from a send item. Text is wrapped as the official
/// virtual message file (`<uuid v4>.txt`, text embedded into `preview` — see
/// the module docs); files take their metadata from the filesystem now and
/// their checksum from the streamed hash later.
fn build_entry(item: &SendItem) -> Result<(FileEntry, SendSource), String> {
    match item {
        SendItem::Text(text) => {
            let bytes = text.as_bytes().to_vec();
            Ok((
                FileEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    // Official AddMessageAction (v1.18.2): `<uuid v4>.txt`.
                    file_name: format!("{}.txt", uuid::Uuid::new_v4()),
                    size: bytes.len() as u64,
                    file_type: "text/plain".to_string(),
                    sha256: Some(sha256_hex(&bytes)),
                    // Official send_provider.dart embeds the text into the
                    // preview of a single-text send — that is what makes the
                    // official receiver treat it as a message, not a file.
                    preview: Some(text.clone()),
                    metadata: None,
                },
                SendSource::Bytes(bytes),
            ))
        }
        SendItem::File(path) => {
            let metadata =
                std::fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("not a file: {}", path.display()))?
                .to_string();
            Ok((
                FileEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    file_name,
                    size: metadata.len(),
                    file_type: mime_for(path),
                    sha256: None, // streamed hash inside the job
                    preview: None,
                    metadata: file_metadata(&metadata),
                },
                SendSource::File(path.clone()),
            ))
        }
    }
}

/// Minimal extension→MIME mapping (mirrors the mock peer / official defaults).
fn mime_for(path: &Path) -> String {
    let mime = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
        .and_then(|ext| match ext {
            "txt" | "md" | "log" => Some("text/plain"),
            "html" | "htm" => Some("text/html"),
            "csv" => Some("text/csv"),
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "svg" => Some("image/svg+xml"),
            "webp" => Some("image/webp"),
            "pdf" => Some("application/pdf"),
            "zip" => Some("application/zip"),
            "mp3" => Some("audio/mpeg"),
            "wav" => Some("audio/wav"),
            "mp4" => Some("video/mp4"),
            "mov" => Some("video/quicktime"),
            "json" => Some("application/json"),
            _ => None,
        });
    mime.unwrap_or("application/octet-stream").to_string()
}

/// ISO-8601 (RFC 3339) timestamps for the optional file metadata.
fn file_metadata(metadata: &std::fs::Metadata) -> Option<Metadata> {
    let modified = iso_timestamp(metadata.modified().ok());
    let accessed = iso_timestamp(metadata.accessed().ok());
    if modified.is_none() && accessed.is_none() {
        return None;
    }
    Some(Metadata { modified, accessed })
}

fn iso_timestamp(system: Option<SystemTime>) -> Option<String> {
    let seconds = system?.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let stamp = time::OffsetDateTime::from_unix_timestamp(seconds).ok()?;
    stamp
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// The job lifecycle: stream-hash → prepare-upload → parallel uploads →
/// cancel notification → terminal transition. Runs on the tokio runtime.
async fn run_send_job(
    state: Arc<SendSessions>,
    job: Arc<SendJob>,
    entries_sources: Vec<(FileEntry, SendSource)>,
    pin: Option<String>,
) {
    let session_id = job.session_id.clone();
    let mut results: HashMap<String, FileOutcome> = HashMap::new();

    // Phase 1 — stream-hash the file sources (text entries already carry
    // their checksum from build time). Hash failures fail the file; the rest
    // continue.
    let mut prepared: Vec<(FileEntry, SendSource)> = Vec::with_capacity(entries_sources.len());
    for (entry, source) in entries_sources {
        if job.is_cancelled() {
            results.insert(entry.id, FileOutcome::Failed);
            continue;
        }
        if let SendSource::File(path) = &source {
            if entry.sha256.is_none() {
                match stream_sha256(path, job.subscribe_cancel()).await {
                    Ok(digest) => {
                        let mut hashed = entry;
                        hashed.sha256 = Some(digest);
                        prepared.push((hashed, source));
                    }
                    Err(error) => {
                        eprintln!("otools-localsend sender: hash {}: {error}", path.display());
                        results.insert(entry.id, FileOutcome::Failed);
                    }
                }
                continue;
            }
        }
        prepared.push((entry, source));
    }

    if job.is_cancelled() {
        state.finalize_job(&job, TransferStatus::Cancelled);
        return;
    }
    if prepared.is_empty() {
        state.finalize_job(&job, TransferStatus::Failed);
        return;
    }
    // Refresh the history record with the hashed entries before the request.
    state.receive.set_send_record(
        &session_id,
        TransferStatus::Pending,
        Some(prepared.iter().map(|(entry, _)| entry.clone()).collect()),
    );

    // Phase 2 — prepare-upload. Metadata only, NO total timeout (the official
    // receiver holds the response until a user decides).
    let mut builder = state
        .client
        .post(format!(
            "{}://{}:{}{API_ROOT}/prepare-upload",
            state.scheme, job.peer.ip, job.peer.port
        ))
        .json(&json!({
            "info": state.local_info(),
            "files": prepared
                .iter()
                .map(|(entry, _)| (entry.id.clone(), entry.clone()))
                .collect::<HashMap<String, FileEntry>>(),
        }));
    if let Some(pin) = pin.as_deref() {
        builder = builder.query(&[("pin", pin)]);
    }
    let mut cancel_rx = job.subscribe_cancel();
    enum Prepare {
        Response(reqwest::Response),
        Network(String),
        Cancelled,
    }
    let prepare = tokio::select! {
        biased;
        _ = wait_cancelled(&mut cancel_rx) => Prepare::Cancelled,
        result = builder.send() => match result {
            Ok(response) => Prepare::Response(response),
            Err(error) => Prepare::Network(error.to_string()),
        },
    };

    let (remote_session, tokens) = match prepare {
        Prepare::Cancelled => {
            // The prepare never established a peer session; the cancel goes
            // out without a sessionId (the receiver matches by source IP).
            post_cancel(&state, &job.peer, None).await;
            state.finalize_job(&job, TransferStatus::Cancelled);
            return;
        }
        Prepare::Network(error) => {
            eprintln!(
                "otools-localsend sender: prepare {}:{}: {error}",
                job.peer.ip, job.peer.port
            );
            state.finalize_job(&job, TransferStatus::Failed);
            return;
        }
        Prepare::Response(response) => {
            let status = response.status().as_u16();
            if status == 200 {
                let payload = tokio::select! {
                    biased;
                    _ = wait_cancelled(&mut cancel_rx) => None,
                    result = response.json::<Value>() => Some(result),
                };
                match payload {
                    None => {
                        post_cancel(&state, &job.peer, None).await;
                        state.finalize_job(&job, TransferStatus::Cancelled);
                        return;
                    }
                    Some(Ok(payload)) => {
                        let remote_session = payload
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        (remote_session, parse_tokens(&payload))
                    }
                    Some(Err(error)) => {
                        eprintln!(
                            "otools-localsend sender: prepare body {}: {error}",
                            job.peer.ip
                        );
                        state.finalize_job(&job, TransferStatus::Failed);
                        return;
                    }
                }
            } else {
                let final_status = match status {
                    204 => TransferStatus::Done,
                    403 => TransferStatus::Cancelled,
                    _ => TransferStatus::Failed,
                };
                state.finalize_job(&job, final_status);
                return;
            }
        }
    };

    // Phase 3 — mark Transferring and upload in parallel; only accepted
    // files (i.e. the ones carrying a token) are uploaded, the rest are
    // skipped (official: the response only carries accepted file ids).
    state
        .receive
        .set_send_record(&session_id, TransferStatus::Transferring, None);
    let mut upload_futures = Vec::with_capacity(prepared.len());
    for (entry, source) in prepared {
        let Some(token) = tokens.get(&entry.id).cloned() else {
            results.insert(entry.id, FileOutcome::Skipped);
            continue;
        };
        let state = Arc::clone(&state);
        let job = Arc::clone(&job);
        let remote_session = remote_session.clone();
        upload_futures.push(async move {
            upload_file(&state, &job, &remote_session, entry, source, token).await
        });
    }
    let settled: Vec<(String, FileOutcome)> = futures_util::stream::iter(upload_futures)
        .buffer_unordered(UPLOAD_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    for (file_id, outcome) in settled {
        results.insert(file_id, outcome);
    }

    // Phase 4 — notify the peer on cancel, then the terminal transition
    // (record + transfer-done + pending-map cleanup + registry eviction).
    let final_status = if job.is_cancelled() {
        post_cancel(&state, &job.peer, Some(&remote_session)).await;
        TransferStatus::Cancelled
    } else if results
        .values()
        .any(|outcome| *outcome == FileOutcome::Failed)
    {
        TransferStatus::Failed
    } else {
        TransferStatus::Done
    };
    state.finalize_job(&job, final_status);
}

/// Upload one file with its own checksum-mismatch retry budget. Returns the
/// per-file outcome for the session's final status.
async fn upload_file(
    state: &Arc<SendSessions>,
    job: &Arc<SendJob>,
    remote_session: &str,
    entry: FileEntry,
    source: SendSource,
    token: String,
) -> (String, FileOutcome) {
    let file_id = entry.id.clone();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match upload_attempt(state, job, remote_session, &entry, &source, &token).await {
            Attempt::Ok => {
                // Final 100% tick (coalesced — suppressed when the last chunk
                // already flushed it); the pending entry is dropped.
                state.finish_progress(&job.session_id, &file_id);
                return (file_id, FileOutcome::Uploaded);
            }
            Attempt::ChecksumMismatch => {
                if attempt >= MAX_UPLOAD_ATTEMPTS {
                    eprintln!(
                        "otools-localsend sender: upload {file_id}: checksum mismatch retry budget exhausted"
                    );
                    return (file_id, FileOutcome::Failed);
                }
                // Official: retry with the SAME token (attempt 3 is the last).
            }
            Attempt::Cancelled => return (file_id, FileOutcome::Failed),
            Attempt::Error(error) => {
                eprintln!("otools-localsend sender: upload {file_id} attempt {attempt}: {error}");
                return (file_id, FileOutcome::Failed);
            }
        }
    }
}

enum Attempt {
    Ok,
    ChecksumMismatch,
    Cancelled,
    Error(String),
}

/// One upload request: streamed body, cancel via `select` (dropping the
/// request future aborts the connection), no total timeout.
async fn upload_attempt(
    state: &Arc<SendSessions>,
    job: &Arc<SendJob>,
    remote_session: &str,
    entry: &FileEntry,
    source: &SendSource,
    token: &str,
) -> Attempt {
    let builder = state
        .client
        .post(format!(
            "{}://{}:{}{API_ROOT}/upload",
            state.scheme, job.peer.ip, job.peer.port
        ))
        .query(&[
            ("sessionId", remote_session),
            ("fileId", entry.id.as_str()),
            ("token", token),
        ]);
    let builder = match source {
        SendSource::Bytes(bytes) => builder.body(bytes.clone()),
        SendSource::File(path) => {
            let file = match tokio::fs::File::open(path).await {
                Ok(file) => file,
                Err(error) => {
                    return Attempt::Error(format!("open {}: {error}", path.display()));
                }
            };
            // A streamed body has no known length; declare it so the receiver
            // can trust `size` (the official sender sends Content-Length too).
            builder
                .header(reqwest::header::CONTENT_LENGTH, entry.size)
                .body(file_body(
                    Arc::clone(state),
                    job.session_id.clone(),
                    entry.id.clone(),
                    file,
                    entry.size,
                ))
        }
    };
    let mut cancel_rx = job.subscribe_cancel();
    let response = tokio::select! {
        biased;
        _ = wait_cancelled(&mut cancel_rx) => return Attempt::Cancelled,
        result = builder.send() => match result {
            Ok(response) => response,
            Err(error) => return Attempt::Error(error.to_string()),
        },
    };
    let status = response.status().as_u16();
    if status == 200 {
        return Attempt::Ok;
    }
    // Drain retry/error bodies for connection reuse, but never let a peer's
    // incomplete body hold a cancelled session open.
    let body = tokio::select! {
        biased;
        _ = wait_cancelled(&mut cancel_rx) => return Attempt::Cancelled,
        result = response.text() => result.unwrap_or_default(),
    };
    if status == 422 {
        Attempt::ChecksumMismatch
    } else {
        let body = body.chars().take(200).collect::<String>();
        Attempt::Error(format!("peer answered {status}: {body}"))
    }
}

/// Streaming request body: 64 KiB chunks straight from disk, each reported
/// through the coalescing helper with a monotonic percent — the file is
/// never fully in memory (Review Focus #2).
fn file_body(
    state: Arc<SendSessions>,
    session_id: String,
    file_id: String,
    file: tokio::fs::File,
    size: u64,
) -> reqwest::Body {
    let stream = futures_util::stream::unfold(
        (file, 0u64, size, state, session_id, file_id),
        |(mut file, sent, size, state, session_id, file_id)| async move {
            let mut chunk = vec![0u8; READ_CHUNK];
            match file.read(&mut chunk).await {
                Ok(0) => None,
                Ok(read) => {
                    chunk.truncate(read);
                    let total = sent + read as u64;
                    let percent = ((total.saturating_mul(100)) / size.max(1)).min(100) as u32;
                    if let Some(payload) = state.report_progress(&session_id, &file_id, percent) {
                        state.events.send("transfer-progress", payload);
                    }
                    Some((Ok(chunk), (file, total, size, state, session_id, file_id)))
                }
                Err(error) => Some((Err(error), (file, sent, size, state, session_id, file_id))),
            }
        },
    );
    reqwest::Body::wrap_stream(stream)
}

/// Streamed SHA-256 of a file, checking the cancel flag between chunks.
async fn stream_sha256(path: &Path, cancel: watch::Receiver<bool>) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        if *cancel.borrow() {
            return Err("cancelled".into());
        }
        let read = file
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(hex_digest(hasher))
}

/// Lowercase hex digest of a SHA-256 hasher.
fn hex_digest(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Resolve when the flag flips to true (or is already true). If the job's
/// sender side is dropped without a cancel, the future never resolves.
async fn wait_cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Best-effort cancel notification to the peer.
async fn post_cancel(state: &SendSessions, peer: &SendPeer, remote_session: Option<&str>) {
    let url = format!(
        "{}://{}:{}{API_ROOT}/cancel",
        state.scheme, peer.ip, peer.port
    );
    let mut builder = state.client.post(&url).timeout(CANCEL_REQUEST_TIMEOUT);
    if let Some(session) = remote_session {
        builder = builder.query(&[("sessionId", session)]);
    }
    if let Err(error) = builder.send().await {
        eprintln!("otools-localsend sender: cancel POST {url}: {error}");
    }
}

/// Parse the accepted-file token map out of a prepare-upload response.
fn parse_tokens(payload: &Value) -> HashMap<String, String> {
    payload
        .get("files")
        .and_then(Value::as_object)
        .map(|files| {
            files
                .iter()
                .filter_map(|(id, token)| {
                    token.as_str().map(|token| (id.clone(), token.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{build_entry, send_to_peer, SendItem, SendSessions, SendSource};
    use crate::crypto::sha256_hex;
    use crate::event_bridge::WebEventBroadcaster;
    use crate::models::{Direction, TransferStatus};
    use crate::server::ReceiveSessions;
    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::{Json, Router};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::sync::Arc;

    const API_ROOT: &str = "/api/localsend/v2";

    /// Isolated sender state: its own history store (temp dir) and its own
    /// event queue. `scheme` is "http" so the tests can drive the same code
    /// paths against plain axum servers (no TLS needed for unit tests).
    fn test_state() -> (Arc<SendSessions>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("temp dir");
        let events = Arc::new(WebEventBroadcaster::new());
        let receive = Arc::new(
            ReceiveSessions::new(dir.path(), Arc::clone(&events)).expect("receive sessions"),
        );
        let state = Arc::new(SendSessions::for_tests(receive, events, "http"));
        (state, dir)
    }

    /// Bind a plain HTTP axum server on an ephemeral port; runs until dropped.
    async fn serve(app: Router) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
        port
    }

    fn record_of(state: &SendSessions, session_id: &str) -> crate::models::TransferRecord {
        state
            .receive
            .transfer_records()
            .into_iter()
            .find(|record| record.session_id == session_id)
            .expect("record present")
    }

    fn events_named(state: &SendSessions, name: &str) -> Vec<Value> {
        state
            .events
            .drain()
            .into_iter()
            .filter(|event| event["event"] == name)
            .map(|event| event["data"].clone())
            .collect()
    }

    /// Accept-all prepare handler: one token per offered file.
    async fn prepare_ok(Json(body): Json<Value>) -> Response {
        let files = body
            .get("files")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let tokens: serde_json::Map<String, Value> = files
            .keys()
            .map(|id| (id.clone(), Value::String(format!("token-{id}"))))
            .collect();
        (
            StatusCode::OK,
            Json(json!({ "sessionId": "remote-session", "files": tokens })),
        )
            .into_response()
    }

    #[test]
    fn send_text_wraps_as_virtual_txt_file() {
        let text = "你好，LocalSend\n";
        let (entry, source) = build_entry(&SendItem::Text(text.to_string())).expect("text entry");
        // Official wire shape (AddMessageAction, v1.18.2): the file name is
        // `<uuid v4>.txt` and the text rides in `preview` so receivers render
        // a message bubble instead of saving a plain .txt file.
        assert!(
            entry.file_name.ends_with(".txt"),
            "wire name must end in .txt: {}",
            entry.file_name
        );
        let stem = entry
            .file_name
            .strip_suffix(".txt")
            .expect("wire name ends in .txt");
        let parsed = uuid::Uuid::parse_str(stem).expect("wire name stem is a uuid");
        assert_eq!(
            parsed.get_version_num(),
            4,
            "wire name must embed a uuid v4: {}",
            entry.file_name
        );
        assert_eq!(
            entry.preview.as_deref(),
            Some(text),
            "text embedded into preview"
        );
        assert_eq!(entry.file_type, "text/plain");
        assert_eq!(
            entry.size,
            text.len() as u64,
            "size is the utf8 byte length"
        );
        assert_eq!(
            entry.sha256.as_deref(),
            Some(sha256_hex(text.as_bytes()).as_str()),
            "checksum precomputed for the in-memory payload"
        );
        assert!(entry.metadata.is_none());
        match source {
            SendSource::Bytes(bytes) => assert_eq!(bytes, text.as_bytes(), "content = text bytes"),
            other => panic!("text must be an in-memory source, got {other:?}"),
        }
        assert!(!entry.id.is_empty());

        // File items: wire name = file-name component, fs metadata, checksum
        // deferred to the streaming hash inside the job.
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("数据文件.bin");
        std::fs::write(&path, b"payload").expect("write");
        let (entry, source) = build_entry(&SendItem::File(path.clone())).expect("file entry");
        assert_eq!(entry.file_name, "数据文件.bin", "non-ASCII name preserved");
        assert_eq!(entry.size, 7);
        assert_eq!(entry.file_type, "application/octet-stream");
        assert!(
            entry.sha256.is_none(),
            "file checksums are hashed in the job"
        );
        assert!(entry.metadata.is_some());
        match source {
            SendSource::File(resolved) => assert_eq!(resolved, path),
            other => panic!("file must be a disk source, got {other:?}"),
        }
    }

    #[test]
    fn progress_events_coalesced() {
        let (state, _dir) = test_state();
        let session = "s-progress";
        let file = "f-progress";

        // 50 rapid ticks over a 1 MB file, 10 bytes each: the percent never
        // advances by >= 1 and the 250 ms window never elapses, so only the
        // first observation flushes.
        let mut flushed = Vec::new();
        for tick in 1..=50u64 {
            let percent = ((tick.saturating_mul(10)).saturating_mul(100) / 1_000_000) as u32;
            if let Some(payload) = state.report_progress(session, file, percent) {
                flushed.push(payload);
            }
        }
        assert_eq!(flushed.len(), 1, "rapid sub-1% ticks coalesce: {flushed:?}");
        assert_eq!(flushed[0]["percent"], 0);
        assert_eq!(state.pending_progress(), 1, "one pending entry for the key");

        // A percent jump flushes immediately (monotonic percent rule).
        let jumped = state
            .report_progress(session, file, 5)
            .expect("jump flushes");
        assert_eq!(jumped["percent"], 5);

        // Session end: the pending map must be cleaned, never stranded.
        state.cleanup_progress(session);
        assert_eq!(
            state.pending_progress(),
            0,
            "pending map cleaned at session end"
        );
    }

    #[tokio::test]
    async fn prepare_403_marks_failed_event() {
        let app = Router::new().route(
            &format!("{API_ROOT}/prepare-upload"),
            axum::routing::post(|| async {
                (StatusCode::FORBIDDEN, Json(json!({ "error": "Rejected" })))
            }),
        );
        let port = serve(app).await;

        let (state, _dir) = test_state();
        let session_id = send_to_peer(
            Arc::clone(&state),
            "127.0.0.1".into(),
            port,
            vec![SendItem::Text("declined text".into())],
            None,
        )
        .await
        .expect("job ran to a terminal state");

        let record = record_of(&state, &session_id);
        assert_eq!(
            record.status,
            TransferStatus::Cancelled,
            "decline = cancelled"
        );
        assert_eq!(record.direction, Direction::Send);
        assert_eq!(record.files.len(), 1);
        assert!(
            record.destinations.is_empty(),
            "send records have no destinations"
        );

        let done = events_named(&state, "transfer-done");
        assert_eq!(done.len(), 1, "one transfer-done: {done:?}");
        assert_eq!(done[0]["sessionId"], session_id.as_str());
        assert_eq!(done[0]["status"], "cancelled");
        assert!(
            events_named(&state, "transfer-progress").is_empty(),
            "no progress without an accepted upload"
        );
        assert_eq!(
            state.pending_progress(),
            0,
            "pending map cleaned at session end"
        );
    }

    #[tokio::test]
    async fn send_files_streams_and_completes() {
        // Mini receiver: prepare-upload issues one token per offered file;
        // upload counts the streamed bytes and the declared content length.
        let received = Arc::new(AtomicU64::new(0));
        let declared = Arc::new(AtomicU64::new(0));
        let (received_in_handler, declared_in_handler) =
            (Arc::clone(&received), Arc::clone(&declared));
        let upload = move |query: Query<HashMap<String, String>>,
                           headers: HeaderMap,
                           body: axum::body::Body| async move {
            let _ = query;
            if let Some(length) = headers
                .get("content-length")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
            {
                declared_in_handler.store(length, Ordering::SeqCst);
            }
            let mut total = 0u64;
            let mut body = body;
            while let Some(frame) = http_body_util::BodyExt::frame(&mut body).await {
                let frame = frame.expect("body frame");
                if let Some(data) = frame.data_ref() {
                    total += data.len() as u64;
                }
            }
            received_in_handler.fetch_add(total, Ordering::SeqCst);
            StatusCode::OK.into_response()
        };
        let app = Router::new()
            .route(
                &format!("{API_ROOT}/prepare-upload"),
                axum::routing::post(prepare_ok),
            )
            .route(&format!("{API_ROOT}/upload"), axum::routing::post(upload));
        let port = serve(app).await;

        // 200 KB = several 64 KiB chunks: proves chunked streaming and gives
        // the coalescer multiple ticks.
        let payload: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let temp = tempfile::tempdir().expect("temp dir");
        let file = temp.path().join("stream-me.bin");
        std::fs::write(&file, &payload).expect("write payload");

        let (state, _dir) = test_state();
        let session_id = send_to_peer(
            Arc::clone(&state),
            "127.0.0.1".into(),
            port,
            vec![SendItem::File(file.clone())],
            None,
        )
        .await
        .expect("send completed");

        let record = record_of(&state, &session_id);
        assert_eq!(record.status, TransferStatus::Done);
        assert_eq!(record.direction, Direction::Send);
        assert_eq!(record.files.len(), 1);
        assert_eq!(record.files[0].file_name, "stream-me.bin");
        assert_eq!(record.files[0].size, payload.len() as u64);
        assert_eq!(
            record.files[0].sha256.as_deref(),
            Some(sha256_hex(&payload).as_str()),
            "streamed hash recorded"
        );
        assert_eq!(
            declared.load(Ordering::SeqCst),
            payload.len() as u64,
            "streamed body must declare its content length"
        );
        assert_eq!(
            received.load(Ordering::SeqCst),
            payload.len() as u64,
            "the receiver must see every byte"
        );

        // One drain: events_named drains the whole queue, so everything is
        // filtered from a single snapshot.
        let events = state.events.drain();
        let progress: Vec<u64> = events
            .iter()
            .filter(|event| event["event"] == "transfer-progress")
            .map(|event| event["data"]["percent"].as_u64().expect("percent"))
            .collect();
        assert!(!progress.is_empty(), "progress events must flow");
        for pair in progress.windows(2) {
            assert!(
                pair[1] >= pair[0],
                "percent must be monotonic: {progress:?}"
            );
        }
        assert_eq!(
            *progress.last().expect("non-empty"),
            100,
            "final 100% tick emitted"
        );
        assert!(
            progress.len() < 200,
            "ticks must be coalesced, got {}",
            progress.len()
        );

        let done: Vec<&Value> = events
            .iter()
            .filter(|event| event["event"] == "transfer-done")
            .map(|event| &event["data"])
            .collect();
        assert_eq!(done.len(), 1, "one transfer-done: {events:?}");
        assert_eq!(done[0]["sessionId"], session_id.as_str());
        assert_eq!(done[0]["status"], "done");
        assert_eq!(
            state.pending_progress(),
            0,
            "pending map cleaned at session end"
        );
    }

    /// The peer sends response headers and one chunk but never ends the body.
    /// Cancelling must drop those reads rather than wait for the peer's EOF.
    async fn assert_stalled_response_cancelled(prepare_body: bool, status: StatusCode) {
        let started = Arc::new(tokio::sync::Notify::new());
        let (body_tx, body_rx) =
            tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(1);
        body_tx
            .send(Ok(axum::body::Bytes::from_static(b"{")))
            .await
            .expect("response prefix");
        let body_rx = Arc::new(std::sync::Mutex::new(Some(body_rx)));
        let response = {
            let started = Arc::clone(&started);
            move || {
                let started = Arc::clone(&started);
                let rx = body_rx
                    .lock()
                    .expect("body receiver")
                    .take()
                    .expect("one request");
                async move {
                    let body = axum::body::Body::from_stream(
                        tokio_stream::wrappers::ReceiverStream::new(rx),
                    );
                    let mut response = Response::new(body);
                    *response.status_mut() = status;
                    started.notify_one();
                    response
                }
            }
        };
        let app = if prepare_body {
            Router::new().route(
                &format!("{API_ROOT}/prepare-upload"),
                axum::routing::post(response),
            )
        } else {
            Router::new()
                .route(
                    &format!("{API_ROOT}/prepare-upload"),
                    axum::routing::post(prepare_ok),
                )
                .route(&format!("{API_ROOT}/upload"), axum::routing::post(response))
        }
        .route(
            &format!("{API_ROOT}/cancel"),
            axum::routing::post(|| async { StatusCode::OK }),
        );
        let port = serve(app).await;
        let (state, _dir) = test_state();
        let (session_id, run) = super::start_send(
            Arc::clone(&state),
            "127.0.0.1".into(),
            port,
            vec![SendItem::Text("cancel while reading a response".into())],
            None,
        )
        .expect("start send");
        let mut job = tokio::spawn(run);
        tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
            .await
            .expect("peer returned headers");
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(state.cancel_session(&session_id), "job still registered");
        let settled = tokio::time::timeout(std::time::Duration::from_millis(500), &mut job).await;
        if settled.is_err() {
            job.abort();
            let _ = job.await;
        }
        assert!(
            settled.is_ok(),
            "cancel must interrupt the stalled response body read"
        );
        assert_eq!(
            record_of(&state, &session_id).status,
            TransferStatus::Cancelled
        );
        assert!(
            state.jobs.lock().expect("jobs").is_empty(),
            "cancel evicts the outbound job"
        );
        assert_eq!(state.pending_progress(), 0);
        let done = events_named(&state, "transfer-done");
        assert_eq!(done.len(), 1, "one cancelled terminal event");
        assert_eq!(done[0]["status"], "cancelled");
        drop(body_tx);
    }

    #[tokio::test]
    async fn cancel_stalled_prepare_json_body() {
        assert_stalled_response_cancelled(true, StatusCode::OK).await;
    }

    #[tokio::test]
    async fn cancel_stalled_upload_error_body() {
        assert_stalled_response_cancelled(false, StatusCode::BAD_REQUEST).await;
    }

    #[tokio::test]
    async fn cancel_stalled_checksum_error_body() {
        assert_stalled_response_cancelled(false, StatusCode::UNPROCESSABLE_ENTITY).await;
    }

    #[tokio::test]
    async fn abort_cancelled_send_finalizes_once() {
        let prepared = Arc::new(tokio::sync::Notify::new());
        let app = Router::new().route(
            &format!("{API_ROOT}/prepare-upload"),
            axum::routing::post({
                let prepared = Arc::clone(&prepared);
                move || {
                    let prepared = Arc::clone(&prepared);
                    async move {
                        prepared.notify_one();
                        std::future::pending::<StatusCode>().await
                    }
                }
            }),
        );
        let port = serve(app).await;
        let (state, _dir) = test_state();
        let (session_id, run) = super::start_send(
            Arc::clone(&state),
            "127.0.0.1".into(),
            port,
            vec![SendItem::Text("abort fallback".into())],
            None,
        )
        .expect("job");
        let task = tokio::spawn(run);
        tokio::time::timeout(std::time::Duration::from_secs(2), prepared.notified())
            .await
            .expect("prepare started");
        state.report_progress(&session_id, "file", 1);
        assert!(state.cancel_session(&session_id));
        task.abort();
        let _ = task.await;
        assert_eq!(
            record_of(&state, &session_id).status,
            TransferStatus::Cancelled
        );
        assert!(state.jobs.lock().expect("jobs").is_empty());
        assert_eq!(state.pending_progress(), 0);
        let done = events_named(&state, "transfer-done");
        assert_eq!(
            done.len(),
            1,
            "abort fallback must have exactly one terminal event"
        );
        assert_eq!(done[0]["status"], "cancelled");
    }

    #[tokio::test]
    async fn cancelled_send_does_not_wait_ten_seconds_for_peer_cancel() {
        let prepared = Arc::new(tokio::sync::Notify::new());
        let app = Router::new()
            .route(
                &format!("{API_ROOT}/prepare-upload"),
                axum::routing::post({
                    let prepared = Arc::clone(&prepared);
                    move || {
                        let prepared = Arc::clone(&prepared);
                        async move {
                            prepared.notify_one();
                            std::future::pending::<StatusCode>().await
                        }
                    }
                }),
            )
            .route(
                &format!("{API_ROOT}/cancel"),
                axum::routing::post(|| async { std::future::pending::<StatusCode>().await }),
            );
        let port = serve(app).await;
        let (state, _dir) = test_state();
        let (session_id, run) = super::start_send(
            Arc::clone(&state),
            "127.0.0.1".into(),
            port,
            vec![SendItem::Text("bounded cancel".into())],
            None,
        )
        .expect("job");
        let mut task = tokio::spawn(run);
        tokio::time::timeout(std::time::Duration::from_secs(2), prepared.notified())
            .await
            .expect("prepare started");
        assert!(state.cancel_session(&session_id));
        let settled = tokio::time::timeout(std::time::Duration::from_secs(3), &mut task).await;
        if settled.is_err() {
            task.abort();
            let _ = task.await;
        }
        assert!(
            settled.is_ok(),
            "best-effort peer cancel must fit within service-stop's budget"
        );
        assert_eq!(
            record_of(&state, &session_id).status,
            TransferStatus::Cancelled
        );
        assert_eq!(events_named(&state, "transfer-done").len(), 1);
    }

    #[tokio::test]
    async fn upload_422_retries_same_token() {
        // Receiver rejects the first upload with 422 "Checksum mismatch" and
        // accepts the second: the sender must retry with the SAME token
        // (official _maxUploadAttempts) and finish Done.
        let upload_calls = Arc::new(AtomicU32::new(0));
        let tokens_seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let (calls_in_handler, tokens_in_handler) =
            (Arc::clone(&upload_calls), Arc::clone(&tokens_seen));
        let upload = move |Query(query): Query<HashMap<String, String>>, body: axum::body::Body| async move {
            tokens_in_handler
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(query.get("token").cloned().unwrap_or_default());
            // Real receivers stream the whole body BEFORE the checksum
            // comparison (official, mock peer, our own upload_stream) — a 422
            // can only be produced after the body was fully read.
            let mut body = body;
            while let Some(frame) = http_body_util::BodyExt::frame(&mut body).await {
                frame.expect("body frame");
            }
            if calls_in_handler.fetch_add(1, Ordering::SeqCst) == 0 {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({ "error": "Checksum mismatch" })),
                )
                    .into_response()
            } else {
                StatusCode::OK.into_response()
            }
        };
        let app = Router::new()
            .route(
                &format!("{API_ROOT}/prepare-upload"),
                axum::routing::post(prepare_ok),
            )
            .route(&format!("{API_ROOT}/upload"), axum::routing::post(upload));
        let port = serve(app).await;

        let temp = tempfile::tempdir().expect("temp dir");
        let file = temp.path().join("retry-me.txt");
        std::fs::write(&file, b"payload").expect("write payload");

        let (state, _dir) = test_state();
        let session_id = send_to_peer(
            Arc::clone(&state),
            "127.0.0.1".into(),
            port,
            vec![SendItem::File(file)],
            None,
        )
        .await
        .expect("send completed after the retry");

        let record = record_of(&state, &session_id);
        assert_eq!(
            record.status,
            TransferStatus::Done,
            "422 retry must end Done"
        );
        assert_eq!(record.direction, Direction::Send);
        assert_eq!(
            upload_calls.load(Ordering::SeqCst),
            2,
            "exactly one retry after the 422"
        );
        let seen = tokens_seen
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert_eq!(seen.len(), 2, "two upload attempts");
        assert_eq!(seen[0], seen[1], "the retry must reuse the SAME token");
        assert!(!seen[0].is_empty(), "token comes from the prepare response");
    }
}
