export { emit, listen, type Event, type UnlistenFn, type ListenOptions, type EventTarget } from "./runtime";

export const TauriEvent = {
  DRAG_ENTER: "tauri://drag-enter",
  DRAG_OVER: "tauri://drag-over",
  DRAG_DROP: "tauri://drag-drop",
  DRAG_LEAVE: "tauri://drag-leave",
} as const;
