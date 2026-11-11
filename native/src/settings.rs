use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub alias: String,
    pub device_model: Option<String>,
    pub device_type: String,
    pub port: u16,
    pub download_dir: Option<String>,
    pub pin: Option<String>,
    pub auto_save: bool,
    pub notify_on_incoming: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            alias: default_alias(),
            device_model: None,
            device_type: "desktop".into(),
            port: 53317,
            download_dir: None,
            pin: None,
            auto_save: false,
            notify_on_incoming: true,
        }
    }
}

fn default_alias() -> String {
    let name = if cfg!(windows) {
        std::env::var("COMPUTERNAME")
    } else {
        std::env::var("HOSTNAME")
    };
    name.ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "LocalSend Device".into())
}

/// Default plugin data dir; smoke and tests point `OTOOLS_DATA_DIR` elsewhere.
pub fn default_data_dir() -> Result<PathBuf, String> {
    directories::BaseDirs::new()
        .map(|dirs| {
            dirs.home_dir()
                .join(".otools")
                .join("local")
                .join("otools-localsend")
        })
        .ok_or_else(|| "could not resolve the user home directory".into())
}

pub fn resolve_data_dir() -> Result<PathBuf, String> {
    match std::env::var_os("OTOOLS_DATA_DIR").filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                Ok(path)
            } else {
                Err(format!("OTOOLS_DATA_DIR must be absolute: {}", path.display()))
            }
        }
        None => default_data_dir(),
    }
}

/// Load settings, filling every missing field with defaults.
pub fn load(data_dir: &Path) -> Settings {
    std::fs::read(data_dir.join(SETTINGS_FILE))
        .map_err(|error| error.to_string())
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
        .unwrap_or_default()
}

impl Settings {
    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let bytes = serde_json::to_vec_pretty(self)?;
        std::fs::write(data_dir.join(SETTINGS_FILE), bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::{default_data_dir, resolve_data_dir, load, Settings, SETTINGS_FILE};
    use std::path::PathBuf;

    #[test]
    fn settings_default_fill() {
        let temp = tempfile::tempdir().expect("temp dir");
        std::fs::write(temp.path().join(SETTINGS_FILE), r#"{"alias":"测试机"}"#.as_bytes())
            .expect("write settings");
        let settings = load(temp.path());
        assert_eq!(settings.alias, "测试机");
        assert_eq!(settings.port, 53317);
        assert!(!settings.auto_save);
        assert!(settings.notify_on_incoming);
    }

    #[test]
    fn settings_roundtrip() {
        let temp = tempfile::tempdir().expect("temp dir");
        let settings = Settings {
            alias: "RoundTrip".into(),
            device_model: Some("ThinkPad".into()),
            port: 53318,
            pin: Some("123456".into()),
            ..Default::default()
        };
        settings.save(temp.path()).expect("save settings");
        assert_eq!(load(temp.path()), settings);
    }

    #[test]
    fn settings_data_dir() {
        let dir = default_data_dir().expect("default data dir");
        assert!(
            dir.ends_with(".otools/local/otools-localsend"),
            "unexpected default data dir: {dir:?}"
        );
        // Smoke runs point OTOOLS_DATA_DIR at an isolated directory so the real
        // ~/.otools is never touched.
        let previous = std::env::var_os("OTOOLS_DATA_DIR");
        let temp = tempfile::tempdir().expect("temp dir");
        std::env::set_var("OTOOLS_DATA_DIR", temp.path());
        assert_eq!(resolve_data_dir().expect("override"), PathBuf::from(temp.path()));
        std::env::remove_var("OTOOLS_DATA_DIR");
        if let Some(value) = previous {
            std::env::set_var("OTOOLS_DATA_DIR", value);
        }
    }
}
