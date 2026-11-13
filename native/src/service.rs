//! Restartable network-service generations. The Tokio shell and persisted
//! receive/history store live longer than any one HTTPS/UDP generation.

use crate::crypto::{self, CertMaterial};
use crate::discovery::{self, DiscoveryShared};
use crate::event_bridge::WebEventBroadcaster;
use crate::sender::{self, SendItem, SendSessions};
use crate::server::{self, ReceiveSessions, ServerShared};
use crate::settings::{self, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::JoinHandle;

const START_TIMEOUT: Duration = Duration::from_secs(5);
const COOPERATIVE_STOP: Duration = Duration::from_secs(4);
const STOP_TIMEOUT: Duration = Duration::from_secs(11);

/// Admission and cancellation share one gate. Stop closes it before counting
/// or collecting work, so a prepare/send cannot slip into the next generation.
pub(crate) struct ServiceScope {
    pub id: u64,
    admission: Mutex<bool>,
    cancel_tx: watch::Sender<bool>,
    cancel_rx: watch::Receiver<bool>,
}

impl ServiceScope {
    pub fn new(id: u64) -> Self {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        Self {
            id,
            admission: Mutex::new(false),
            cancel_tx,
            cancel_rx,
        }
    }

    pub fn gate(&self) -> MutexGuard<'_, bool> {
        self.admission
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn admit(&self) -> Result<MutexGuard<'_, bool>, String> {
        let gate = self.gate();
        if !*gate || self.is_cancelled() {
            return Err("LocalSend service is not running".into());
        }
        Ok(gate)
    }

    pub fn cancel_locked(&self, gate: &mut bool) {
        *gate = false;
        let _ = self.cancel_tx.send(true);
    }

    pub fn cancel(&self) {
        self.cancel_locked(&mut self.gate());
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel_rx.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.cancel_rx.clone()
    }
}

/// Sticky cancellation: a waiter created after stop must also wake immediately.
pub(crate) async fn wait_cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ServiceState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceStatus {
    pub state: ServiceState,
    pub port: u16,
    pub udp_port: u16,
    pub protocol: &'static str,
    pub fingerprint: Option<String>,
    pub error: Option<String>,
    pub active_transfers: usize,
    pub revision: u64,
}

impl Default for ServiceStatus {
    fn default() -> Self {
        Self {
            state: ServiceState::Stopped,
            port: 0,
            udp_port: 0,
            protocol: "https",
            fingerprint: None,
            error: None,
            active_transfers: 0,
            revision: 0,
        }
    }
}

struct Generation {
    scope: Arc<ServiceScope>,
    handle: axum_server::Handle,
    discovery: Mutex<Option<Arc<DiscoveryShared>>>,
    sender: Mutex<Option<Arc<SendSessions>>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    outbound: Mutex<Vec<JoinHandle<()>>>,
    startup_idle: AtomicBool,
    cleanup_started: AtomicBool,
}

impl Generation {
    fn new(id: u64) -> Self {
        Self {
            scope: Arc::new(ServiceScope::new(id)),
            handle: axum_server::Handle::new(),
            discovery: Mutex::new(None),
            sender: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
            outbound: Mutex::new(Vec::new()),
            startup_idle: AtomicBool::new(false),
            cleanup_started: AtomicBool::new(false),
        }
    }

    fn sender(&self) -> Option<Arc<SendSessions>> {
        self.sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn discovery(&self) -> Option<Arc<DiscoveryShared>> {
        self.discovery
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn active_count(&self, receive: &ReceiveSessions) -> usize {
        receive.active_count()
            + self
                .sender()
                .map(|sender| sender.active_count())
                .unwrap_or(0)
    }
}

struct Inner {
    status: ServiceStatus,
    generation: Option<Arc<Generation>>,
    next_generation: u64,
    cert: Option<CertMaterial>,
    /// Startup and cleanup workers are retained as well as the network tasks.
    workers: Vec<JoinHandle<()>>,
}

pub(crate) struct ServiceController {
    inner: Mutex<Inner>,
    runtime: Handle,
    data_dir: PathBuf,
    settings: Arc<RwLock<Settings>>,
    receive: Arc<ReceiveSessions>,
    events: Arc<WebEventBroadcaster>,
}

impl ServiceController {
    pub fn new(
        runtime: Handle,
        data_dir: PathBuf,
        settings: Arc<RwLock<Settings>>,
        receive: Arc<ReceiveSessions>,
        events: Arc<WebEventBroadcaster>,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                status: ServiceStatus::default(),
                generation: None,
                next_generation: 0,
                cert: None,
                workers: Vec::new(),
            }),
            runtime,
            data_dir,
            settings,
            receive,
            events,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn refresh_active(&self, inner: &mut Inner) {
        inner.status.active_transfers = inner
            .generation
            .as_ref()
            .map(|generation| generation.active_count(&self.receive))
            .unwrap_or(0);
    }

    /// Assign the revision and enqueue under the same short lock. Sending after
    /// unlocking could publish an older revision behind a newer worker event.
    fn publish(&self, inner: &mut Inner) {
        self.refresh_active(inner);
        inner.status.revision += 1;
        self.events.send("server-status", json!(inner.status));
    }

    pub fn status(&self) -> ServiceStatus {
        let mut inner = self.lock();
        self.refresh_active(&mut inner);
        inner.status.clone()
    }

    pub fn fingerprint(&self) -> Option<String> {
        self.lock()
            .cert
            .as_ref()
            .map(|cert| cert.fingerprint.clone())
    }

    pub fn start(self: &Arc<Self>) -> Result<Value, String> {
        let mut inner = self.lock();
        match inner.status.state {
            ServiceState::Starting | ServiceState::Running => {
                self.refresh_active(&mut inner);
                return Ok(json!({ "started": true, "status": inner.status }));
            }
            ServiceState::Stopping => return Err("LocalSend service is stopping".into()),
            ServiceState::Failed if inner.generation.is_some() => {
                return Err("LocalSend service cleanup is still in progress".into());
            }
            _ => {}
        }
        inner.workers.retain(|worker| !worker.is_finished());
        inner.next_generation += 1;
        let generation = Arc::new(Generation::new(inner.next_generation));
        inner.generation = Some(Arc::clone(&generation));
        inner.status.state = ServiceState::Starting;
        inner.status.port = 0;
        inner.status.udp_port = 0;
        inner.status.error = None;
        self.publish(&mut inner);
        let response = json!({ "started": true, "status": inner.status });
        let controller = Arc::clone(self);
        inner.workers.push(self.runtime.spawn(async move {
            controller.run_start(generation).await;
        }));
        Ok(response)
    }

    pub fn stop(self: &Arc<Self>, force: bool) -> Value {
        let mut inner = self.lock();
        self.refresh_active(&mut inner);
        let Some(generation) = inner.generation.clone() else {
            return json!({ "confirmationRequired": false, "activeTransfers": inner.status.active_transfers, "status": inner.status });
        };
        if inner.status.state == ServiceState::Stopping {
            return json!({ "confirmationRequired": false, "activeTransfers": inner.status.active_transfers, "status": inner.status });
        }
        let mut gate = generation.scope.gate();
        let active = generation.active_count(&self.receive);
        inner.status.active_transfers = active;
        if !force && active > 0 {
            return json!({ "confirmationRequired": true, "activeTransfers": active, "status": inner.status });
        }
        // State and admission close before collecting cancellations or spawning
        // cleanup. The response is captured before workers can reach stopped.
        inner.status.state = ServiceState::Stopping;
        generation.scope.cancel_locked(&mut gate);
        self.publish(&mut inner);
        let response = json!({ "confirmationRequired": false, "activeTransfers": active, "status": inner.status });
        drop(gate);
        let controller = Arc::clone(self);
        inner.workers.push(self.runtime.spawn(async move {
            controller.run_stop(generation, None).await;
        }));
        response
    }

    pub fn discovery(&self) -> Option<Arc<DiscoveryShared>> {
        let inner = self.lock();
        if !matches!(
            inner.status.state,
            ServiceState::Starting | ServiceState::Running
        ) {
            return None;
        }
        inner
            .generation
            .as_ref()
            .and_then(|generation| generation.discovery())
    }

    pub fn update_settings(&self, settings: &Settings) {
        let inner = self.lock();
        if let (Some(generation), Some(cert)) = (&inner.generation, &inner.cert) {
            if let Some(discovery) = generation.discovery() {
                let mut info = discovery::local_info_from_settings(settings, &cert.fingerprint);
                info.port = inner.status.port;
                discovery.update_local_info(info);
            }
        }
    }

    pub fn cancel_send(&self, session_id: &str) -> bool {
        self.lock()
            .generation
            .as_ref()
            .and_then(|generation| generation.sender())
            .is_some_and(|sender| sender.cancel_session(session_id))
    }

    pub fn send(
        &self,
        ip: String,
        port: u16,
        items: Vec<SendItem>,
        pin: Option<String>,
    ) -> Result<String, String> {
        let inner = self.lock();
        if inner.status.state != ServiceState::Running {
            return Err("LocalSend service is not running".into());
        }
        let generation = inner
            .generation
            .as_ref()
            .ok_or("LocalSend service is not running")?;
        let sender = generation.sender().ok_or("LocalSend sender is not ready")?;
        let (id, run) = sender::start_send(sender, ip, port, items, pin)?;
        let mut outbound = generation
            .outbound
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        outbound.retain(|task| !task.is_finished());
        outbound.push(self.runtime.spawn(run));
        Ok(id)
    }

    async fn run_start(self: Arc<Self>, generation: Arc<Generation>) {
        let started = tokio::time::timeout(START_TIMEOUT, self.initialize(&generation)).await;
        let failure = match started {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("LocalSend startup timed out".into()),
        };
        generation.startup_idle.store(true, Ordering::SeqCst);
        if let Some(error) = failure {
            if !generation.scope.is_cancelled() {
                self.run_stop(generation, Some(error)).await;
            }
        }
    }

    async fn initialize(self: &Arc<Self>, generation: &Arc<Generation>) -> Result<(), String> {
        let loaded = settings::load(&self.data_dir);
        *self
            .settings
            .write()
            .unwrap_or_else(|error| error.into_inner()) = loaded.clone();
        let cert = crypto::ensure_cert(&self.data_dir)
            .map_err(|error| format!("ensure certificate: {error}"))?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        // Build TLS inline: axum_server::from_der spawns an untracked blocking
        // task. A tiny in-memory config keeps startup/unload ownership explicit.
        let key = rustls::pki_types::PrivateKeyDer::try_from(cert.key_der.clone())
            .map_err(|error| format!("TLS setup failed: {error}"))?;
        let chain = vec![rustls::pki_types::CertificateDer::from(
            cert.cert_der.clone(),
        )];
        let mut config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .map_err(|error| format!("TLS setup failed: {error}"))?;
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let config = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(config));
        let (listener, tcp_port) = server::bind_https_listener(loaded.port).map_err(|error| {
            format!(
                "HTTPS bind failed on {}..={}: {error}",
                loaded.port,
                loaded
                    .port
                    .saturating_add(discovery::PORT_FALLBACK_ATTEMPTS)
            )
        })?;
        let (socket, udp_port) =
            discovery::bind_discovery_socket(loaded.port).map_err(|error| {
                format!(
                    "UDP bind failed on {}..={}: {error}",
                    loaded.port,
                    loaded
                        .port
                        .saturating_add(discovery::PORT_FALLBACK_ATTEMPTS)
                )
            })?;
        let socket = tokio::net::UdpSocket::from_std(socket)
            .map_err(|error| format!("UDP socket: {error}"))?;
        {
            let mut inner = self.lock();
            if inner
                .generation
                .as_ref()
                .is_none_or(|current| current.scope.id != generation.scope.id)
                || inner.status.state != ServiceState::Starting
                || generation.scope.is_cancelled()
            {
                return Ok(());
            }
            inner.status.fingerprint = Some(cert.fingerprint.clone());
            inner.cert = Some(cert.clone());
            inner.status.port = tcp_port;
            inner.status.udp_port = udp_port;
            self.receive.set_scope(Arc::clone(&generation.scope));
            let mut info = discovery::local_info_from_settings(&loaded, &cert.fingerprint);
            info.port = tcp_port;
            let discovery = Arc::new(DiscoveryShared::new(info, Arc::clone(&self.events)));
            discovery
                .udp_port
                .store(udp_port, std::sync::atomic::Ordering::SeqCst);
            let sender = Arc::new(SendSessions::in_service(
                Arc::clone(&self.receive),
                Arc::clone(&self.events),
                Arc::clone(&discovery),
                Arc::clone(&generation.scope),
            ));
            *generation
                .discovery
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(Arc::clone(&discovery));
            *generation
                .sender
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(sender);
            let state = Arc::new(ServerShared::in_service(
                Arc::clone(&self.receive),
                Arc::clone(&self.settings),
                cert,
                Arc::clone(&discovery),
                Arc::clone(&generation.scope),
            ));
            let mut tasks = generation
                .tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            tasks.push(self.runtime.spawn(discovery::run_bound_discovery(
                Arc::clone(&discovery),
                socket,
                generation.scope.subscribe(),
            )));
            tasks.push(self.runtime.spawn(crate::runtime::register_loop(
                Arc::clone(&discovery),
                sender::http_client(),
                generation.scope.subscribe(),
            )));
            let controller = Arc::clone(self);
            let serve_generation = Arc::clone(generation);
            tasks.push(self.runtime.spawn(async move {
                let result = server::serve_bound(
                    state,
                    listener,
                    config,
                    serve_generation.handle.clone(),
                    serve_generation.scope.subscribe(),
                )
                .await;
                if !serve_generation.scope.is_cancelled() {
                    let error = result
                        .err()
                        .unwrap_or_else(|| "HTTPS server exited unexpectedly".into());
                    let controller = Arc::clone(&controller);
                    let generation = Arc::clone(&serve_generation);
                    let mut inner = controller.lock();
                    let worker = Arc::clone(&controller);
                    inner.workers.push(controller.runtime.spawn(async move {
                        worker.run_stop(generation, Some(error)).await;
                    }));
                }
            }));
        }
        let mut cancel = generation.scope.subscribe();
        let listening = tokio::select! {
            biased;
            _ = wait_cancelled(&mut cancel) => return Ok(()),
            address = generation.handle.listening() => address,
        };
        if listening.is_none() {
            return Err("HTTPS listener failed to start".into());
        }
        let mut inner = self.lock();
        if inner
            .generation
            .as_ref()
            .is_some_and(|current| current.scope.id == generation.scope.id)
            && inner.status.state == ServiceState::Starting
            && !generation.scope.is_cancelled()
        {
            *generation.scope.gate() = true;
            inner.status.state = ServiceState::Running;
            self.publish(&mut inner);
        }
        Ok(())
    }

    async fn run_stop(self: Arc<Self>, generation: Arc<Generation>, failure: Option<String>) {
        if generation.cleanup_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
        {
            let mut inner = self.lock();
            if inner
                .generation
                .as_ref()
                .is_none_or(|current| current.scope.id != generation.scope.id)
            {
                return;
            }
            if inner.status.state != ServiceState::Stopping {
                inner.status.state = ServiceState::Stopping;
                generation.scope.cancel();
                self.publish(&mut inner);
            }
        }
        while !generation.startup_idle.load(Ordering::SeqCst)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.receive.cancel_all();
        if let Some(sender) = generation.sender() {
            sender.cancel_all();
        }
        generation.handle.graceful_shutdown(None);
        let mut tasks = std::mem::take(
            &mut *generation
                .tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        let cooperative_deadline = (tokio::time::Instant::now() + COOPERATIVE_STOP).min(deadline);
        for task in &mut tasks {
            if task.is_finished() {
                continue;
            }
            if tokio::time::timeout_at(cooperative_deadline, &mut *task)
                .await
                .is_err()
            {
                break;
            }
        }
        let mut outbound = std::mem::take(
            &mut *generation
                .outbound
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for task in &mut outbound {
            if task.is_finished() {
                continue;
            }
            if tokio::time::timeout_at(cooperative_deadline, &mut *task)
                .await
                .is_err()
            {
                break;
            }
        }
        for task in &outbound {
            if !task.is_finished() {
                task.abort();
            }
        }
        tasks.extend(outbound);
        // A forced connection drop also drops its handler. Wait until every
        // writer/commit lease is closed first; Tokio filesystem futures may
        // retain a blocking writer even after their async wrapper is dropped.
        while !self.receive.writers_idle() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        if self.receive.writers_idle() {
            // Graceful is already sticky; shutdown drops remaining metadata/
            // keep-alive requests. Read connection_count after the server exits.
            generation.handle.shutdown();
        }
        // Do not abort the outer axum task: its accepted connections are owned
        // separately. Its Handle closes them and we also wait connection_count.
        loop {
            if tasks.iter().all(JoinHandle::is_finished)
                && generation.handle.connection_count() == 0
            {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let tasks_idle = generation.startup_idle.load(Ordering::SeqCst)
            && tasks.iter().all(JoinHandle::is_finished)
            && generation.handle.connection_count() == 0;
        let drained = if tasks_idle {
            tokio::time::timeout_at(deadline, self.receive.drain())
                .await
                .map_err(|_| "LocalSend receive cleanup timed out".to_string())
                .and_then(|result| result)
        } else {
            Err("LocalSend stop timed out waiting for network tasks/connections".into())
        };
        let mut inner = self.lock();
        if inner
            .generation
            .as_ref()
            .is_none_or(|current| current.scope.id != generation.scope.id)
        {
            return;
        }
        match drained {
            Ok(()) => {
                inner.generation = None;
                inner.status.state = if failure.is_some() {
                    ServiceState::Failed
                } else {
                    ServiceState::Stopped
                };
                inner.status.port = 0;
                inner.status.udp_port = 0;
                inner.status.error = failure;
            }
            Err(error) => {
                // Keep the generation and advertised ports: failure must never
                // claim that a socket/writer still held by a task was released.
                generation
                    .tasks
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .extend(tasks);
                inner.status.state = ServiceState::Failed;
                inner.status.error = Some(error);
            }
        }
        self.publish(&mut inner);
        generation.cleanup_started.store(false, Ordering::SeqCst);
    }

    /// Internal unload waits outside the global Slot lock, without asking for
    /// confirmation. The owner then drops the long-lived Tokio shell.
    pub async fn shutdown(self: &Arc<Self>) {
        self.stop(true);
        loop {
            let workers = {
                let mut inner = self.lock();
                std::mem::take(&mut inner.workers)
            };
            if workers.is_empty() {
                break;
            }
            for worker in workers {
                let _ = worker.await;
            }
        }
        let generation = self.lock().generation.clone();
        if let Some(generation) = generation {
            generation.scope.cancel();
            generation.handle.shutdown();
            for task in generation
                .tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
            {
                task.abort();
            }
            for task in generation
                .outbound
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
            {
                task.abort();
            }
        }
    }
}
