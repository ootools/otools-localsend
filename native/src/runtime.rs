use crate::discovery::{DeviceEntry, DiscoveryShared};
use crate::event_bridge::WebEventBroadcaster;
use crate::file_resources::{FileResources, ResourceOperation};
use crate::models::{Direction, RegisterResponse};
use crate::sender::{self, SendItem};
use crate::server::{self, ReceiveSessions};
use crate::service::{wait_cancelled, ServiceController};
use crate::settings::{self, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tokio::runtime::{Builder, Runtime};

static PLUGIN: OnceLock<Mutex<Slot>> = OnceLock::new();

enum Slot {
    Empty,
    /// Boxed: PluginRuntime is large (the tokio runtime dominates) and the
    /// tiny Empty/Retired variants must not inflate every Slot access.
    Running(Box<PluginRuntime>),
    Retired,
}

struct PluginRuntime {
    runtime: Runtime,
    data_dir: PathBuf,
    home_dir: PathBuf,
    resources: Arc<FileResources>,
    service: Arc<ServiceController>,
    /// Native→frontend event queue. Shared as `Arc` so background workers
    /// spawned on the runtime can emit events without touching the plugin
    /// slot mutex.
    broadcaster: Arc<WebEventBroadcaster>,
    /// Live settings snapshot the server reads (pin, auto_save, download dir).
    settings_snapshot: Arc<RwLock<Settings>>,
    /// Receive-session state machine + transfer history survives service stop.
    receive: Arc<ReceiveSessions>,
}

impl PluginRuntime {
    fn new() -> Result<Self, String> {
        let home = directories::BaseDirs::new()
            .ok_or("could not resolve the user home directory")?
            .home_dir()
            .to_path_buf();
        Self::new_with_home(settings::resolve_data_dir()?, home)
    }

    #[cfg(test)]
    fn new_at(data_dir: PathBuf) -> Result<Self, String> {
        let home = data_dir.join("home");
        Self::new_with_home(data_dir, home)
    }

    fn new_with_home(data_dir: PathBuf, home_dir: PathBuf) -> Result<Self, String> {
        let runtime = Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("otools-localsend")
            .enable_all()
            .build()
            .map_err(|error| format!("tokio runtime: {error}"))?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("create data dir {}: {error}", data_dir.display()))?;
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let settings_snapshot = Arc::new(RwLock::new(
            settings::load(&data_dir).for_runtime(&home_dir)?,
        ));
        let resources = Arc::new(FileResources::new(&data_dir)?);
        let receive = Arc::new(
            ReceiveSessions::new(&data_dir, Arc::clone(&broadcaster))
                .map_err(|error| format!("receive sessions: {error}"))?,
        );
        let service = Arc::new(ServiceController::new_with_home(
            runtime.handle().clone(),
            data_dir.clone(),
            home_dir.clone(),
            Arc::clone(&settings_snapshot),
            Arc::clone(&receive),
            Arc::clone(&broadcaster),
        ));
        Ok(Self {
            runtime,
            data_dir,
            home_dir,
            resources,
            service,
            broadcaster,
            settings_snapshot,
            receive,
        })
    }

    fn shutdown(self) {
        // The caller has already released Slot. Cancel/drain service ownership
        // first, then dropping Tokio joins its workers before DLL unload.
        self.resources.shutdown();
        self.runtime.block_on(self.service.shutdown());
        drop(self.runtime);
    }
}

pub fn invoke(method: &str, payload: Value) -> Result<Value, String> {
    let lock = PLUGIN.get_or_init(|| Mutex::new(Slot::Empty));
    if method == "poll_events" {
        // Must never block behind initialization or retirement, and the slot
        // mutex must stay short-held: only clone the broadcaster Arc here.
        // The actual drain takes the broadcaster's own lock (a cheap
        // VecDeque take), and payload serialization happens later in
        // `handle_json`, outside every mutex.
        let broadcaster = {
            let guard = lock.lock().unwrap_or_else(|error| error.into_inner());
            match &*guard {
                Slot::Running(plugin) => Some(Arc::clone(&plugin.broadcaster)),
                _ => None,
            }
        };
        let events = broadcaster
            .map(|broadcaster| broadcaster.drain())
            .unwrap_or_default();
        return Ok(json!({ "events": events }));
    }
    if method == "server_status" {
        // Only clone the controller under Slot; status and cleanup synchronize
        // on their own short lock, never a wait with the global mutex held.
        let service = {
            let guard = lock.lock().unwrap_or_else(|error| error.into_inner());
            match &*guard {
                Slot::Running(plugin) => Some(Arc::clone(&plugin.service)),
                Slot::Retired => return Err("plugin retired".into()),
                Slot::Empty => None,
            }
        };
        return Ok(service
            .map(|service| json!(service.status()))
            .unwrap_or_else(|| json!(crate::service::ServiceStatus::default())));
    }
    if method == "__otools_shutdown__" {
        let plugin = {
            let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
            match std::mem::replace(&mut *guard, Slot::Retired) {
                Slot::Running(plugin) => Some(plugin),
                _ => None,
            }
        };
        if let Some(plugin) = plugin {
            plugin.shutdown();
        }
        return Ok(Value::Null);
    }
    let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    if matches!(*guard, Slot::Retired) {
        return Err("plugin retired".into());
    }
    let plugin = ensure_running(&mut guard)?;
    if is_resource_method(method) {
        let operation = plugin.resources.enter()?;
        let receive = Arc::clone(&plugin.receive);
        drop(guard);
        return invoke_resource(&operation, &receive, method, payload);
    }
    invoke_plugin(plugin, method, payload)
}

fn is_resource_method(method: &str) -> bool {
    matches!(
        method,
        "file_preview" | "prepare_image_copy" | "release_image_copy" | "resolve_transfer_file"
    )
}

fn resource_path(
    sessions: &ReceiveSessions,
    payload: &Value,
    allow_path: bool,
) -> Result<(PathBuf, Option<u64>), String> {
    let has_path = payload.get("path").is_some();
    let has_reference = payload.get("sessionId").is_some() || payload.get("fileId").is_some();
    if has_path {
        if !allow_path || has_reference {
            return Err("use exactly one local path or transfer reference".into());
        }
        return payload
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|path| (PathBuf::from(path), None))
            .ok_or_else(|| "payload.path must be a local file path".into());
    }
    let session_id = require_session_id(payload)?;
    let file_id = payload
        .get("fileId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("payload.fileId is required")?;
    let record = sessions
        .transfer_records()
        .into_iter()
        .find(|record| record.session_id == session_id)
        .ok_or("transfer file is unavailable")?;
    let entry = record
        .files
        .iter()
        .find(|file| file.id == file_id)
        .ok_or("transfer file is unavailable")?;
    let paths = match record.direction {
        Direction::Send => &record.sources,
        Direction::Receive => &record.destinations,
    };
    paths
        .get(file_id)
        .filter(|path| !path.is_empty())
        .map(|path| (PathBuf::from(path), Some(entry.size)))
        .ok_or_else(|| "transfer file is unavailable".into())
}

fn invoke_resource(
    operation: &ResourceOperation,
    sessions: &ReceiveSessions,
    method: &str,
    payload: Value,
) -> Result<Value, String> {
    if method == "release_image_copy" {
        let id = payload
            .get("resourceId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("payload.resourceId is required")?;
        operation.release_image_copy(id)?;
        return Ok(json!({}));
    }
    let (path, expected_size) =
        match resource_path(sessions, &payload, method != "resolve_transfer_file") {
            Ok(path) => path,
            Err(_) if method == "file_preview" => {
                return Ok(json!({"status":"unavailable", "reason":"not-received"}))
            }
            Err(error) => return Err(error),
        };
    if let Some(size) = expected_size {
        if let Err(error) = operation.resolve_file_with_size(&path, size) {
            if method == "file_preview" {
                return Ok(json!({"status":"unavailable", "reason":"unavailable"}));
            }
            return Err(error);
        }
    }
    match method {
        "file_preview" => {
            serde_json::to_value(operation.preview(&path)).map_err(|error| error.to_string())
        }
        "prepare_image_copy" => serde_json::to_value(operation.prepare_image_copy(&path)?)
            .map_err(|error| error.to_string()),
        "resolve_transfer_file" => Ok(json!({"path": operation.resolve_file(&path)?})),
        _ => Err(format!("unknown method: {method}")),
    }
}

fn invoke_plugin(
    plugin: &mut PluginRuntime,
    method: &str,
    payload: Value,
) -> Result<Value, String> {
    if is_resource_method(method) {
        return invoke_resource(&plugin.resources.enter()?, &plugin.receive, method, payload);
    }
    // FFI dispatch has no Tokio context; asynchronous receiver cleanup must
    // still spawn on this plugin's long-lived shell, without waiting here.
    let _runtime = plugin.runtime.enter();
    match method {
        "resolve_download_directory" => {
            let value = match payload.get("path") {
                None | Some(Value::Null) => None,
                Some(Value::String(path)) => Some(path.as_str()),
                Some(_) => return Err("payload.path must be a directory string".into()),
            };
            Ok(json!({"path": settings::resolve_download_dir(value, &plugin.home_dir)?}))
        }
        "settings_get" => {
            let loaded = settings::load(&plugin.data_dir);
            serde_json::to_value(loaded).map_err(|error| error.to_string())
        }
        "settings_set" => {
            let value = payload
                .get("settings")
                .filter(|value| value.is_object())
                .ok_or("payload.settings object is required")?;
            let update: Settings = serde_json::from_value(value.clone())
                .map_err(|error| format!("invalid settings: {error}"))?;
            let update = update.normalized();
            let runtime_settings = update.for_runtime(&plugin.home_dir)?;
            update
                .save(&plugin.data_dir)
                .map_err(|error| format!("save settings: {error}"))?;
            *plugin
                .settings_snapshot
                .write()
                .unwrap_or_else(|error| error.into_inner()) = runtime_settings.clone();
            plugin.service.update_settings(&runtime_settings);
            serde_json::to_value(update).map_err(|error| error.to_string())
        }
        "start_localsend" => plugin.service.start(),
        "stop_localsend" => {
            let force = match payload.get("force") {
                None => false,
                Some(Value::Bool(force)) => *force,
                Some(_) => return Err("payload.force must be a boolean".into()),
            };
            Ok(plugin.service.stop(force))
        }
        "device_list" => {
            let shared = plugin.service.discovery();
            let (devices, udp_port) = shared
                .map(|shared| (shared.devices.list(), shared.udp_port()))
                .unwrap_or_default();
            Ok(json!({ "devices": devices, "udpPort": udp_port }))
        }
        "discover_now" => {
            // No-op (still ok) before start_background: there is no socket to
            // announce on yet.
            if let Some(shared) = plugin.service.discovery() {
                shared.request_announce();
            }
            Ok(json!({ "ok": true }))
        }
        "session_accept" => {
            let session_id = require_session_id(&payload)?;
            let file_ids = match payload.get("fileIds") {
                None => None,
                Some(Value::Array(list)) => Some(
                    list.iter()
                        .map(|value| {
                            value
                                .as_str()
                                .filter(|value| !value.is_empty())
                                .map(str::to_string)
                                .ok_or_else(|| {
                                    "payload.fileIds must contain non-empty strings".to_string()
                                })
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                Some(_) => return Err("payload.fileIds must be an array".into()),
            };
            let destinations: HashMap<String, String> = match payload.get("destinations") {
                None => HashMap::new(),
                Some(Value::Object(map)) => map
                    .iter()
                    .map(|(id, value)| {
                        value
                            .as_str()
                            .filter(|value| !value.is_empty())
                            .map(|path| (id.clone(), path.to_string()))
                            .ok_or_else(|| {
                                "payload.destinations must contain local path strings".to_string()
                            })
                    })
                    .collect::<Result<_, _>>()?,
                Some(_) => return Err("payload.destinations must be an object".into()),
            };
            let accepted = server::session_accept_with_destinations(
                &plugin.receive,
                &session_id,
                file_ids,
                destinations,
            )?;
            Ok(json!({ "accepted": accepted }))
        }
        "session_decline" => {
            let session_id = require_session_id(&payload)?;
            server::session_decline(&plugin.receive, &session_id)?;
            Ok(json!({}))
        }
        "session_cancel" => {
            let session_id = require_session_id(&payload)?;
            // Outbound jobs first: an in-flight send aborts its uploads and
            // notifies the peer via POST /cancel, then finalizes its record.
            if plugin.service.cancel_send(&session_id) {
                return Ok(json!({}));
            }
            server::session_cancel(&plugin.receive, &session_id)?;
            Ok(json!({}))
        }
        "send_files" => {
            let protocol = optional_protocol(&payload)?;
            let ip = require_ip(&payload)?;
            let port = require_port(&payload)?;
            let files = payload
                .get("files")
                .and_then(Value::as_array)
                .filter(|list| !list.is_empty())
                .ok_or("payload.files must be a non-empty array")?;
            let mut items = Vec::with_capacity(files.len());
            for file in files {
                let path = file
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or("each files[] entry needs a non-empty path")?;
                items.push(SendItem::File(PathBuf::from(path)));
            }
            let pin = payload
                .get("pin")
                .and_then(Value::as_str)
                .map(str::to_string);
            // Spawn and answer immediately: the session id is generated
            // locally and the job registered synchronously by `start_send`.
            let session_id = plugin.service.send(ip, port, protocol, items, pin)?;
            Ok(json!({ "sessionId": session_id }))
        }
        "send_text" => {
            let protocol = optional_protocol(&payload)?;
            let ip = require_ip(&payload)?;
            let port = require_port(&payload)?;
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or("payload.text must be a non-empty string")?
                .to_string();
            let pin = payload
                .get("pin")
                .and_then(Value::as_str)
                .map(str::to_string);
            let session_id =
                plugin
                    .service
                    .send(ip, port, protocol, vec![SendItem::Text(text)], pin)?;
            Ok(json!({ "sessionId": session_id }))
        }
        "transfer_list" => Ok(json!({
            "transfers": server::transfer_records(&plugin.receive),
        })),
        "server_status" => Ok(json!(plugin.service.status())),
        _ => Err(format!("unknown method: {method}")),
    }
}

fn optional_protocol(payload: &Value) -> Result<Option<String>, String> {
    match payload.get("protocol") {
        None => Ok(None),
        Some(Value::String(protocol)) => {
            sender::validate_protocol(protocol).map(|protocol| Some(protocol.into()))
        }
        Some(_) => Err("payload.protocol must be http or https".into()),
    }
}

fn require_session_id(payload: &Value) -> Result<String, String> {
    payload
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or("payload.sessionId is required".to_string())
}

fn require_ip(payload: &Value) -> Result<String, String> {
    payload
        .get("ip")
        .and_then(Value::as_str)
        .filter(|ip| !ip.is_empty())
        .map(str::to_string)
        .ok_or("payload.ip is required".to_string())
}

fn require_port(payload: &Value) -> Result<u16, String> {
    let port = payload
        .get("port")
        .and_then(Value::as_u64)
        .ok_or("payload.port is required")?;
    if port == 0 || port > u16::MAX as u64 {
        return Err(format!("payload.port out of range: {port}"));
    }
    Ok(port as u16)
}

/// Autostart entry: ensure the runtime exists, generate or load the instance
/// certificate, then spawn-and-return the background shell with the UDP
/// discovery loop and the HTTPS v2 server attached.
pub fn start_background() -> Result<(), String> {
    let lock = PLUGIN.get_or_init(|| Mutex::new(Slot::Empty));
    let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    start_background_locked(&mut guard)
}

/// [`start_background`] core, callable both with a freshly acquired guard and
/// from the `start_localsend` dispatch (which already holds the slot mutex —
/// std Mutex is not reentrant, so it must never lock again here).
fn start_background_locked(guard: &mut Slot) -> Result<(), String> {
    if matches!(*guard, Slot::Retired) {
        return Err("plugin retired".into());
    }
    let plugin = ensure_running(guard)?;
    start_plugin(plugin)
}

fn start_plugin(plugin: &mut PluginRuntime) -> Result<(), String> {
    plugin.service.start().map(|_| ())
}

/// Answer the register replies queued by the discovery loop (Task 9 wiring):
/// every `announce: true` frame is replied to over HTTP with
/// `POST /api/localsend/v2/register` to its origin, and the response's peer
/// DeviceInfo is upserted into the device table. This keeps discovery
/// symmetric: a peer whose UDP socket fell back off 53317 cannot hear our
/// announcements, but it still receives this POST and — through the upsert —
/// we keep a fresh view of it even without its UDP frames.
pub(crate) async fn register_loop(
    shared: Arc<DiscoveryShared>,
    client: reqwest::Client,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let run = async {
        loop {
            for (ip, port, protocol, our_info) in shared.take_register_replies() {
                if port == 0 {
                    // A peer announcing port 0 has no HTTPS listener (send-only
                    // announce); there is nothing to register against.
                    continue;
                }
                let url = format!("{protocol}://{ip}:{port}{}/register", sender::API_ROOT);
                let result = client
                    .post(&url)
                    .json(&our_info)
                    .timeout(sender::SHORT_REQUEST_TIMEOUT)
                    .send()
                    .await;
                match result {
                    Ok(response) if response.status().as_u16() == 200 => {
                        match response.json::<RegisterResponse>().await {
                            Ok(response_info) => match ip.parse::<IpAddr>() {
                                Ok(source_ip) => {
                                    let info =
                                        response_info.into_device_info(port, protocol.into());
                                    let is_new = shared.devices.upsert(info.clone(), source_ip);
                                    if is_new {
                                        let entry = serde_json::to_value(DeviceEntry {
                                            info,
                                            ip: ip.clone(),
                                            last_seen_ms: 0,
                                        })
                                        .unwrap_or_else(|_| json!({ "ip": ip }));
                                        shared.event.send("device-found", entry);
                                    }
                                }
                                Err(error) => {
                                    eprintln!("otools-localsend register: source ip {ip}: {error}")
                                }
                            },
                            Err(error) => {
                                eprintln!(
                                    "otools-localsend register: decode from {ip}:{port}: {error}"
                                )
                            }
                        }
                    }
                    Ok(response) => {
                        eprintln!(
                            "otools-localsend register: {ip}:{port} answered {}",
                            response.status()
                        );
                    }
                    Err(error) => {
                        eprintln!("otools-localsend register: POST {ip}:{port}: {error}");
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    };
    tokio::select! {
        biased;
        _ = wait_cancelled(&mut cancel) => {},
        _ = run => {},
    }
}

/// SHA-256 fingerprint (hex) of the instance certificate once the background
/// shell has started; None before start or after retirement. Tasks 6/7 read
/// the full [`CertMaterial`] from the runtime state instead.
pub fn cert_fingerprint() -> Option<String> {
    let lock = PLUGIN.get_or_init(|| Mutex::new(Slot::Empty));
    let guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    match &*guard {
        Slot::Running(plugin) => plugin.service.fingerprint(),
        _ => None,
    }
}

fn ensure_running(guard: &mut Slot) -> Result<&mut PluginRuntime, String> {
    if matches!(*guard, Slot::Empty) {
        *guard = Slot::Running(Box::new(PluginRuntime::new()?));
    }
    match guard {
        Slot::Running(plugin) => Ok(plugin),
        _ => Err("plugin is not running".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{invoke_plugin, PluginRuntime};
    use crate::server;
    use crate::settings::Settings;
    use serde_json::{json, Value};
    use std::net::{Ipv4Addr, TcpListener, UdpSocket};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    static FIXED_PORT_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn local_plugin() -> (PluginRuntime, tempfile::TempDir) {
        let temp = tempfile::tempdir().expect("temp dir");
        Settings {
            port: 0,
            ..Default::default()
        }
        .save(temp.path())
        .expect("settings");
        (
            PluginRuntime::new_at(temp.path().to_path_buf()).expect("runtime"),
            temp,
        )
    }

    fn call(plugin: &mut PluginRuntime, method: &str, payload: Value) -> Value {
        invoke_plugin(plugin, method, payload).unwrap_or_else(|error| panic!("{method}: {error}"))
    }

    fn wait_state(plugin: &mut PluginRuntime, state: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let status = call(plugin, "server_status", json!({}));
            if status["state"] == state {
                return status;
            }
            assert!(Instant::now() < deadline, "never reached {state}: {status}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn assert_snapshot(status: &Value) {
        let mut keys: Vec<&str> = status
            .as_object()
            .expect("status object")
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
        assert!(matches!(
            status["state"].as_str(),
            Some("stopped" | "starting" | "running" | "stopping" | "failed")
        ));
        assert_eq!(status["protocol"], "https");
        assert!(status["port"]
            .as_u64()
            .is_some_and(|port| port <= u16::MAX as u64));
        assert!(status["udpPort"]
            .as_u64()
            .is_some_and(|port| port <= u16::MAX as u64));
        assert!(status["revision"].is_u64());
        assert!(status["activeTransfers"].is_u64());
        assert!(status["fingerprint"].is_null() || status["fingerprint"].is_string());
        assert!(status["error"].is_null() || status["error"].is_string());
    }

    fn ports_bindable(status: &Value) {
        let tcp = status["port"].as_u64().expect("TCP port") as u16;
        let udp = status["udpPort"].as_u64().expect("UDP port") as u16;
        assert_ne!(tcp, 0);
        assert_ne!(udp, 0);
        let _tcp = TcpListener::bind((Ipv4Addr::UNSPECIFIED, tcp)).expect("old TCP port released");
        let _udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, udp)).expect("old UDP port released");
    }

    #[test]
    fn runtime_resource_lookup_requires_real_history_file_and_preserves_legacy_records() {
        let (mut plugin, temp) = local_plugin();
        let path = temp.path().join("resource.pdf");
        std::fs::write(&path, b"fixture").expect("file");
        let record = serde_json::from_value(json!({
            "sessionId":"resource-session", "direction":"Send", "peerAlias":"fixture",
            "status":"Done", "createdAt":1,
            "files":[{"id":"f", "fileName":"resource.pdf", "size":7, "fileType":"application/pdf"}],
            "sources":{"f":path}
        }))
        .expect("new history");
        plugin.receive.upsert_send_record(record);
        let result = invoke_plugin(
            &mut plugin,
            "resolve_transfer_file",
            json!({"sessionId":"resource-session","fileId":"f"}),
        );
        assert!(
            result.is_ok(),
            "local resource query not implemented: {result:?}"
        );
        assert_eq!(
            std::fs::canonicalize(PathBuf::from(result.unwrap()["path"].as_str().unwrap()))
                .unwrap(),
            std::fs::canonicalize(&path).unwrap()
        );
        assert!(invoke_plugin(
            &mut plugin,
            "resolve_transfer_file",
            json!({"sessionId":"resource-session","fileId":"missing"})
        )
        .is_err());
        assert!(invoke_plugin(
            &mut plugin,
            "resolve_transfer_file",
            json!({"sessionId":"unknown","fileId":"f"})
        )
        .is_err());
        assert!(invoke_plugin(
            &mut plugin,
            "resolve_transfer_file",
            json!({"sessionId":"resource-session","fileId":"f","path":path})
        )
        .is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(invoke_plugin(
            &mut plugin,
            "resolve_transfer_file",
            json!({"sessionId":"resource-session","fileId":"f"})
        )
        .is_err());
        plugin.shutdown();
    }

    #[test]
    fn history_resource_rejects_replaced_size_for_receive_and_send_references() {
        let (mut plugin, temp) = local_plugin();
        let path = temp.path().join("original.pdf");
        std::fs::write(&path, b"original").unwrap();
        for direction in ["Receive", "Send"] {
            let record = serde_json::from_value(json!({
                "sessionId":direction,"direction":direction,"peerAlias":"fixture","status":"Done","createdAt":1,
                "files":[{"id":"f","fileName":"original.pdf","size":8,"fileType":"application/pdf"}],
                "destinations":if direction == "Receive" {json!({"f":path})} else {json!({})},
                "sources":if direction == "Send" {json!({"f":path})} else {json!({})}
            })).unwrap();
            plugin.receive.upsert_send_record(record);
        }
        std::fs::write(&path, b"replacement changed size").unwrap();
        for direction in ["Receive", "Send"] {
            assert!(
                invoke_plugin(
                    &mut plugin,
                    "resolve_transfer_file",
                    json!({"sessionId":direction,"fileId":"f"})
                )
                .is_err(),
                "history returned a changed-size replacement as the transferred file"
            );
            let preview = invoke_plugin(
                &mut plugin,
                "file_preview",
                json!({"sessionId":direction,"fileId":"f"}),
            )
            .unwrap();
            assert_eq!(preview["status"], "unavailable");
        }
        plugin.shutdown();
    }

    #[test]
    fn runtime_settings_expand_default_against_fixture_home_and_reject_relative_save_directory() {
        let (mut plugin, temp) = local_plugin();
        call(
            &mut plugin,
            "settings_set",
            json!({"settings":{"port":0,"downloadDir":null}}),
        );
        let settings = call(&mut plugin, "settings_get", json!({}));
        assert_eq!(settings["downloadDir"], "~/Download/OToolsLocalSend");
        let runtime_dir = plugin
            .settings_snapshot
            .read()
            .unwrap()
            .download_dir
            .clone()
            .unwrap();
        assert_eq!(
            PathBuf::from(runtime_dir),
            temp.path()
                .join("home")
                .join("Download")
                .join("OToolsLocalSend")
        );
        assert!(
            !temp.path().join("home").exists(),
            "settings query created the download tree"
        );
        let resolved = invoke_plugin(
            &mut plugin,
            "resolve_download_directory",
            json!({"path":"~/Download/OToolsLocalSend"}),
        );
        assert!(
            resolved.is_ok(),
            "default picker directory resolution missing: {resolved:?}"
        );
        assert_eq!(
            PathBuf::from(resolved.unwrap()["path"].as_str().unwrap()),
            temp.path()
                .join("home")
                .join("Download")
                .join("OToolsLocalSend")
        );
        assert!(invoke_plugin(
            &mut plugin,
            "settings_set",
            json!({"settings":{"downloadDir":"relative/download"}})
        )
        .is_err());
        plugin.shutdown();
    }

    #[test]
    fn malformed_accept_file_ids_do_not_resolve_pending_request() {
        use crate::models::{DeviceInfo, FileEntry, TransferStatus};
        let (mut plugin, _temp) = local_plugin();
        let info = DeviceInfo {
            alias: "fixture".into(),
            version: "2.2".into(),
            device_model: None,
            device_type: None,
            fingerprint: "peer".into(),
            port: 53317,
            protocol: "https".into(),
            download: false,
        };
        let file = FileEntry {
            id: "f".into(),
            file_name: "image.png".into(),
            size: 7,
            file_type: "image/png".into(),
            sha256: None,
            preview: None,
            metadata: None,
        };
        let settings = plugin.settings_snapshot.read().unwrap().clone();
        let prepared = server::prepare_upload(
            &plugin.receive,
            &settings,
            info,
            std::collections::HashMap::from([("f".into(), file)]),
            None,
            "127.0.0.1".parse().unwrap(),
        );
        let server::PrepareOutcome::AwaitDecision {
            session_id: id,
            decision_rx: _decision,
        } = prepared
        else {
            panic!("manual Pending expected")
        };
        assert!(invoke_plugin(
            &mut plugin,
            "session_accept",
            json!({"sessionId":id,"fileIds":"all"})
        )
        .is_err());
        assert!(invoke_plugin(
            &mut plugin,
            "session_accept",
            json!({"sessionId":id,"fileIds":[9]})
        )
        .is_err());
        assert!(invoke_plugin(
            &mut plugin,
            "session_accept",
            json!({"sessionId":id,"destinations":{"f":9}})
        )
        .is_err());
        assert_eq!(
            plugin.receive.transfer_records()[0].status,
            TransferStatus::Pending
        );
        plugin.shutdown();
    }

    #[test]
    fn default_receive_directory_remains_expanded_across_start_and_restart() {
        let (mut plugin, temp) = local_plugin();
        call(
            &mut plugin,
            "settings_set",
            json!({"settings":{"port":0,"autoSave":true,"downloadDir":null}}),
        );
        let expected = temp
            .path()
            .join("home")
            .join("Download")
            .join("OToolsLocalSend");
        for index in 0..2 {
            call(&mut plugin, "start_localsend", json!({}));
            wait_state(&mut plugin, "running");
            let loaded = plugin.settings_snapshot.read().unwrap().clone();
            assert_eq!(
                loaded.download_dir.as_deref(),
                expected.to_str(),
                "startup replaced the expanded default directory"
            );
            let client = crate::sender::http_client(None).unwrap();
            let port = plugin.service.status().port;
            let file_name = format!("default-receive-{index}.txt");
            let response = plugin.runtime.block_on(async {
                let prepared = client.post(format!("https://127.0.0.1:{port}/api/localsend/v2/prepare-upload"))
                    .json(&json!({"info":{"alias":"fixture","version":"2.2","fingerprint":"default-fixture","port":53317,"protocol":"https"},
                        "files":{"f":{"id":"f","fileName":file_name,"size":7,"fileType":"text/plain"}}}))
                    .send().await.unwrap().json::<Value>().await.unwrap();
                let status = client.post(format!("https://127.0.0.1:{port}/api/localsend/v2/upload"))
                    .query(&[("sessionId",prepared["sessionId"].as_str().unwrap()),("fileId","f"),("token",prepared["files"]["f"].as_str().unwrap())])
                    .body("fixture").send().await.unwrap().status().as_u16();
                (status, prepared["sessionId"].as_str().unwrap().to_string())
            });
            assert_eq!(response.0, 200);
            assert_eq!(
                std::fs::read(expected.join(&file_name)).unwrap(),
                b"fixture"
            );
            let record = plugin
                .receive
                .transfer_records()
                .into_iter()
                .find(|record| record.session_id == response.1)
                .unwrap();
            assert_eq!(
                PathBuf::from(&record.destinations["f"]),
                expected.join(&file_name)
            );
            call(&mut plugin, "stop_localsend", json!({}));
            wait_state(&mut plugin, "stopped");
        }
        plugin.shutdown();
    }

    #[test]
    fn official_prepare_without_download_reaches_real_handler() {
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let port = running["port"].as_u64().unwrap();
        let client = crate::sender::http_client(None).expect("test HTTP client");
        // Literal protocol fixture, not serialized from our own DTO.
        let request = plugin.runtime.spawn(async move {
            client
                .post(format!("https://127.0.0.1:{port}/api/localsend/v2/prepare-upload"))
                .json(&json!({
                    "info": {"alias": "Official fixture", "version": "2.2", "fingerprint": "fixture",
                        "port": 53317, "protocol": "https"},
                    "files": {"f": {"id": "f", "fileName": "fixture.txt", "size": 12,
                        "fileType": "text/plain"}}
                }))
                .send().await.expect("prepare response").status().as_u16()
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while plugin.receive.active_count() == 0
            && !request.is_finished()
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        let records = plugin.receive.transfer_records();
        if let Some(record) = records.first() {
            call(
                &mut plugin,
                "session_accept",
                json!({"sessionId": record.session_id, "fileIds": []}),
            );
        }
        call(&mut plugin, "stop_localsend", json!({"force": true}));
        wait_state(&mut plugin, "stopped");
        let status = plugin.runtime.block_on(request).expect("request task");
        plugin.shutdown();
        assert_eq!(
            status, 204,
            "valid omitted download must reach manual acceptance, not JSON rejection"
        );
        assert_eq!(records.len(), 1, "actual handler stored a session");
        assert_eq!(records[0].status, crate::models::TransferStatus::Pending);
    }

    #[test]
    fn register_and_info_respond_with_official_minimal_fields() {
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let port = running["port"].as_u64().unwrap();
        let client = crate::sender::http_client(None).expect("test HTTP client");
        let responses = plugin.runtime.block_on(async {
            let register = client.post(format!("https://127.0.0.1:{port}/api/localsend/v2/register"))
                .json(&json!({"alias":"Official peer", "version":"2.1", "fingerprint":"peer", "port":53317,
                    "protocol":"https", "download":false})).send().await.expect("register")
                .json::<Value>().await.expect("register JSON");
            let info = client.get(format!("https://127.0.0.1:{port}/api/localsend/v2/info"))
                .send().await.expect("info").json::<Value>().await.expect("info JSON");
            [register, info]
        });
        plugin.shutdown();
        for response in responses {
            assert!(response["alias"].is_string());
            assert_eq!(response["version"], "2.2");
            assert!(response["fingerprint"].is_string());
            assert_eq!(response["download"], false);
            assert!(
                response.get("port").is_none(),
                "official response uses the known target port"
            );
            assert!(
                response.get("protocol").is_none(),
                "official response uses the known target protocol"
            );
        }
    }

    #[tokio::test]
    async fn official_register_response_merges_contacted_port_and_protocol() {
        use crate::discovery::DiscoveryShared;
        use crate::event_bridge::WebEventBroadcaster;
        use crate::test_peer::{Peer, Response};
        let peer = Peer::https(None, |request| {
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/api/localsend/v2/register");
            Response::json(
                200,
                r#"{"alias":"Official 1.17 fixture","version":"2.1","fingerprint":"official","download":false}"#,
            )
        });
        let our_info = crate::discovery::local_info_from_settings(&Settings::default(), "local");
        let shared = Arc::new(DiscoveryShared::new(
            our_info.clone(),
            Arc::new(WebEventBroadcaster::new()),
        ));
        shared.queue_register_reply("127.0.0.1".into(), peer.port, "https", our_info);
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let run = tokio::spawn(super::register_loop(
            Arc::clone(&shared),
            crate::sender::http_client(None).expect("test HTTP client"),
            cancel_rx,
        ));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while shared.devices.list().is_empty() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cancel_tx.send(true).unwrap();
        run.await.expect("register loop stopped");
        let devices = shared.devices.list();
        assert_eq!(
            devices.len(),
            1,
            "official minimal response must decode without port/protocol"
        );
        assert_eq!(devices[0].info.alias, "Official 1.17 fixture");
        assert_eq!(
            devices[0].info.port, peer.port,
            "retain contacted fallback port, not 53317/0"
        );
        assert_eq!(devices[0].info.protocol, "https");
        assert!(!devices[0].info.download);
    }

    #[test]
    fn production_sender_presents_its_announced_certificate_to_modern_tls_peer() {
        use crate::test_peer::{observed, Peer, Response};
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let fingerprint = running["fingerprint"].as_str().unwrap().to_string();
        let requests = observed();
        let observed_requests = Arc::clone(&requests);
        let peer = Peer::https(Some(fingerprint.clone()), move |request| {
            let response = if request.path == "/api/localsend/v2/prepare-upload" {
                Response::json(204, "")
            } else {
                Response::json(404, "")
            };
            observed_requests.lock().unwrap().push(request);
            response
        });
        let sent = call(
            &mut plugin,
            "send_text",
            json!({
                "ip":"127.0.0.1", "port":peer.port, "text":"hello world!"
            }),
        );
        let id = sent["sessionId"].as_str().unwrap();
        let record = wait_terminal_record(&plugin, id);
        plugin.shutdown();
        assert_eq!(
            record.status,
            crate::models::TransferStatus::Done,
            "mandatory client-certificate TLS must reach prepare, not fail before HTTP"
        );
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            1,
            "message acknowledgement requires no upload"
        );
        assert_eq!(
            requests[0].client_fingerprint.as_deref(),
            Some(fingerprint.as_str()),
            "outgoing identity is the same certificate advertised by the service"
        );
        let body: Value = serde_json::from_slice(&requests[0].body).expect("prepare JSON");
        assert_eq!(body["info"]["fingerprint"], fingerprint);
        let file = body["files"].as_object().unwrap().values().next().unwrap();
        assert_eq!(file["fileType"], "text/plain");
        assert_eq!(file["preview"], "hello world!");
    }

    fn wait_terminal_record(plugin: &PluginRuntime, id: &str) -> crate::models::TransferRecord {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let record = plugin
                .receive
                .transfer_records()
                .into_iter()
                .find(|record| record.session_id == id)
                .expect("registered send");
            if record.status.is_terminal() || Instant::now() >= deadline {
                return record;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn public_send_protocol_honors_http_prepare_and_upload() {
        use crate::test_peer::{observed, Peer, Response};
        let (mut plugin, directory) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        wait_state(&mut plugin, "running");
        let requests = observed();
        let observed_requests = Arc::clone(&requests);
        let peer = Peer::http(move |request| {
            let response = if request.path == "/api/localsend/v2/prepare-upload" {
                let body: Value = serde_json::from_slice(&request.body).expect("prepare JSON");
                let files: serde_json::Map<String, Value> = body["files"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(|id| (id.clone(), json!("fixture-token")))
                    .collect();
                Response::json(
                    200,
                    &json!({"sessionId":"remote-http", "files":files}).to_string(),
                )
            } else if request.path.starts_with("/api/localsend/v2/upload?") {
                Response::json(200, "")
            } else {
                Response::json(404, "")
            };
            observed_requests.lock().unwrap().push(request);
            response
        });
        let file = directory.path().join("send.txt");
        std::fs::write(&file, b"hello world!").unwrap();
        for (method, extra) in [
            ("send_text", json!({"text":"hello world!"})),
            ("send_files", json!({"files":[{"path":file}]})),
        ] {
            let mut payload = json!({"ip":"127.0.0.1", "port":peer.port, "protocol":"http"});
            payload
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let sent = call(&mut plugin, method, payload);
            let record = wait_terminal_record(&plugin, sent["sessionId"].as_str().unwrap());
            assert_eq!(
                record.status,
                crate::models::TransferStatus::Done,
                "public {method} must use the selected HTTP peer rather than TLS"
            );
        }
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.path == "/api/localsend/v2/prepare-upload")
                .count(),
            2
        );
        let uploads: Vec<_> = requests
            .iter()
            .filter(|request| request.path.starts_with("/api/localsend/v2/upload?"))
            .collect();
        assert_eq!(uploads.len(), 2);
        assert!(uploads
            .iter()
            .all(|request| request.body == b"hello world!"));
        drop(requests);
        plugin.shutdown();
    }

    #[test]
    fn missing_send_protocol_uses_exact_discovered_endpoint() {
        use crate::test_peer::{Peer, Response};
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        wait_state(&mut plugin, "running");
        let peer = Peer::http(|request| {
            assert_eq!(request.path, "/api/localsend/v2/prepare-upload");
            Response::json(204, "")
        });
        let shared = plugin.service.discovery().expect("running discovery");
        let mut info = shared.snapshot_local_info();
        info.fingerprint = "discovered-http".into();
        info.alias = "Discovered HTTP peer".into();
        info.port = peer.port;
        info.protocol = "http".into();
        shared.devices.upsert(info, Ipv4Addr::LOCALHOST.into());
        let sent = call(
            &mut plugin,
            "send_text",
            json!({"ip":"127.0.0.1", "port":peer.port, "text":"hello world!"}),
        );
        let record = wait_terminal_record(&plugin, sent["sessionId"].as_str().unwrap());
        plugin.shutdown();
        assert_eq!(
            record.status,
            crate::models::TransferStatus::Done,
            "missing protocol must retain known peer scheme"
        );
        assert_eq!(record.peer_alias, "Discovered HTTP peer");
    }

    #[test]
    fn invalid_public_protocol_is_rejected_before_registering_send() {
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        wait_state(&mut plugin, "running");
        let mut rejected = Vec::new();
        for protocol in [
            json!("ftp"),
            json!("https://user:password@127.0.0.1"),
            json!("HTTPS"),
            json!(null),
            json!(7),
        ] {
            for method in ["send_text", "send_files"] {
                rejected.push(invoke_plugin(
                    &mut plugin,
                    method,
                    json!({
                        "ip":"127.0.0.1", "port":53317, "protocol":protocol,
                        "text":"hello world!", "files":[{"path":"not-a-file"}]
                    }),
                ));
            }
        }
        let records = plugin.receive.transfer_records();
        plugin.shutdown();
        for result in rejected {
            let error = result.expect_err("invalid protocol must fail before job registration");
            assert!(
                error.contains("protocol"),
                "safe protocol validation, not file/network error: {error}"
            );
            assert!(!error.contains("password"));
        }
        assert!(
            records.is_empty(),
            "rejected protocols must not create transfer records"
        );
    }

    #[test]
    fn auto_save_does_not_advertise_an_unimplemented_download_api() {
        let (mut plugin, _temp) = local_plugin();
        let mut settings = call(&mut plugin, "settings_get", json!({}));
        settings["autoSave"] = json!(true);
        call(&mut plugin, "settings_set", json!({"settings":settings}));
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let announced = plugin.service.discovery().unwrap().snapshot_local_info();
        let port = running["port"].as_u64().unwrap();
        let info = plugin.runtime.block_on(async {
            crate::sender::http_client(None)
                .unwrap()
                .get(format!("https://127.0.0.1:{port}/api/localsend/v2/info"))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        });
        plugin.shutdown();
        assert!(
            !announced.download,
            "download means reverse-download routes, not auto-save"
        );
        assert_eq!(info["download"], false);
    }

    #[test]
    fn production_identity_stays_compatible_with_legacy_https_receiver() {
        use crate::test_peer::{Peer, Response};
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        wait_state(&mut plugin, "running");
        let peer = Peer::https(None, |request| {
            assert_eq!(request.path, "/api/localsend/v2/prepare-upload");
            Response::json(204, "")
        });
        let sent = call(
            &mut plugin,
            "send_text",
            json!({"ip":"127.0.0.1", "port":peer.port, "text":"hello world!"}),
        );
        let record = wait_terminal_record(&plugin, sent["sessionId"].as_str().unwrap());
        plugin.shutdown();
        assert_eq!(
            record.status,
            crate::models::TransferStatus::Done,
            "1.17-style server without client-auth request remains compatible"
        );
    }

    #[test]
    fn queries_leave_service_stopped() {
        let (mut plugin, _temp) = local_plugin();
        let status = call(&mut plugin, "server_status", json!({}));
        assert_eq!(
            status["state"], "stopped",
            "status query must not start the service"
        );
        assert_snapshot(&status);
        assert_eq!(status["port"], 0);
        assert_eq!(status["udpPort"], 0);
        assert_eq!(status["revision"], 0);
        assert!(status["fingerprint"].is_null());
        assert_eq!(
            call(&mut plugin, "device_list", json!({})),
            json!({ "devices": [], "udpPort": 0 })
        );
        assert_eq!(
            call(&mut plugin, "discover_now", json!({})),
            json!({ "ok": true })
        );
        assert!(call(&mut plugin, "transfer_list", json!({}))["transfers"]
            .as_array()
            .expect("history")
            .is_empty());
        let stopped = call(&mut plugin, "stop_localsend", json!({}));
        assert_eq!(
            stopped,
            json!({ "confirmationRequired": false, "activeTransfers": 0, "status": status })
        );
        plugin.shutdown();
    }

    #[test]
    fn service_start_stop_start_releases_both_ports_and_keeps_certificate() {
        let (mut plugin, temp) = local_plugin();
        let start = call(&mut plugin, "start_localsend", json!({}));
        assert_eq!(start["started"], true);
        assert_eq!(start["status"]["state"], "starting");
        assert_snapshot(&start["status"]);
        let running = wait_state(&mut plugin, "running");
        assert_snapshot(&running);
        let cert = std::fs::read(temp.path().join("cert.pem")).expect("certificate");
        let key = std::fs::read(temp.path().join("key.pem")).expect("key");
        let settings = std::fs::read(temp.path().join("settings.json")).expect("settings");
        assert_eq!(
            call(&mut plugin, "start_localsend", json!({}))["status"],
            running,
            "running start is inert"
        );
        let stop = call(&mut plugin, "stop_localsend", json!({}));
        assert_eq!(stop["confirmationRequired"], false);
        assert_eq!(stop["status"]["state"], "stopping");
        assert_eq!(stop["status"]["port"], running["port"]);
        assert!(
            invoke_plugin(&mut plugin, "start_localsend", json!({})).is_err(),
            "start while stopping is rejected"
        );
        let stopped = wait_state(&mut plugin, "stopped");
        assert_eq!(stopped["port"], 0);
        assert_eq!(stopped["udpPort"], 0);
        assert_eq!(stopped["fingerprint"], running["fingerprint"]);
        ports_bindable(&running);
        assert_eq!(
            call(&mut plugin, "device_list", json!({})),
            json!({ "devices": [], "udpPort": 0 })
        );
        assert_eq!(
            call(&mut plugin, "stop_localsend", json!({}))["status"],
            stopped
        );
        assert_eq!(
            std::fs::read(temp.path().join("cert.pem")).expect("certificate retained"),
            cert
        );
        assert_eq!(
            std::fs::read(temp.path().join("key.pem")).expect("key retained"),
            key
        );
        assert_eq!(
            std::fs::read(temp.path().join("settings.json")).expect("settings retained"),
            settings
        );
        call(&mut plugin, "start_localsend", json!({}));
        let restarted = wait_state(&mut plugin, "running");
        assert_eq!(restarted["fingerprint"], running["fingerprint"]);
        assert!(
            restarted["revision"].as_u64().expect("revision")
                > stopped["revision"].as_u64().expect("revision")
        );
        call(&mut plugin, "stop_localsend", json!({}));
        wait_state(&mut plugin, "stopped");
        ports_bindable(&restarted);
        let snapshots: Vec<Value> = plugin
            .broadcaster
            .drain()
            .into_iter()
            .filter(|event| event["topic"] == "server-status")
            .map(|event| event["payload"].clone())
            .collect();
        assert!(!snapshots.is_empty());
        for snapshot in &snapshots {
            assert_snapshot(snapshot);
        }
        for pair in snapshots.windows(2) {
            assert!(
                pair[1]["revision"].as_u64().unwrap() > pair[0]["revision"].as_u64().unwrap(),
                "event revisions ordered: {snapshots:?}"
            );
        }
        assert_eq!(snapshots.last().unwrap()["state"], "stopped");
        plugin.shutdown();
    }

    #[test]
    fn force_stop_waits_for_stalled_writer_then_retains_finished_tmp_and_history() {
        let (mut plugin, temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let sender = crate::models::DeviceInfo {
            alias: "Stopped upload peer".into(),
            version: "2.2".into(),
            device_model: None,
            device_type: Some("desktop".into()),
            fingerprint: "d".repeat(64),
            port: 53317,
            protocol: "https".into(),
            download: false,
        };
        let entry = |id: &str, size| crate::models::FileEntry {
            id: id.into(),
            file_name: format!("{id}.bin"),
            size,
            file_type: "application/octet-stream".into(),
            sha256: None,
            preview: None,
            metadata: None,
        };
        let files = [entry("finished", 4), entry("stalled", 100)]
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        let prepared = match crate::server::prepare_upload(
            &plugin.receive,
            &Settings {
                auto_save: true,
                ..Default::default()
            },
            sender,
            files,
            None,
            Ipv4Addr::LOCALHOST.into(),
        ) {
            crate::server::PrepareOutcome::Immediate { status: 200, body } => body,
            _ => panic!("auto-accepted receive"),
        };
        let id = prepared["sessionId"].as_str().unwrap().to_string();
        let finished_token = prepared["files"]["finished"].as_str().unwrap().to_string();
        let result = plugin.runtime.block_on(crate::server::upload_stream(
            Arc::clone(&plugin.receive),
            None,
            id.clone(),
            "finished".into(),
            finished_token,
            Ipv4Addr::LOCALHOST.into(),
            axum::body::Body::from("kept"),
        ));
        assert_eq!(result.0, 200);
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(1);
        let stalled_token = prepared["files"]["stalled"].as_str().unwrap().to_string();
        let upload = plugin.runtime.spawn(crate::server::upload_stream(
            Arc::clone(&plugin.receive),
            None,
            id.clone(),
            "stalled".into(),
            stalled_token,
            Ipv4Addr::LOCALHOST.into(),
            axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)),
        ));
        plugin
            .runtime
            .block_on(tx.send(Ok(axum::body::Bytes::from_static(b"partial"))))
            .unwrap();
        let partial = plugin.receive.tmp_root().join(&id).join("stalled");
        let deadline = Instant::now() + Duration::from_secs(2);
        while std::fs::metadata(&partial)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            < 7
        {
            assert!(Instant::now() < deadline, "writer started");
            std::thread::sleep(Duration::from_millis(5));
        }
        let confirmed = call(&mut plugin, "stop_localsend", json!({}));
        assert_eq!(confirmed["confirmationRequired"], true);
        assert!(
            !upload.is_finished(),
            "confirmation must leave stalled writer running"
        );
        let started = Instant::now();
        call(&mut plugin, "stop_localsend", json!({ "force": true }));
        let stopped = wait_state(&mut plugin, "stopped");
        assert!(started.elapsed() < Duration::from_secs(12));
        assert!(tx.is_closed(), "stop must not wait for sender EOF");
        plugin.runtime.block_on(upload).expect("closed upload");
        assert!(!partial.exists());
        let finished = plugin.receive.tmp_root().join(&id).join("finished");
        assert_eq!(
            std::fs::read(&finished).expect("completed file retained"),
            b"kept"
        );
        let history_before_restart = std::fs::read(temp.path().join("transfers.json")).unwrap();
        assert_eq!(stopped["activeTransfers"], 0);
        call(&mut plugin, "start_localsend", json!({}));
        wait_state(&mut plugin, "running");
        assert_eq!(
            std::fs::read(temp.path().join("transfers.json")).unwrap(),
            history_before_restart
        );
        assert_eq!(std::fs::read(&finished).unwrap(), b"kept");
        assert_eq!(
            plugin.receive.transfer_records()[0].status,
            crate::models::TransferStatus::Cancelled
        );
        assert_eq!(
            plugin.receive.transfer_records()[0].destinations["finished"],
            finished.to_string_lossy()
        );
        let done = plugin
            .broadcaster
            .drain()
            .into_iter()
            .filter(|event| event["topic"] == "transfer-done")
            .count();
        assert_eq!(done, 1);
        plugin.shutdown();
        ports_bindable(&running);
    }

    #[test]
    fn idle_tls_connection_closes_before_stop_reports_stopped() {
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let mut connection = std::net::TcpStream::connect((
            Ipv4Addr::LOCALHOST,
            running["port"].as_u64().unwrap() as u16,
        ))
        .unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        std::thread::sleep(Duration::from_millis(20));
        call(&mut plugin, "stop_localsend", json!({}));
        wait_state(&mut plugin, "stopped");
        use std::io::Read;
        let result = connection.read(&mut [0u8; 1]);
        assert!(
            matches!(result, Ok(0))
                || result.is_err_and(|error| error.kind() != std::io::ErrorKind::WouldBlock
                    && error.kind() != std::io::ErrorKind::TimedOut),
            "TLS handshake task must close the connection"
        );
        ports_bindable(&running);
        plugin.shutdown();
    }

    #[test]
    fn stop_waits_for_startup_worker_before_reporting_stopped() {
        let (mut plugin, _temp) = local_plugin();
        let settings = Arc::clone(&plugin.settings_snapshot);
        let settings_guard = settings.write().expect("pause startup settings refresh");
        let start = call(&mut plugin, "start_localsend", json!({}));
        assert_eq!(start["status"]["state"], "starting");
        std::thread::sleep(Duration::from_millis(30));
        let stop = call(&mut plugin, "stop_localsend", json!({}));
        assert_eq!(stop["status"]["state"], "stopping");
        std::thread::sleep(Duration::from_millis(30));
        let query_started = Instant::now();
        let status = call(&mut plugin, "server_status", json!({}));
        assert!(
            query_started.elapsed() < Duration::from_millis(100),
            "status cannot wait for startup cleanup"
        );
        let still_stopping = status["state"] == "stopping";
        drop(settings_guard);
        assert!(
            still_stopping,
            "a startup worker still owns this generation: {status}"
        );
        wait_state(&mut plugin, "stopped");
        call(&mut plugin, "start_localsend", json!({}));
        let restarted = wait_state(&mut plugin, "running");
        assert!(
            restarted["revision"].as_u64().unwrap() > stop["status"]["revision"].as_u64().unwrap()
        );
        plugin.shutdown();
        ports_bindable(&restarted);
    }

    #[test]
    fn tls_failure_publishes_failed_and_retry_uses_retained_certificate() {
        let (mut plugin, temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        call(&mut plugin, "stop_localsend", json!({}));
        wait_state(&mut plugin, "stopped");
        let cert = std::fs::read(temp.path().join("cert.pem")).expect("certificate");
        std::fs::write(
            temp.path().join("cert.pem"),
            b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        )
        .expect("invalid DER fixture");
        call(&mut plugin, "start_localsend", json!({}));
        let failed = wait_state(&mut plugin, "failed");
        assert_snapshot(&failed);
        assert!(
            failed["error"].as_str().unwrap().contains("TLS"),
            "TLS diagnostic: {failed}"
        );
        assert_eq!(
            failed["fingerprint"], running["fingerprint"],
            "failure keeps last known fingerprint"
        );
        assert_eq!(failed["port"], 0);
        assert_eq!(failed["udpPort"], 0);
        std::fs::write(temp.path().join("cert.pem"), &cert).expect("restore certificate");
        call(&mut plugin, "start_localsend", json!({}));
        let retried = wait_state(&mut plugin, "running");
        assert_eq!(retried["fingerprint"], running["fingerprint"]);
        assert!(retried["error"].is_null());
        plugin.shutdown();
    }

    #[test]
    fn stop_confirmation_preserves_pending_receive_and_force_resolves_403() {
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let client = crate::sender::http_client(None).expect("test HTTP client");
        let port = running["port"].as_u64().unwrap();
        let request = plugin.runtime.spawn(async move {
            client.post(format!("https://127.0.0.1:{port}/api/localsend/v2/prepare-upload"))
                .json(&json!({
                    "info": { "alias": "Pending peer", "version": "2.2", "deviceModel": null,
                        "deviceType": "desktop", "fingerprint": "e".repeat(64), "port": 53317,
                        "protocol": "https", "download": false },
                    "files": { "pending": { "id": "pending", "fileName": "pending.bin", "size": 100,
                        "fileType": "application/octet-stream", "sha256": null, "preview": null, "metadata": null } }
                })).send().await.expect("prepare response").status().as_u16()
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while call(&mut plugin, "server_status", json!({}))["activeTransfers"] != 1 {
            assert!(Instant::now() < deadline, "pending admission");
            std::thread::sleep(Duration::from_millis(5));
        }
        let before = call(&mut plugin, "server_status", json!({}));
        let history = call(&mut plugin, "transfer_list", json!({}));
        let confirm = call(&mut plugin, "stop_localsend", json!({}));
        assert_eq!(confirm["confirmationRequired"], true);
        assert_eq!(confirm["activeTransfers"], 1);
        assert_eq!(
            confirm["status"], before,
            "no status side effect on confirmation"
        );
        assert_eq!(
            call(&mut plugin, "transfer_list", json!({})),
            history,
            "pending job intact"
        );
        assert!(!request.is_finished(), "manual prepare remains suspended");
        let stop = call(&mut plugin, "stop_localsend", json!({ "force": true }));
        assert_eq!(stop["status"]["state"], "stopping");
        assert_eq!(stop["activeTransfers"], 1);
        wait_state(&mut plugin, "stopped");
        let result = plugin.runtime.block_on(request).expect("request task");
        assert_eq!(result, 403, "forced stop declines suspended receiver");
        let transfers = call(&mut plugin, "transfer_list", json!({}));
        assert_eq!(transfers["transfers"][0]["status"], "Cancelled");
        let events = plugin.broadcaster.drain();
        assert_eq!(
            events
                .iter()
                .filter(|event| event["topic"] == "transfer-done")
                .count(),
            1
        );
        ports_bindable(&running);
        plugin.shutdown();
    }

    #[test]
    fn stop_confirmation_preserves_pending_send_then_force_cancels_once() {
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let peer_listener = TcpListener::bind("127.0.0.1:0").expect("peer listener");
        let peer_port = peer_listener.local_addr().unwrap().port();
        let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
        let peer = std::thread::spawn(move || {
            let (stream, _) = peer_listener.accept().expect("sender connection");
            accepted_tx.send(()).expect("accepted notification");
            std::thread::sleep(Duration::from_millis(300));
            drop(stream);
        });
        let send = call(
            &mut plugin,
            "send_text",
            json!({ "ip": "127.0.0.1", "port": peer_port, "text": "pending outbound" }),
        );
        accepted_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("outbound connected");
        let before = call(&mut plugin, "server_status", json!({}));
        assert_eq!(before["activeTransfers"], 1);
        let confirm = call(&mut plugin, "stop_localsend", json!({}));
        assert_eq!(confirm["confirmationRequired"], true);
        assert_eq!(confirm["status"], before);
        assert_eq!(
            call(&mut plugin, "transfer_list", json!({}))["transfers"][0]["status"],
            "Pending"
        );
        let stop = call(&mut plugin, "stop_localsend", json!({ "force": true }));
        assert_eq!(stop["status"]["state"], "stopping");
        assert!(invoke_plugin(
            &mut plugin,
            "send_text",
            json!({ "ip": "127.0.0.1", "port": peer_port, "text": "blocked" })
        )
        .is_err());
        wait_state(&mut plugin, "stopped");
        peer.join().expect("peer thread");
        let history = call(&mut plugin, "transfer_list", json!({}));
        assert_eq!(history["transfers"][0]["sessionId"], send["sessionId"]);
        assert_eq!(history["transfers"][0]["status"], "Cancelled");
        let events = plugin.broadcaster.drain();
        assert_eq!(
            events
                .iter()
                .filter(|event| event["topic"] == "transfer-done")
                .count(),
            1
        );
        ports_bindable(&running);
        plugin.shutdown();
    }

    #[test]
    fn session_cancel_from_host_thread_cleans_stalled_writer() {
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        wait_state(&mut plugin, "running");
        let files = [crate::models::FileEntry {
            id: "partial".into(),
            file_name: "partial.bin".into(),
            size: 100,
            file_type: "application/octet-stream".into(),
            sha256: None,
            preview: None,
            metadata: None,
        }]
        .into_iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect();
        let sender = crate::models::DeviceInfo {
            alias: "Host thread cancel peer".into(),
            version: "2.2".into(),
            device_model: None,
            device_type: Some("desktop".into()),
            fingerprint: "f".repeat(64),
            port: 53317,
            protocol: "https".into(),
            download: false,
        };
        let prepared = crate::server::prepare_upload(
            &plugin.receive,
            &Settings {
                auto_save: true,
                ..Default::default()
            },
            sender,
            files,
            None,
            Ipv4Addr::LOCALHOST.into(),
        );
        let prepared = match prepared {
            crate::server::PrepareOutcome::Immediate { status: 200, body } => body,
            _ => panic!("auto-accepted receive"),
        };
        let id = prepared["sessionId"].as_str().unwrap().to_string();
        let token = prepared["files"]["partial"].as_str().unwrap().to_string();
        let path = plugin.receive.tmp_root().join(&id).join("partial");
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(1);
        let upload = plugin.runtime.spawn(crate::server::upload_stream(
            Arc::clone(&plugin.receive),
            None,
            id.clone(),
            "partial".into(),
            token,
            Ipv4Addr::LOCALHOST.into(),
            axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)),
        ));
        plugin
            .runtime
            .block_on(tx.send(Ok(axum::body::Bytes::from_static(b"partial"))))
            .expect("chunk");
        let deadline = Instant::now() + Duration::from_secs(2);
        while std::fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            < 7
        {
            assert!(Instant::now() < deadline, "writer started");
            std::thread::sleep(Duration::from_millis(5));
        }
        // FFI dispatch is on a host thread with no Tokio context.
        call(&mut plugin, "session_cancel", json!({ "sessionId": id }));
        plugin.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(2), upload)
                .await
                .expect("upload cancelled")
                .expect("upload task");
            plugin.receive.drain().await.expect("cleanup");
        });
        assert!(tx.is_closed());
        assert!(!path.parent().unwrap().exists());
        plugin.shutdown();
    }

    #[cfg(windows)]
    #[test]
    fn locked_partial_file_makes_stop_failed_then_cleanup_retry_succeeds() {
        use std::os::windows::fs::OpenOptionsExt;
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let files = [crate::models::FileEntry {
            id: "partial".into(),
            file_name: "partial.bin".into(),
            size: 100,
            file_type: "application/octet-stream".into(),
            sha256: None,
            preview: None,
            metadata: None,
        }]
        .into_iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect();
        let sender = crate::models::DeviceInfo {
            alias: "Locked partial peer".into(),
            version: "2.2".into(),
            device_model: None,
            device_type: Some("desktop".into()),
            fingerprint: "c".repeat(64),
            port: 53317,
            protocol: "https".into(),
            download: false,
        };
        let prepared = match crate::server::prepare_upload(
            &plugin.receive,
            &Settings {
                auto_save: true,
                ..Default::default()
            },
            sender,
            files,
            None,
            Ipv4Addr::LOCALHOST.into(),
        ) {
            crate::server::PrepareOutcome::Immediate { status: 200, body } => body,
            _ => panic!("accepted receive"),
        };
        let id = prepared["sessionId"].as_str().unwrap().to_string();
        let path = plugin.receive.tmp_root().join(&id).join("partial");
        std::fs::write(&path, b"partial bytes").expect("partial file");
        let exclusive = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .expect("exclusive file lock");
        call(&mut plugin, "stop_localsend", json!({ "force": true }));
        let deadline = Instant::now() + Duration::from_secs(3);
        let terminal = loop {
            let status = call(&mut plugin, "server_status", json!({}));
            if status["state"] != "stopping" {
                break status;
            }
            assert!(Instant::now() < deadline, "cleanup must surface its error");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(
            terminal["state"], "failed",
            "failed directory cleanup must never claim stopped"
        );
        assert_snapshot(&terminal);
        assert!(
            terminal["error"]
                .as_str()
                .is_some_and(|error| error.contains("clean")),
            "cleanup diagnostic: {terminal}"
        );
        assert_eq!(terminal["port"], running["port"]);
        assert_eq!(terminal["udpPort"], running["udpPort"]);
        assert!(
            path.is_file(),
            "blocked partial file remains owned for retry"
        );
        assert!(
            invoke_plugin(&mut plugin, "start_localsend", json!({})).is_err(),
            "cannot replace an undrained generation"
        );
        drop(exclusive);
        call(&mut plugin, "stop_localsend", json!({ "force": true }));
        let stopped = wait_state(&mut plugin, "stopped");
        assert!(
            !path.parent().unwrap().exists(),
            "retry removes the canceled directory"
        );
        assert!(stopped["error"].is_null());
        assert_eq!(
            plugin.receive.transfer_records()[0].status,
            crate::models::TransferStatus::Cancelled
        );
        assert_eq!(
            plugin
                .broadcaster
                .drain()
                .into_iter()
                .filter(|event| event["topic"] == "transfer-done")
                .count(),
            1
        );
        ports_bindable(&running);
        plugin.shutdown();
    }

    #[test]
    fn saved_port_applies_only_on_next_start() {
        let _ports = FIXED_PORT_TESTS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (mut plugin, _temp) = local_plugin();
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        let (new_port, listener, udp) = (30000..60000)
            .find_map(|port| {
                let tcp = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).ok()?;
                let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).ok()?;
                Some((port, tcp, udp))
            })
            .expect("new free TCP and UDP port");
        drop((listener, udp));
        let mut settings = call(&mut plugin, "settings_get", json!({}));
        settings["port"] = json!(new_port);
        call(&mut plugin, "settings_set", json!({ "settings": settings }));
        assert_eq!(
            call(&mut plugin, "server_status", json!({}))["port"],
            running["port"]
        );
        call(&mut plugin, "stop_localsend", json!({}));
        wait_state(&mut plugin, "stopped");
        call(&mut plugin, "start_localsend", json!({}));
        let restarted = wait_state(&mut plugin, "running");
        assert_eq!(restarted["port"], new_port);
        assert_eq!(restarted["udpPort"], new_port);
        plugin.shutdown();
        ports_bindable(&restarted);
    }

    #[test]
    fn bind_failure_is_failed_and_retries_after_resources_quiesce() {
        let _ports = FIXED_PORT_TESTS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (mut plugin, _temp) = local_plugin();
        let (port, blockers) = (30000..60000)
            .step_by(23)
            .find_map(|base| {
                let blockers = (base..=base + 10)
                    .map(|port| TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)))
                    .collect::<Result<Vec<_>, _>>()
                    .ok()?;
                Some((base, blockers))
            })
            .expect("private blocked port range");
        let mut settings = call(&mut plugin, "settings_get", json!({}));
        settings["port"] = json!(port);
        call(&mut plugin, "settings_set", json!({ "settings": settings }));
        let start = call(&mut plugin, "start_localsend", json!({}));
        assert_eq!(start["status"]["state"], "starting");
        let failed = wait_state(&mut plugin, "failed");
        assert_snapshot(&failed);
        assert!(
            failed["error"]
                .as_str()
                .is_some_and(|error| error.contains("bind")),
            "diagnostic: {failed}"
        );
        assert_eq!(failed["port"], 0);
        assert_eq!(failed["udpPort"], 0);
        drop(blockers);
        call(&mut plugin, "start_localsend", json!({}));
        let running = wait_state(&mut plugin, "running");
        assert_eq!(running["port"], port);
        assert!(running["error"].is_null());
        assert!(running["revision"].as_u64().unwrap() > failed["revision"].as_u64().unwrap());
        plugin.shutdown();
        ports_bindable(&running);
    }
}
