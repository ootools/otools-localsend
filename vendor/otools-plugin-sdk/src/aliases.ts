export function createOtoolsAliasMap() {
  return {
    "@tauri-apps/api/core": "otools-plugin-sdk/tauri-core-shim",
    "@tauri-apps/api/event": "otools-plugin-sdk/tauri-event-shim",
    "@tauri-apps/api/window": "otools-plugin-sdk/tauri-window-shim",
    "@tauri-apps/api/webview": "otools-plugin-sdk/tauri-webview-shim",
    "@tauri-apps/api/webviewWindow": "otools-plugin-sdk/tauri-webview-window-shim",
    "@tauri-apps/api/app": "otools-plugin-sdk/tauri-app-shim",
    "@tauri-apps/plugin-dialog": "otools-plugin-sdk/tauri-plugin-dialog-shim",
    "@tauri-apps/plugin-opener": "otools-plugin-sdk/tauri-plugin-opener-shim",
    "@tauri-apps/plugin-process": "otools-plugin-sdk/tauri-plugin-process-shim",
    "@tauri-apps/plugin-updater": "otools-plugin-sdk/tauri-plugin-updater-shim",
  } as const;
}
