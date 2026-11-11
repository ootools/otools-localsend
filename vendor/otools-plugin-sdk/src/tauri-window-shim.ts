import { LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Position, Size } from "@tauri-apps/api/dpi";
import { ensurePopupManager, resolvePopupWindowIdentity } from "./popup-manager";
import { invokeTauri, listen as listenRuntime, listenTauri, type Event, type UnlistenFn } from "./runtime";

export { LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Position, Size };
export type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";
type PositionLike = { x: number; y: number; type?: "Logical" | "Physical" };
type SizeLike = { width: number; height: number; type?: "Logical" | "Physical" };
export const hasTauriWindowApi = () => typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
export const resolveWindowLabel = () => {
  if (typeof window === "undefined") return "";
  return resolvePopupWindowIdentity()?.label
    ?? window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label
    ?? "";
};

/** A handle to one window. WebviewWindow supplies its asynchronous native label. */
export class Window {
  label: string;
  protected ready: Promise<void> = Promise.resolve();
  constructor(label: string) { this.label = label; }

  protected async invokeWindow<T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    return invokeTauri<T>(`plugin:window|${command}`, { label: this.label, ...args });
  }
  protected async control(command: string, args: Record<string, unknown> = {}): Promise<void> {
    await this.ready;
    if (hasTauriWindowApi()) await this.invokeWindow(command, args);
  }
  async close(): Promise<void> {
    await this.ready;
    if (hasTauriWindowApi()) await this.invokeWindow("close");
    else if (typeof window !== "undefined") {
      if (this.label) ensurePopupManager().closeLabel(this.label);
      else ensurePopupManager().closeCurrent(window);
    }
  }
  async destroy(): Promise<void> {
    if (hasTauriWindowApi()) await this.invokeWindow("destroy");
    else await this.close();
  }
  show() { return this.control("show"); }
  hide() { return this.control("hide"); }
  setFocus() { return this.control("set_focus"); }
  setAlwaysOnTop(value: boolean) { return this.control("set_always_on_top", { value }); }
  setVisibleOnAllWorkspaces(value: boolean) { return this.control("set_visible_on_all_workspaces", { value }); }
  setIgnoreCursorEvents(value: boolean) { return this.control("set_ignore_cursor_events", { value }); }
  setPosition(position: PositionLike | Position) {
    const value = position instanceof Position ? position.toJSON() : {
      [position.type ?? "Physical"]: { x: position.x, y: position.y },
    };
    return this.control("set_position", { value });
  }
  setSize(size: SizeLike | Size) {
    const value = size instanceof Size ? size.toJSON() : {
      [size.type ?? "Physical"]: { width: size.width, height: size.height },
    };
    return this.control("set_size", { value });
  }
  async outerPosition(): Promise<PhysicalPosition> {
    if (hasTauriWindowApi()) return new PhysicalPosition(await this.invokeWindow<PositionLike>("outer_position"));
    const scale = await this.scaleFactor();
    return new PhysicalPosition(typeof window === "undefined" ? 0 : window.screenX * scale, typeof window === "undefined" ? 0 : window.screenY * scale);
  }
  async innerSize(): Promise<PhysicalSize> {
    if (hasTauriWindowApi()) return new PhysicalSize(await this.invokeWindow<SizeLike>("inner_size"));
    const scale = await this.scaleFactor();
    return new PhysicalSize(typeof window === "undefined" ? 0 : window.innerWidth * scale, typeof window === "undefined" ? 0 : window.innerHeight * scale);
  }
  async scaleFactor(): Promise<number> {
    return hasTauriWindowApi() ? this.invokeWindow<number>("scale_factor") : typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  }
  minimize() { return this.control("minimize"); }
  toggleMaximize() { return this.control("toggle_maximize"); }
  async isMaximized(): Promise<boolean> { return hasTauriWindowApi() ? this.invokeWindow<boolean>("is_maximized") : false; }
  center() { return this.control("center"); }
  startDragging() { return this.control("start_dragging"); }
  startResizeDragging(value: ResizeDirection) { return this.control("start_resize_dragging", { value }); }
  async listen<T>(event: string, handler: (event: Event<T>) => void | Promise<void>): Promise<UnlistenFn> {
    await this.ready;
    if (!hasTauriWindowApi()) return () => {};
    if (event === "otools:custom-open" && window.__OTOOLS_CUSTOM_WINDOW__) {
      return listenRuntime(event, handler);
    }
    return listenTauri(event, handler, { target: { kind: "Window", label: this.label } });
  }
  async once<T>(event: string, handler: (event: Event<T>) => void | Promise<void>): Promise<UnlistenFn> {
    let active = true;
    let stop: UnlistenFn | undefined;
    const unlisten = await this.listen<T>(event, (value) => {
      if (!active) return;
      active = false;
      void stop?.();
      void handler(value);
    });
    stop = unlisten;
    if (!active) await stop();
    return async () => { active = false; await unlisten(); };
  }
  onMoved(handler: (event: Event<PhysicalPosition>) => void | Promise<void>) {
    return this.listen<PositionLike>("tauri://move", event => handler({ ...event, payload: new PhysicalPosition(event.payload) }));
  }
  onResized(handler: (event: Event<PhysicalSize>) => void | Promise<void>) {
    return this.listen<SizeLike>("tauri://resize", event => handler({ ...event, payload: new PhysicalSize(event.payload) }));
  }
}

export function getCurrentWindow(): Window { return new Window(resolveWindowLabel()); }

export interface Monitor {
  name: string | null;
  size: PhysicalSize;
  position: PhysicalPosition;
  workArea: { position: PhysicalPosition; size: PhysicalSize };
  scaleFactor: number;
}
export async function availableMonitors(): Promise<Monitor[]> {
  if (hasTauriWindowApi()) {
    const monitors = await invokeTauri<Array<{
      name: string | null; size: SizeLike; position: PositionLike;
      workArea?: { position: PositionLike; size: SizeLike }; scaleFactor: number;
    }>>("plugin:window|available_monitors");
    return monitors.map(monitor => ({
      ...monitor,
      size: new PhysicalSize(monitor.size),
      position: new PhysicalPosition(monitor.position),
      workArea: {
        position: new PhysicalPosition(monitor.workArea?.position ?? monitor.position),
        size: new PhysicalSize(monitor.workArea?.size ?? monitor.size),
      },
    }));
  }
  if (typeof window === "undefined") return [];
  const scaleFactor = window.devicePixelRatio || 1;
  const size = new PhysicalSize((window.screen.width || window.innerWidth) * scaleFactor, (window.screen.height || window.innerHeight) * scaleFactor);
  const position = new PhysicalPosition(0, 0);
  return [{ name: null, size, position, workArea: { size, position }, scaleFactor }];
}
