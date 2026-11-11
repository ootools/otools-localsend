use crate::crypto::{self, CertMaterial};
use crate::settings::{self, Settings};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
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
        })
    }

    fn shutdown(self) {
        // Later tasks abort discovery/server tasks here; dropping the runtime
        // joins its workers before the DLL can unload.
        drop(self.runtime);
    }
}

pub fn invoke(method: &str, payload: Value) -> Result<Value, String> {
    let lock = PLUGIN.get_or_init(|| Mutex::new(Slot::Empty));
    let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    if method == "poll_events" {
        // Must never block behind initialization or retirement; Task 5 wires
        // the broadcaster in.
        return Ok(json!({"events": []}));
    }
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
            serde_json::to_value(update).map_err(|error| error.to_string())
        }
        _ => Err(format!("unknown method: {method}")),
    }
}

/// Autostart entry: ensure the runtime exists, generate or load the instance
/// certificate, then spawn-and-return the background shell. Discovery and the
/// HTTPS server attach to this shell in later tasks.
pub fn start_background() -> Result<(), String> {
    let lock = PLUGIN.get_or_init(|| Mutex::new(Slot::Empty));
    let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    if matches!(*guard, Slot::Retired) {
        return Err("plugin retired".into());
    }
    let plugin = ensure_running(&mut guard)?;
    if plugin.cert.is_none() {
        let material = crypto::ensure_cert(&plugin.data_dir)
            .map_err(|error| format!("ensure certificate: {error}"))?;
        plugin.cert = Some(material);
    }
    plugin.runtime.spawn(async {
        // Background loops (discovery, HTTPS server) attach here in later tasks.
    });
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
        let started = start_background();
        std::env::remove_var("OTOOLS_DATA_DIR");
        if let Some(value) = previous {
            std::env::set_var("OTOOLS_DATA_DIR", value);
        }
        started.expect("start_background");

        let fingerprint = cert_fingerprint().expect("certificate fingerprint after start");
        assert_eq!(fingerprint.len(), 64);

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
        drop(env_guard);
    }
}
