export { invoke } from "./runtime";
export { registerTransformCallback as transformCallback } from "./native-event-bridge";
import type { TauriInternals } from "./otools-globals";

const getTauriInternals = (): TauriInternals | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.__TAURI_INTERNALS__;
};

export const isTauri = (): boolean =>
  typeof getTauriInternals()?.invoke === "function";

const REMOTE_SERVICE_FILE_ROUTE = "/__tauri_remote_service_file__";

const trimRightSlash = (value: string): string => value.replace(/\/+$/, "");

const isLocalFilePath = (value: string): boolean =>
  String(value || "").startsWith("/") || /^[A-Za-z]:[\\/]/.test(String(value || ""));

const normalizeLocalFilePath = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) {
    return raw;
  }

  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      let path = decodeURIComponent(url.pathname);
      if (path.startsWith("/") && /^[A-Za-z]:/.test(path.slice(1))) {
        path = path.slice(1);
      }
      return path;
    } catch {
      return raw;
    }
  }

  return raw;
};

const buildRemoteFileUrl = (path: string): string => {
  const normalized = normalizeLocalFilePath(path);
  if (!isLocalFilePath(normalized)) {
    return normalized;
  }

  const origin =
    typeof window !== "undefined" ? trimRightSlash(window.location.origin || "") : "";
  if (!origin) {
    return normalized;
  }

  return `${origin}${REMOTE_SERVICE_FILE_ROUTE}?path=${encodeURIComponent(normalized)}`;
};

/**
 * Convert a local filesystem path to a URL loadable by the webview.
 *
 * Mirrors `convertFileSrc` from `@tauri-apps/api/core` for the native Tauri
 * runtime and falls back to the otools remote-service file route so the same
 * call works in the otools plugin runtime.
 */
export const convertFileSrc = (filePath: string, protocol = "asset"): string => {
  const normalized = normalizeLocalFilePath(filePath);
  if (!isTauri()) {
    return buildRemoteFileUrl(normalized);
  }

  const path = encodeURIComponent(normalized);
  return navigator.userAgent.includes("Windows")
    ? `http://${protocol}.localhost/${path}`
    : `${protocol}://localhost/${path}`;
};
