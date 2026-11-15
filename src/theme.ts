type ThemeMode = "system" | "light" | "dark";
type ThemeAccent = "classic" | "violet" | "emerald" | "amber" | "pink";
type ResolvedTheme = "light" | "dark";
type HostTheme = { themeMode: ThemeMode; themeAccent: ThemeAccent; resolvedTheme: ResolvedTheme };
type HostWindow = Window & { __OTOOLS_THEME__?: unknown };

/** Missing system resolution is not permission to select the OS theme. */
function readTheme(value: unknown): HostTheme | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { themeMode, themeAccent, resolvedTheme } = value as Record<string, unknown>;
  if (themeMode !== "system" && themeMode !== "light" && themeMode !== "dark") return null;
  if (!["classic", "violet", "emerald", "amber", "pink"].includes(themeAccent as string)) return null;
  if (resolvedTheme !== undefined && resolvedTheme !== "light" && resolvedTheme !== "dark") return null;
  const resolved = resolvedTheme ?? (themeMode === "system" ? null : themeMode);
  if (!resolved) return null;
  return { themeMode, themeAccent: themeAccent as ThemeAccent, resolvedTheme: resolved };
}

/** Initialize before React mounts; only the two theme classes belong to this adapter. */
export function initializeTheme(hostWindow: HostWindow = window, themeDocument: Document = document): () => void {
  let latestTheme = readTheme(hostWindow.__OTOOLS_THEME__);
  let receivedEvent = false;

  const apply = (theme: HostTheme | null) => {
    const root = themeDocument.documentElement;
    if (!root) return;
    const resolved = theme?.resolvedTheme ?? (root.classList.contains("dark") ? "dark" : "light");
    root.classList.toggle("light", resolved === "light");
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    if (theme) {
      root.dataset.themeMode = theme.themeMode;
      root.dataset.themeAccent = theme.themeAccent;
    }
  };
  const accept = (value: unknown) => {
    const theme = readTheme(value);
    if (!theme) return;
    receivedEvent = true;
    latestTheme = theme;
    apply(theme);
  };
  const onNativeTheme = (event: Event) => accept((event as CustomEvent<unknown>).detail);
  const onMessage = (event: MessageEvent<unknown>) => {
    // Plugin and host can be cross-origin; trust the direct parent identity, not message origin.
    if (hostWindow.parent === hostWindow || event.source !== hostWindow.parent) return;
    if (!event.data || typeof event.data !== "object" || (event.data as Record<string, unknown>).type !== "otools:theme-sync") return;
    accept(event.data);
  };
  const onReady = () => {
    themeDocument.removeEventListener("DOMContentLoaded", onReady);
    // The host may publish its snapshot before <html> exists. Never replay it over newer events.
    if (!receivedEvent) latestTheme = readTheme(hostWindow.__OTOOLS_THEME__) ?? latestTheme;
    apply(latestTheme);
  };

  hostWindow.addEventListener("otools-theme-changed", onNativeTheme);
  hostWindow.addEventListener("message", onMessage);
  if (themeDocument.documentElement) apply(latestTheme);
  else themeDocument.addEventListener("DOMContentLoaded", onReady, { once: true });

  return () => {
    hostWindow.removeEventListener("otools-theme-changed", onNativeTheme);
    hostWindow.removeEventListener("message", onMessage);
    themeDocument.removeEventListener("DOMContentLoaded", onReady);
  };
}
