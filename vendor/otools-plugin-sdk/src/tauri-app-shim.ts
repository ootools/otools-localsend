function resolveVersion() {
  if (typeof window === "undefined") {
    return "unknown";
  }
  return (
    window.otools?.getAppVersion?.() ??
    window.utools?.getAppVersion?.() ??
    window.__OToolsEnv?.appVersion ??
    "unknown"
  );
}

export async function getVersion() {
  return resolveVersion();
}

export async function getName() {
  if (typeof window === "undefined") {
    return "OTools";
  }
  return (
    window.otools?.getAppName?.() ??
    window.utools?.getAppName?.() ??
    window.__OToolsEnv?.appName ??
    "OTools"
  );
}
