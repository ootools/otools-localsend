use crate::crypto::{self, CertMaterial};
use crate::discovery::{self, DiscoveryShared};
use crate::event_bridge::WebEventBroadcaster;
use crate::settings::{self, Settings};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::runtime::{Builder, Runtime};

static PLUGIN: OnceLock<Mutex<Slot>> = OnceLock::new();

enum Slot {
    Empty,
    Running(PluginRuntime),
    Retired,
}

struct PluginRuntime {
    runtime: Runtime,
    data_dir: PathBuf,
    cert: Option<CertMaterial>,
    /// Native→frontend event queue. Shared as `Arc` so background workers
    /// spawned on the runtime can emit events without touching the plugin
    /// slot mutex.
    broadcaster: Arc<WebEventBroadcaster>,
    /// Discovery state, present once the background shell has started. The
    /// spawned discovery task holds its own `Arc`, so this handle stays valid
    /// for the dispatch methods.
    discovery: Option<Arc<DiscoveryShared>>,
}

impl PluginRuntime {
    fn new() -> Result<Self, String> {
        let runtime = Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("otools-localsend")
            .enable_all()
            .build()
            .map_err(|error| format!("tokio runtime: {error}"))?;
        let data_dir = settings::resolve_data_dir()?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("create data dir {}: {error}", data_dir.display()))?;
        Ok(Self {
            runtime,
            data_dir,
            cert: None,
            broadcaster: Arc::new(WebEventBroadcaster::new()),
            discovery: None,
        })
    }

    fn shutdown(self) {
        // Dropping the runtime aborts the discovery (and later server) tasks
        // before the DLL can unload.
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
    let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    if method == "__otools_shutdown__" {
        shutdown(&mut guard);
        return Ok(Value::Null);
    }
    if matches!(*guard, Slot::Retired) {
        return Err("plugin retired".into());
    }
    let plugin = ensure_running(&mut guard)?;
    match method {
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
            update
                .save(&plugin.data_dir)
                .map_err(|error| format!("save settings: {error}"))?;
            // Keep our announcement payload in sync with the new settings so
            // the next announce frame carries the fresh alias/model/port.
            if let Some(shared) = &plugin.discovery {
                if let Some(cert) = &plugin.cert {
                    shared.update_local_info(discovery::local_info_from_settings(
                        &update,
                        &cert.fingerprint,
                    ));
                }
            }
            serde_json::to_value(update).map_err(|error| error.to_string())
        }
        "start_localsend" => {
            // Autostart command (Task 13 wires the manifest entry): spawn and
            // return — the 120s host timeout must never see this block. The
            // slot mutex is already held here, so this must go through the
            // locked-guard variant (std Mutex is not reentrant).
            start_background_locked(&mut guard)?;
            Ok(json!({ "started": true }))
        }
        "device_list" => {
            let shared = plugin.discovery.clone();
            let (devices, udp_port) = shared
                .map(|shared| (shared.devices.list(), shared.udp_port()))
                .unwrap_or_default();
            Ok(json!({ "devices": devices, "udpPort": udp_port }))
        }
        "discover_now" => {
            // No-op (still ok) before start_background: there is no socket to
            // announce on yet.
            if let Some(shared) = &plugin.discovery {
                shared.request_announce();
            }
            Ok(json!({ "ok": true }))
        }
        _ => Err(format!("unknown method: {method}")),
    }
}

/// Autostart entry: ensure the runtime exists, generate or load the instance
/// certificate, then spawn-and-return the background shell with the UDP
/// discovery loop attached. The HTTPS server attaches in Task 7.
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
    if plugin.cert.is_none() {
        let material = crypto::ensure_cert(&plugin.data_dir)
            .map_err(|error| format!("ensure certificate: {error}"))?;
        plugin.cert = Some(material);
    }
    // Idempotent: a repeated start must not spawn a second discovery loop.
    if plugin.discovery.is_none() {
        let cert = plugin.cert.as_ref().expect("certificate ensured above");
        let loaded = settings::load(&plugin.data_dir);
        let shared = Arc::new(DiscoveryShared::new(
            discovery::local_info_from_settings(&loaded, &cert.fingerprint),
            Arc::clone(&plugin.broadcaster),
        ));
        plugin
            .runtime
            .spawn(discovery::run_discovery(Arc::clone(&shared), loaded.port));
        plugin.discovery = Some(shared);
    }
    Ok(())
}

/// SHA-256 fingerprint (hex) of the instance certificate once the background
/// shell has started; None before start or after retirement. Tasks 6/7 read
/// the full [`CertMaterial`] from the runtime state instead.
pub fn cert_fingerprint() -> Option<String> {
    let lock = PLUGIN.get_or_init(|| Mutex::new(Slot::Empty));
    let guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    match &*guard {
        Slot::Running(plugin) => plugin.cert.as_ref().map(|cert| cert.fingerprint.clone()),
        _ => None,
    }
}

fn ensure_running(guard: &mut Slot) -> Result<&mut PluginRuntime, String> {
    if matches!(*guard, Slot::Empty) {
        *guard = Slot::Running(PluginRuntime::new()?);
    }
    match guard {
        Slot::Running(plugin) => Ok(plugin),
        _ => Err("plugin is not running".into()),
    }
}

fn shutdown(guard: &mut Slot) {
    if let Slot::Running(plugin) = std::mem::replace(guard, Slot::Retired) {
        plugin.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::{cert_fingerprint, invoke, start_background};
    use crate::crypto::{pem_to_der, sha256_hex};
    use crate::settings::TEST_ENV_LOCK;
    use serde_json::json;

    /// `start_background` resolves the data dir from `OTOOLS_DATA_DIR`, so this
    /// test serializes environment mutation with `settings_data_dir` through the
    /// shared process-wide lock. It is the only test touching the global plugin
    /// slot, and it retires the slot at the end.
    #[test]
    fn start_background_generates_and_exposes_certificate() {
        let env_guard = TEST_ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let temp = tempfile::tempdir().expect("temp dir");
        let previous = std::env::var_os("OTOOLS_DATA_DIR");
        std::env::set_var("OTOOLS_DATA_DIR", temp.path());

        // Before start_background the discovery surface is inert but answerable.
        // Note: `invoke` returns the bare data value — the {ok, data} envelope
        // is applied by lib.rs `handle_json`.
        let pre_devices = invoke("device_list", json!({})).expect("device_list before start");
        assert_eq!(pre_devices["devices"], json!([]));
        assert_eq!(pre_devices["udpPort"], json!(0));
        let pre_now = invoke("discover_now", json!({})).expect("discover_now before start");
        assert_eq!(pre_now["ok"], json!(true));

        let started = start_background();
        std::env::remove_var("OTOOLS_DATA_DIR");
        if let Some(value) = previous {
            std::env::set_var("OTOOLS_DATA_DIR", value);
        }
        started.expect("start_background");

        let fingerprint = cert_fingerprint().expect("certificate fingerprint after start");
        assert_eq!(fingerprint.len(), 64);

        // The spawned discovery task owns the socket; the dispatch only
        // guarantees an answerable list (peers may or may not have arrived).
        let devices = invoke("device_list", json!({})).expect("device_list after start");
        assert!(devices["devices"].is_array());
        assert!(devices["udpPort"].is_u64());

        let cert_pem =
            std::fs::read_to_string(temp.path().join("cert.pem")).expect("cert.pem in data dir");
        let cert_der = pem_to_der(&cert_pem).expect("parse stored cert.pem");
        assert_eq!(sha256_hex(&cert_der), fingerprint);

        // Idempotent: a second start must keep the same certificate.
        start_background().expect("second start_background");
        assert_eq!(cert_fingerprint().as_deref(), Some(fingerprint.as_str()));

        invoke("__otools_shutdown__", json!({})).expect("shutdown");
        assert!(
            cert_fingerprint().is_none(),
            "fingerprint must be gone after retirement"
        );
        assert_eq!(
            invoke("device_list", json!({})).unwrap_err(),
            "plugin retired",
            "device_list must retire with the plugin"
        );
        drop(env_guard);
    }
}
