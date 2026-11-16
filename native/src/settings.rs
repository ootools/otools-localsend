use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTINGS_FILE: &str = "settings.json";
pub const DEFAULT_DOWNLOAD_DIR: &str = "~/Download/OToolsLocalSend";

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
            download_dir: Some(DEFAULT_DOWNLOAD_DIR.into()),
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

/// Serializes `OTOOLS_DATA_DIR` mutations between tests that share the
/// process environment (see `settings_data_dir` and the runtime cert test).
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
                Err(format!(
                    "OTOOLS_DATA_DIR must be absolute: {}",
                    path.display()
                ))
            }
        }
        None => default_data_dir(),
    }
}

/// Load settings, filling every missing field with defaults.
pub fn load(data_dir: &Path) -> Settings {
    std::fs::read(data_dir.join(SETTINGS_FILE))
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            serde_json::from_slice::<Settings>(&bytes).map_err(|error| error.to_string())
        })
        .unwrap_or_default()
        .normalized()
}

/// Validate lexical local paths without probing or creating anything on disk.
/// Reject Windows network/device prefixes and ADS even on non-Windows hosts.
pub(crate) fn validate_local_absolute_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err("local path is empty or contains control characters".into());
    }
    let bytes = value.as_bytes();
    let separator = |byte: u8| matches!(byte, b'/' | b'\\');
    if bytes.len() >= 2 && separator(bytes[0]) && separator(bytes[1]) {
        return Err("network and device paths are not supported".into());
    }
    if value.contains("://") {
        return Err("URLs are not local paths".into());
    }
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && separator(bytes[2]);
    if value
        .char_indices()
        .any(|(index, ch)| ch == ':' && !(drive && index == 1))
    {
        return Err("local paths must not contain alternate data streams".into());
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("local path must be absolute".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        {
            return Err("local path must use an absolute drive path".into());
        }
        if value.contains(['<', '>', '"', '|', '?', '*']) {
            return Err("local path contains invalid Windows characters".into());
        }
        for component in value[2..]
            .split(['/', '\\'])
            .filter(|part| !part.is_empty())
        {
            if component == "." || component == ".." {
                continue;
            }
            if component.ends_with(['.', ' ']) {
                return Err("local path contains an ambiguous Windows component".into());
            }
            let name = component
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase();
            if matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || ((name.starts_with("COM") || name.starts_with("LPT"))
                    && name.len() == 4
                    && matches!(name.as_bytes()[3], b'1'..=b'9'))
            {
                return Err("local path contains a Windows device name".into());
            }
        }
    }
    Ok(path)
}

/// Resolve a readable persisted directory against the caller's injected home.
/// This is a pure path operation: loading/choosing a directory never creates it.
pub fn resolve_download_dir(value: Option<&str>, home: &Path) -> Result<PathBuf, String> {
    let value = value
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_DOWNLOAD_DIR);
    let expanded = if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        validate_local_absolute_path(home.to_str().ok_or("home directory is not UTF-8")?)?;
        let mut expanded = home.to_path_buf();
        if value.len() > 1 {
            // Split both forms so a Windows-readable tilde setting is portable
            // without allowing an absolute suffix to replace the injected home.
            for component in value[2..]
                .split(['/', '\\'])
                .filter(|part| !part.is_empty())
            {
                expanded.push(component);
            }
        }
        expanded
    } else {
        PathBuf::from(value)
    };
    validate_local_absolute_path(expanded.to_str().ok_or("download directory is not UTF-8")?)
}

impl Settings {
    pub fn normalized(mut self) -> Self {
        if self
            .download_dir
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        {
            self.download_dir = Some(DEFAULT_DOWNLOAD_DIR.into());
        }
        self
    }

    pub fn for_runtime(&self, home: &Path) -> Result<Settings, String> {
        let mut settings = self.clone().normalized();
        let directory = resolve_download_dir(settings.download_dir.as_deref(), home)?;
        settings.download_dir = Some(
            directory
                .to_str()
                .ok_or("download directory is not UTF-8")?
                .into(),
        );
        Ok(settings)
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let bytes = serde_json::to_vec_pretty(&self.clone().normalized())?;
        std::fs::write(data_dir.join(SETTINGS_FILE), bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        default_data_dir, load, resolve_data_dir, resolve_download_dir, Settings, SETTINGS_FILE,
        TEST_ENV_LOCK,
    };
    use std::path::PathBuf;

    #[test]
    fn settings_download_dir_missing_null_blank_use_exact_default() {
        let temp = tempfile::tempdir().expect("temp dir");
        assert_eq!(
            Settings::default().download_dir.as_deref(),
            Some("~/Download/OToolsLocalSend")
        );
        for payload in [
            r#"{}"#,
            r#"{"downloadDir":null}"#,
            r#"{"downloadDir":""}"#,
            r#"{"downloadDir":" \t\r\n "}"#,
        ] {
            std::fs::write(temp.path().join(SETTINGS_FILE), payload).expect("write settings");
            let settings = load(temp.path());
            assert_eq!(
                settings.download_dir.as_deref(),
                Some("~/Download/OToolsLocalSend"),
                "missing/null/blank directory must normalize: {payload}"
            );
            assert!(!temp.path().join("Download").exists());
        }
        let absent_data_dir = temp.path().join("not-created");
        assert_eq!(
            load(&absent_data_dir).download_dir.as_deref(),
            Some("~/Download/OToolsLocalSend")
        );
        assert!(
            !absent_data_dir.exists(),
            "load must not create directories"
        );
    }

    #[test]
    fn settings_save_normalizes_blank_download_dir_and_preserves_custom() {
        let temp = tempfile::tempdir().expect("temp dir");
        for download_dir in [None, Some("".into()), Some(" \t ".into())] {
            Settings {
                download_dir,
                ..Default::default()
            }
            .save(temp.path())
            .expect("save settings");
            let saved: serde_json::Value = serde_json::from_slice(
                &std::fs::read(temp.path().join(SETTINGS_FILE)).expect("saved settings"),
            )
            .expect("settings JSON");
            assert_eq!(saved["downloadDir"], "~/Download/OToolsLocalSend");
        }
        let custom = temp.path().join("custom downloads");
        let settings = Settings {
            download_dir: Some(custom.to_string_lossy().into_owned()),
            ..Default::default()
        };
        settings.save(temp.path()).expect("custom settings");
        assert_eq!(load(temp.path()), settings);
        assert!(
            !custom.exists(),
            "settings persistence must not create downloads"
        );
    }

    #[test]
    fn settings_normalized_fills_blank_but_preserves_custom_download_dir() {
        let temp = tempfile::tempdir().expect("temp dir");
        let custom = temp.path().join("custom").to_string_lossy().into_owned();
        for value in [None, Some("".into()), Some(" \t\n ".into())] {
            assert_eq!(
                Settings {
                    download_dir: value,
                    ..Default::default()
                }
                .normalized()
                .download_dir
                .as_deref(),
                Some("~/Download/OToolsLocalSend")
            );
        }
        assert_eq!(
            Settings {
                download_dir: Some(custom.clone()),
                ..Default::default()
            }
            .normalized()
            .download_dir,
            Some(custom)
        );
    }

    #[test]
    fn settings_download_dir_resolves_injected_home_without_mkdir() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("injected-home");
        let expected = home.join("Download").join("OToolsLocalSend");
        for value in [
            None,
            Some(""),
            Some(" \t "),
            Some("~/Download/OToolsLocalSend"),
            Some("~\\Download\\OToolsLocalSend"),
        ] {
            assert_eq!(
                resolve_download_dir(value, &home).expect("resolve default"),
                expected
            );
        }
        assert_eq!(resolve_download_dir(Some("~"), &home).expect("home"), home);
        let custom = temp.path().join("custom downloads");
        assert_eq!(
            resolve_download_dir(Some(custom.to_str().unwrap()), &home).expect("custom"),
            custom
        );
        assert!(
            !home.exists(),
            "resolution must not create the injected home"
        );
        assert!(
            !custom.exists(),
            "resolution must not create a custom directory"
        );
    }

    #[test]
    fn settings_runtime_snapshot_expands_home_without_mutating_stored_default() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let stored = Settings {
            download_dir: None,
            alias: "Keep alias".into(),
            ..Default::default()
        }
        .normalized();
        let runtime = stored.for_runtime(&home).expect("runtime snapshot");
        let expanded = home.join("Download").join("OToolsLocalSend");
        assert_eq!(runtime.download_dir.as_deref(), expanded.to_str());
        assert_eq!(
            stored.download_dir.as_deref(),
            Some("~/Download/OToolsLocalSend")
        );
        assert_eq!(runtime.alias, "Keep alias");
        assert!(!home.exists());
        assert!(Settings {
            download_dir: Some("relative".into()),
            ..Default::default()
        }
        .for_runtime(&home)
        .is_err());
        assert!(resolve_download_dir(None, std::path::Path::new("relative-home")).is_err());
    }

    #[test]
    fn settings_download_dir_rejects_nonlocal_relative_ads_and_control_paths() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let ads = format!("{}:stream", temp.path().join("file").display());
        let newline = format!("{}\nfile", temp.path().display());
        for value in [
            "relative",
            "./relative",
            "../relative",
            "~other/Download",
            "https://example.test/download",
            "file:///C:/Download",
            "ftp://example.test/file",
            "//server/share",
            "\\\\server\\share",
            "\\\\?\\C:\\Download",
            "\\\\.\\C:\\Download",
            "C:relative",
            "C:\\Download\\file:stream",
            "\\Download",
            "/\\server/share",
            "\\/server/share",
            ads.as_str(),
            newline.as_str(),
        ] {
            assert!(
                resolve_download_dir(Some(value), &home).is_err(),
                "unsafe path accepted: {value:?}"
            );
        }
        assert!(!home.exists());
    }

    #[test]
    fn settings_default_fill() {
        let temp = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            temp.path().join(SETTINGS_FILE),
            r#"{"alias":"测试机"}"#.as_bytes(),
        )
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
        let _env_guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
        assert_eq!(
            resolve_data_dir().expect("override"),
            PathBuf::from(temp.path())
        );
        std::env::remove_var("OTOOLS_DATA_DIR");
        if let Some(value) = previous {
            std::env::set_var("OTOOLS_DATA_DIR", value);
        }
    }
}
