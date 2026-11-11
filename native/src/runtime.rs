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
        Ok(Self { runtime, data_dir })
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

/// Autostart entry: ensure the runtime exists, spawn-and-return the background
/// shell. Discovery and the HTTPS server attach to this shell in later tasks.
pub fn start_background() -> Result<(), String> {
    let lock = PLUGIN.get_or_init(|| Mutex::new(Slot::Empty));
    let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    if matches!(*guard, Slot::Retired) {
        return Err("plugin retired".into());
    }
    let plugin = ensure_running(&mut guard)?;
    plugin.runtime.spawn(async {
        // Background loops (discovery, HTTPS server) attach here in later tasks.
    });
    Ok(())
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
