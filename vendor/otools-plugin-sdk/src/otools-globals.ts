export type OToolsPlatform = "macos" | "windows" | "linux" | "unknown";

export interface OToolsDialogFilter {
  name: string;
  extensions: string[];
}

export interface OToolsDialogButtons {
  ok?: string;
}

export interface OToolsDialogOpenOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: OToolsDialogFilter[];
}

export interface OToolsDialogSaveOptions {
  title?: string;
  defaultPath?: string;
  filters?: OToolsDialogFilter[];
}

export interface OToolsDialogMessageOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  buttons?: OToolsDialogButtons;
}

export interface OToolsDialogConfirmOptions
  extends OToolsDialogMessageOptions {
  cancelLabel?: string;
}

export interface OToolsDialogAPI {
  open(
    options?: OToolsDialogOpenOptions,
  ): Promise<string | string[] | null>;
  save(options?: OToolsDialogSaveOptions): Promise<string | null>;
  message(
    messageText: string,
    options?: string | OToolsDialogMessageOptions,
  ): Promise<void>;
  confirm(
    messageText: string,
    options?: string | OToolsDialogConfirmOptions,
  ): Promise<boolean>;
  ask(
    messageText: string,
    options?: string | OToolsDialogConfirmOptions,
  ): Promise<boolean>;
}

export interface OToolsShellAPI {
  open?(path: string, openWith?: string): Promise<void>;
  openPath?(fullPath: string): Promise<void>;
  showItemInFolder?(fullPath: string): Promise<void>;
  trashItem?(fullPath: string): Promise<void>;
  openExternal?(url: string): Promise<void>;
  beep?(): Promise<void>;
}

export interface OToolsRuntimeAPI {
  dialog?: OToolsDialogAPI | null;
  shell?: OToolsShellAPI | null;
}

export interface OToolsHostDirEntry {
  name: string;
  path: string;
  kind: string;
  size: number;
  mime: string;
  lastModified?: number | null;
}

export interface OToolsHostReadFilePayload {
  path: string;
  name: string;
  size: number;
  mime: string;
  lastModified?: number | null;
  dataBase64: string;
}

export interface OToolsHostWriteFileRequest {
  path: string;
  dataBase64: string;
}

export interface OToolsHostBrowsePayload {
  currentPath: string;
  parentPath?: string | null;
  fileName?: string | null;
  roots: { path: string; name: string }[];
  entries: OToolsHostDirEntry[];
}

export interface OToolsEnv {
  runtime?: "web" | "desktop" | string;
  appName?: string;
  appVersion?: string;
  nativeId?: string;
  pluginUuid?: string;
  platform?: OToolsPlatform | string;
  isDev?: boolean;
  currentFolderPath?: string;
  currentBrowserUrl?: string;
  paths?: Record<string, string>;
}

export interface OToolsAPI {
  capture?: import('./capture-factory').CaptureApi;
  isDev(): boolean;
  isMacOS(): boolean;
  isWindows(): boolean;
  isLinux(): boolean;
  getAppName?(): string;
  getAppVersion?(): string;
  getPluginUuid?(): string;
  shellOpen?(path: string, openWith?: string): Promise<void>;
  listHostDir?(path: string): Promise<OToolsHostDirEntry[]>;
  readHostFile?(path: string): Promise<OToolsHostReadFilePayload>;
  browseHostDir?(path: string): Promise<OToolsHostBrowsePayload>;
  writeHostFile?(request: OToolsHostWriteFileRequest): Promise<void>;
  invokeNative<T = unknown>(method: string, payload?: unknown): Promise<T>;
  invokeNativePlugin?<T = unknown>(
    uuid: string,
    method: string,
    payload?: unknown,
  ): Promise<T>;
  invokeNativeRaw<T = unknown>(method: string, payload?: unknown): Promise<T>;
  reloadNative(): Promise<unknown>;
  probeNative(): Promise<unknown>;
  shellOpenExternal(url: string): void;
  shellOpenPath(fullPath: string): void;
  shellShowItemInFolder?(fullPath: string): void;
  listenNative?(
    handler: (
      event:
        | {
            event?: string;
            id?: number;
            payload?: {
              topic?: string;
              payload?: unknown;
            };
          }
        | unknown,
    ) => void,
    options?: unknown,
  ): Promise<() => Promise<void> | void>;
  getPluginLocalState<T = unknown>(
    plugin?: string,
    scheme?: string | null,
  ): Promise<T | null>;
  savePluginLocalState(
    plugin?: string,
    state?: unknown,
    scheme?: string | null,
  ): Promise<void>;
  getPluginLocalStateValue<T = unknown>(
    plugin?: string,
    key?: string,
    scheme?: string | null,
  ): Promise<T | null>;
  savePluginLocalStateValue(
    plugin?: string,
    key?: string,
    value?: unknown,
    scheme?: string | null,
  ): Promise<void>;
  patchPluginLocalState(
    plugin?: string,
    patch?: Record<string, unknown>,
    scheme?: string | null,
  ): Promise<void>;
  runtime?: OToolsRuntimeAPI;
  dialog?: OToolsDialogAPI;
  shell?: OToolsShellAPI;
}

export interface TauriInternals {
  metadata?: {
    currentWindow?: { label?: string };
    currentWebview?: { label?: string };
  };
  invoke<T = unknown>(
    command: string,
    payload?: Record<string, unknown>,
    options?: unknown,
  ): Promise<T>;
  transformCallback?(
    callback: (response: { payload?: unknown } | unknown) => void,
    once?: boolean,
  ): number;
  unregisterCallback?(id: number): void;
}

export interface TauriEventPluginInternals {
  unregisterListener(event: string, eventId: number): void;
}

declare global {
  interface Window {
    otools?: OToolsAPI;
    utools?: OToolsAPI;
    __OToolsEnv?: OToolsEnv;
    __OTOOLS_CUSTOM_WINDOW__?: {
      pluginUuid: string;
      pluginSource: string;
      windowId: string;
    };
    __TAURI_INTERNALS__?: TauriInternals;
    __TAURI_EVENT_PLUGIN_INTERNALS__: TauriEventPluginInternals;
  }
}
