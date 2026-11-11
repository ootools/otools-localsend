import type { WindowOptions } from "@tauri-apps/api/window";
import type { WebviewOptions } from "@tauri-apps/api/webview";
import { Window, hasTauriWindowApi, resolveWindowLabel } from "./tauri-window-shim";
import { invokeTauri, type Event, type UnlistenFn } from "./runtime";
import { ensurePopupManager, resolvePopupWindowIdentity } from "./popup-manager";

export type WebviewWindowOptions = Omit<WebviewOptions, "x" | "y" | "width" | "height"> &
  Omit<WindowOptions, "parent"> & { parent?: string | { label: string }; ignoreCursorEvents?: boolean };
type ManagedWindow = { label: string; windowId: string };
type LifecycleListener = { handler: (event: Event<unknown>) => void | Promise<void>; once: boolean };
const customContext = () => typeof window === "undefined" ? undefined : window.__OTOOLS_CUSTOM_WINDOW__;
const existingHandle = Symbol("existing window");

export class WebviewWindow extends Window {
  windowId: string;
  private readonly lifecycle = new Map<string, Set<LifecycleListener>>();

  constructor(windowId: string, options: WebviewWindowOptions = {}, existing?: typeof existingHandle) {
    super(windowId);
    this.windowId = windowId;
    if (existing === existingHandle) return;
    this.ready = Promise.resolve().then(async () => {
      if (hasTauriWindowApi()) {
        if (customContext()) {
          const { title, url, ...windowOptions } = options;
          const result = await invokeTauri<ManagedWindow>("open_custom_plugin_window", {
            windowId, ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }), options: windowOptions,
          });
          this.label = result.label;
          this.windowId = result.windowId;
        } else {
          await invokeTauri("plugin:webview|create_webview_window", {
            options: { ...options, parent: typeof options.parent === "string" ? options.parent : options.parent?.label, label: windowId },
          });
        }
      } else {
        if (typeof window === "undefined") throw new Error("Window creation is unavailable outside a browser or Tauri runtime");
        const manager = ensurePopupManager();
        if (!manager.getAll().some(popup => popup.label === windowId)) {
          manager.open(options.url ?? window.location.href, "webview-window", undefined, windowId);
        }
      }
    });
    // Observe rejection even if the caller only subscribes to the error event.
    void this.ready.then(
      () => this.dispatchLifecycle("tauri://created", null),
      error => this.dispatchLifecycle("tauri://error", error),
    );
  }

  private dispatchLifecycle(event: string, payload: unknown) {
    const listeners = this.lifecycle.get(event);
    for (const listener of [...listeners ?? []]) {
      if (listener.once) listeners?.delete(listener);
      void listener.handler({ event, id: -1, payload });
    }
  }
  private lifecycleListener<T>(event: string, handler: (event: Event<T>) => void | Promise<void>, once: boolean): Promise<UnlistenFn> {
    const listeners = this.lifecycle.get(event) ?? new Set<LifecycleListener>();
    this.lifecycle.set(event, listeners);
    const listener: LifecycleListener = { handler: handler as LifecycleListener["handler"], once };
    listeners.add(listener);
    return Promise.resolve(() => { listeners.delete(listener); });
  }
  override listen<T>(event: string, handler: (event: Event<T>) => void | Promise<void>): Promise<UnlistenFn> {
    if (event === "tauri://created" || event === "tauri://error") return this.lifecycleListener(event, handler, false);
    return super.listen(event, handler);
  }
  override once<T>(event: string, handler: (event: Event<T>) => void | Promise<void>): Promise<UnlistenFn> {
    if (event === "tauri://created" || event === "tauri://error") return this.lifecycleListener(event, handler, true);
    return super.once(event, handler);
  }
  override async close(): Promise<void> {
    await this.ready;
    if (hasTauriWindowApi() || !this.label) await super.close();
    else ensurePopupManager().closeLabel(this.label);
  }
  override async destroy(): Promise<void> {
    if (hasTauriWindowApi()) await super.destroy();
    else await this.close();
  }
  static getCurrent() { return getCurrentWebviewWindow(); }
  static getAll() { return getAllWebviewWindows(); }
  static async getByLabel(label: string): Promise<WebviewWindow | null> {
    const windows = await getAllWebviewWindows();
    return windows.find(instance => instance.label === label)
      ?? windows.find(instance => instance.windowId === label)
      ?? null;
  }
}

function handle(record: ManagedWindow): WebviewWindow {
  const instance = new WebviewWindow(record.label, {}, existingHandle);
  instance.windowId = record.windowId;
  return instance;
}

export function getCurrentWebviewWindow(): WebviewWindow {
  const popup = resolvePopupWindowIdentity();
  const label = popup?.label ?? resolveWindowLabel();
  return handle({ label, windowId: popup?.windowId ?? customContext()?.windowId ?? label });
}

export async function getAllWebviewWindows(): Promise<WebviewWindow[]> {
  if (hasTauriWindowApi()) {
    if (customContext()) return (await invokeTauri<ManagedWindow[]>("list_custom_plugin_windows", {})).map(handle);
    return (await invokeTauri<string[]>("plugin:window|get_all_windows")).map(label => handle({ label, windowId: label }));
  }
  if (typeof window === "undefined") return [];
  return ensurePopupManager().getAll().map(popup => handle({ label: popup.label!, windowId: popup.label! }));
}
