import {
  attachTransformListener,
  detachTransformListener,
  listenNativeTopic,
} from "./native-event-bridge";
import type {
  OToolsAPI,
  OToolsShellAPI,
  TauriInternals,
} from "./otools-globals";
import { ensurePopupManager } from "./popup-manager";

type InvokePayload = unknown;
type LocalEventDetail = { payload: unknown };
type EventPayload = Record<string, unknown>;

const LOCAL_EVENT_PREFIX = "otools:";
const LOCAL_TAURI_EVENT_PREFIX = "otools-tauri:";
const TAURI_LISTEN_TARGET = { kind: "Any" } as const;
// Gallery editors are separate host webviews. Their update event must cross the
// Tauri event bus rather than the plugin dylib/local DOM event bridge.
const HOST_OWNED_EVENTS = new Set(['crop-images-updated', 'otools:custom-open']);

const DIRECT_TAURI_NOOP_COMMANDS = new Set([
  "set_window_theme",
  "update_tray_menu",
]);

const POPUP_COMMANDS = new Set([
  "open_commit_window",
  "open_merge_window",
  "open_settings_window",
  "open_stash_window",
  "open_push_window",
  "open_project_boot_window",
]);

const SHARED_HOST_COMMAND_NOT_HANDLED = Symbol(
  "shared-host-command-not-handled",
);

// Host-owned plugin state commands. These are Tauri commands registered by the
// core host, never by a plugin dylib, so they must not be routed to invokeNativePlugin.
const HOST_PLUGIN_STATE_COMMAND =
  /^(get|save|patch)_otools_plugin_(localstate|syncstate)(_value)?(_with_scheme)?$/;

const isBrowserWindowAvailable = () => typeof window !== "undefined";

// Build-time injected plugin identity (see scripts/otools-plugin-vite-config-sdk.ts).
// Kept as a loose typeof check so the module also runs unbundled (tests) where
// the define replacement never happened.
declare const __OTOOLS_PLUGIN_UUID__: string | undefined;

const readBuildTimePluginUuid = (): string => {
  try {
    return typeof __OTOOLS_PLUGIN_UUID__ === "string"
      ? normalizePluginUuid(__OTOOLS_PLUGIN_UUID__)
      : "";
  } catch {
    return "";
  }
};
const isTauriPluginCommand = (command: string) =>
  command.startsWith("plugin:");
const isHostPluginStateCommand = (command: string) =>
  HOST_PLUGIN_STATE_COMMAND.test(command);

// Host-owned capability commands. `otools_host_*` is the host's own naming
// convention: every one of them is registered by the core host's
// `generate_handler!` (the whole crop / screenshot surface, TTS, clipboard,
// ...) and **no plugin dylib implements it**.
//
// Why this must bypass the native bridge: a pure front-end plugin has no native
// library at all, so `invokeNativePlugin` makes the host answer
// "插件 native 配置未启用" - a message that is deliberately NOT in the fallback
// list below, so the call dies instead of retrying through the host path.
// Plugins that *do* ship a native library never hit this because the host
// answers "Unknown method" there, which the fallback does catch.
const HOST_OWNED_COMMAND_PREFIX = "otools_host_";
const HOST_OWNED_COMMANDS = new Set([
  'otools_copy_text',
  'hide_panel_window',
  'detach_tools_tab_to_window',
  'open_custom_plugin_window',
  'list_custom_plugin_windows',
  'close_custom_plugin_windows',
  'custom_plugin_window_ready',
  'register_tools_tab_close_hook',
  'resolve_tools_tab_close_ack',
]);
const isHostOwnedCommand = (command: string) =>
  command.startsWith(HOST_OWNED_COMMAND_PREFIX) || HOST_OWNED_COMMANDS.has(command);
const normalizePluginUuid = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  const splitAt = raw.lastIndexOf(":");
  if (splitAt <= 0 || splitAt >= raw.length - 1) {
    return raw;
  }

  const source = raw.slice(0, splitAt).trim().toLowerCase();
  const pluginId = raw.slice(splitAt + 1).trim();
  if (!pluginId) {
    return raw;
  }

  if (
    source === "builtin" ||
    source === "market" ||
    source === "dev-debug" ||
    source === "dev-workspace"
  ) {
    return pluginId;
  }

  return raw;
};

const collectErrorText = (error: unknown): string => {
  const parts: string[] = [];
  const text = String(error ?? "");
  if (text) {
    parts.push(text);
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = String(record.message ?? "");
    const code = String(record.code ?? "");
    const detail = String(record.detail ?? "");
    if (message) {
      parts.push(message);
    }
    if (code) {
      parts.push(code);
    }
    if (detail) {
      parts.push(detail);
    }
  }
  return parts.join(" | ");
};

const shouldFallbackToNativeInvoke = (error: unknown): boolean => {
  const lower = collectErrorText(error).toLowerCase();
  if (!lower) {
    return false;
  }

  return (
    lower.includes("not allowed") ||
    lower.includes("command not found") ||
    lower.includes("unknown method") ||
    lower.includes("unknown command")
  );
};

// The native plugin bridge only owns the plugin's own methods. When it answers
// "Unknown method" (or the host rejects the call) the command belongs to the
// host runtime, so it has to be retried through the host Tauri invoke path.
// Anything else - including the "requires AppHandle" sentinel - is a real
// plugin-side failure and must surface unchanged.
const shouldFallbackToHostInvoke = (error: unknown): boolean =>
  shouldFallbackToNativeInvoke(error);

export const getOtoolsApi = (): OToolsAPI | undefined => {
  if (!isBrowserWindowAvailable()) {
    return undefined;
  }
  for (const candidate of resolveOtoolsRuntimeCandidates()) {
    const api = candidate.otools ?? candidate.utools;
    if (api) {
      return api;
    }
  }
  return undefined;
};

export const isOtoolsPluginRuntime = (): boolean =>
  typeof getOtoolsApi()?.invokeNative === "function";

/** The host marks remote plugin pages explicitly; desktop keeps native dialogs. */
export const isOtoolsRemoteRuntime = (): boolean => {
  for (const candidate of resolveOtoolsRuntimeCandidates()) {
    try {
      const runtime = candidate.__OToolsEnv?.runtime;
      if (runtime) return runtime === "web";
    } catch {
      // A cross-origin parent cannot supply runtime context.
    }
  }
  return false;
};

const resolveOtoolsRuntimeCandidates = (): Array<Window & { otools?: OToolsAPI; utools?: OToolsAPI }> => {
  if (!isBrowserWindowAvailable()) {
    return [];
  }

  const candidates: Array<Window & { otools?: OToolsAPI; utools?: OToolsAPI }> = [
    window as Window & { otools?: OToolsAPI; utools?: OToolsAPI },
  ];

  for (const resolver of [() => window.parent, () => window.top]) {
    try {
      const candidate = resolver() as Window & { otools?: OToolsAPI; utools?: OToolsAPI } | null;
      if (!candidate || candidate === window || candidates.includes(candidate)) {
        continue;
      }
      candidates.push(candidate);
    } catch {
      // Ignore cross-origin or sandboxed ancestor access.
    }
  }

  return candidates;
};

const hasPluginRuntimeHint = (): boolean => {
  if (!isBrowserWindowAvailable()) {
    return false;
  }

  try {
    const env = window.__OToolsEnv;
    if (typeof env?.pluginUuid === "string" && env.pluginUuid.trim()) {
      return true;
    }
    const params = new URLSearchParams(window.location.search || "");
    return Boolean(
      params.get("plugin") || params.get("pluginUuid") || params.get("plugin_uuid"),
    );
  } catch {
    return false;
  }
};

const waitForOtoolsApi = async (timeoutMs = 1200): Promise<OToolsAPI | undefined> => {
  if (!isBrowserWindowAvailable()) {
    return undefined;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    for (const candidate of resolveOtoolsRuntimeCandidates()) {
      const api = candidate.otools ?? candidate.utools;
      if (typeof api?.invokeNative === "function" || typeof api?.invokeNativePlugin === "function") {
        return api;
      }
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 20);
    });
  }

  return getOtoolsApi();
};

const readPluginUuidFromContext = (runtime: OToolsAPI | undefined) => {
  const fromRuntime = normalizePluginUuid(runtime?.getPluginUuid?.());
  if (fromRuntime) {
    return fromRuntime;
  }

  if (!isBrowserWindowAvailable()) {
    return readBuildTimePluginUuid();
  }

  try {
    const env = window.__OToolsEnv;
    const fromEnv = normalizePluginUuid(env?.pluginUuid);
    if (fromEnv) {
      return fromEnv;
    }
    const params = new URLSearchParams(window.location.search || "");
    const fromParams = normalizePluginUuid(
      params.get("plugin") ||
      params.get("pluginUuid") ||
      params.get("plugin_uuid") ||
      "",
    );
    if (fromParams) {
      return fromParams;
    }
  } catch {
    // Fall through to the build-time identity below.
  }

  return readBuildTimePluginUuid();
};

const getTauriInternals = (): TauriInternals | undefined => {
  if (!isBrowserWindowAvailable()) {
    return undefined;
  }
  return window.__TAURI_INTERNALS__;
};

const createLocalEventName = (event: string) => `${LOCAL_EVENT_PREFIX}${event}`;
const createLocalTauriEventName = (event: string) =>
  `${LOCAL_TAURI_EVENT_PREFIX}${event}`;

const emitLocalEvent = (event: string, payload: unknown) => {
  if (!isBrowserWindowAvailable()) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<LocalEventDetail>(createLocalEventName(event), {
      detail: { payload },
    }),
  );
};

const emitLocalTauriEvent = (event: string, payload: unknown) => {
  if (!isBrowserWindowAvailable()) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<LocalEventDetail>(createLocalTauriEventName(event), {
      detail: { payload },
    }),
  );
};

const asPayloadRecord = (payload: InvokePayload): EventPayload | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as EventPayload;
};

const readPayloadString = (
  command: string,
  payload: InvokePayload,
  key: string,
  allowEmpty = false,
) => {
  const value = asPayloadRecord(payload)?.[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${command} requires ${key}`);
  }
  return value;
};

const decodeUtf8Base64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

const encodeUtf8Base64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(chunks.join(""));
};

const invokeSharedHostFilesystemCommand = async (
  otools: OToolsAPI,
  command: string,
  payload: InvokePayload,
): Promise<unknown | typeof SHARED_HOST_COMMAND_NOT_HANDLED> => {
  if (
    command === "read_directory_recursive" &&
    typeof otools.listHostDir === "function"
  ) {
    const path = readPayloadString(command, payload, "path");
    const entries = await otools.listHostDir(path);
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const isDirectory = entry.kind === "directory";
        return {
          id: entry.path,
          label: entry.name,
          path: entry.path,
          is_directory: isDirectory,
          isLeaf: !isDirectory,
        };
      });
  }

  if (
    command === "read_file_content" &&
    typeof otools.readHostFile === "function"
  ) {
    const filePath = readPayloadString(command, payload, "filePath");
    const result = await otools.readHostFile(filePath);
    return decodeUtf8Base64(result.dataBase64);
  }

  if (
    command === "write_file_content" &&
    typeof otools.writeHostFile === "function"
  ) {
    const filePath = readPayloadString(command, payload, "filePath");
    const content = readPayloadString(command, payload, "content", true);
    return otools.writeHostFile({
      path: filePath,
      dataBase64: encodeUtf8Base64(content),
    });
  }

  // 宿主文件系统浏览树：纯浏览器 / 远程访问时用来替代原生文件对话框。
  // 路径允许为空（空串表示让宿主返回 home）。
  if (
    command === "browse_dialog" &&
    typeof otools.browseHostDir === "function"
  ) {
    const path = String(
      (payload as Record<string, unknown> | null)?.path ?? "",
    ).trim();
    return otools.browseHostDir(path);
  }

  return SHARED_HOST_COMMAND_NOT_HANDLED;
};

const invokeHostPluginStateCommand = async (
  otools: OToolsAPI,
  command: string,
  payload: InvokePayload,
): Promise<unknown | typeof SHARED_HOST_COMMAND_NOT_HANDLED> => {
  const match = HOST_PLUGIN_STATE_COMMAND.exec(command);
  if (!match) {
    return SHARED_HOST_COMMAND_NOT_HANDLED;
  }

  const [, action, store, valueSuffix, schemeSuffix] = match;
  const method = `${action}Plugin${store === "localstate" ? "Local" : "Sync"}State${
    valueSuffix ? "Value" : ""
  }`;
  const handler = (otools as unknown as Record<string, unknown>)[method];
  if (typeof handler !== "function") {
    return SHARED_HOST_COMMAND_NOT_HANDLED;
  }

  const body = asPayloadRecord(payload);
  const plugin = typeof body?.plugin === "string" ? body.plugin : undefined;
  const scheme = schemeSuffix
    ? (typeof body?.scheme === "string" ? body.scheme : null)
    : null;

  const args: unknown[] = [plugin];
  if (action === "get") {
    if (valueSuffix) {
      args.push(body?.key);
    }
  } else if (action === "patch") {
    args.push(body?.patch ?? {});
  } else if (valueSuffix) {
    args.push(body?.key, body?.value ?? null);
  } else {
    args.push(body?.state ?? null);
  }
  args.push(scheme);

  return (handler as (...params: unknown[]) => Promise<unknown>).apply(
    otools,
    args,
  );
};

const emitSyntheticEventsAfterInvoke = (
  command: string,
  payload: InvokePayload,
  result: unknown,
) => {
  const body = asPayloadRecord(payload);

  if (command === "switch_provider" && body?.app && body?.id) {
    emitLocalEvent("provider-switched", {
      appType: body.app,
      providerId: body.id,
      source: "native-plugin",
      result,
    });
  }

  if (command === "sync_universal_provider" && body?.id) {
    emitLocalEvent("universal-provider-synced", {
      id: body.id,
      result,
    });
  }
};

export const invokeTauri = async <T>(
  command: string,
  payload?: InvokePayload,
): Promise<T> => {
  const internals = getTauriInternals();
  if (!internals?.invoke) {
    throw new Error("Tauri runtime is unavailable");
  }

  return internals.invoke<T>(
    command,
    payload as Record<string, unknown> | undefined,
  );
};

const invokeNativeWithHostFallback = async <T>(
  nativeInvoke: () => Promise<T>,
  command: string,
  payload: InvokePayload,
): Promise<T> => {
  try {
    return await nativeInvoke();
  } catch (error) {
    if (!shouldFallbackToHostInvoke(error) || !getTauriInternals()?.invoke) {
      throw error;
    }
    return invokeTauri<T>(command, payload);
  }
};

const normalizeTauriCallbackPayload = <T>(payload: unknown): T => {
  if (payload && typeof payload === "object" && "payload" in payload) {
    return ((payload as { payload?: unknown }).payload ?? null) as T;
  }
  return payload as T;
};

export type EventTarget =
  | { kind: "Any" | "AnyLabel"; label?: string }
  | { kind: "Window" | "Webview" | "WebviewWindow"; label: string };
export interface ListenOptions { target?: string | EventTarget }

export async function listenTauri<T>(
  event: string,
  handler: (event: Event<T>) => void | Promise<void>,
  options: ListenOptions = {},
): Promise<UnlistenFn> {
  const internals = getTauriInternals();
  if (!internals?.invoke || !internals.transformCallback) {
    throw new Error("Tauri event runtime is unavailable");
  }

  let active = true;
  const handlerId = internals.transformCallback((payload) => {
    if (!active) return;
    void handler({
      event,
      id: payload && typeof payload === "object" && "id" in payload
        ? Number(payload.id) : -1,
      payload: normalizeTauriCallbackPayload<T>(payload),
    });
  }, false);

  let eventId: number;
  try {
    eventId = await internals.invoke<number>("plugin:event|listen", {
      event,
      target: typeof options.target === "string"
        ? { kind: "AnyLabel", label: options.target }
        : options.target ?? TAURI_LISTEN_TARGET,
      handler: handlerId,
    });
  } catch (error) {
    internals.unregisterCallback?.(handlerId);
    throw error;
  }

  const unlisten = async () => {
    if (!active) return;
    active = false;
    try {
      await window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(
        event,
        eventId,
      );
    } catch {
      // The backend unlisten below still clears the server-side listener.
    }

    internals.unregisterCallback?.(handlerId);
    await internals.invoke("plugin:event|unlisten", {
      event,
      eventId,
    });
  };
  return unlisten;
}

let customOpenListeners = 0;
let customReadyQueue: Promise<void> = Promise.resolve();
let customReadyResult: Promise<void> = Promise.resolve();
const setCustomReady = (ready: boolean) => {
  const next = customReadyQueue.then(() => invokeTauri<void>("custom_plugin_window_ready", { ready }));
  customReadyQueue = next.catch(() => {});
  return next;
};

async function listenCustomOpen<T>(handler: (event: Event<T>) => void | Promise<void>): Promise<UnlistenFn> {
  const unlisten = await listenTauri("otools:custom-open", handler, {
    target: { kind: "Webview", label: getTauriInternals()?.metadata?.currentWebview?.label
      ?? getTauriInternals()?.metadata?.currentWindow?.label ?? "" },
  });
  customOpenListeners += 1;
  try {
    if (customOpenListeners === 1) customReadyResult = setCustomReady(true);
    await customReadyResult;
  } catch (error) {
    customOpenListeners -= 1;
    await unlisten();
    throw error;
  }
  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    customOpenListeners -= 1;
    try {
      if (customOpenListeners === 0) await setCustomReady(false);
    } finally {
      await unlisten();
    }
  };
}

export async function invoke<T = unknown>(
  command: string,
  payload?: InvokePayload,
): Promise<T> {
  let otools = getOtoolsApi();
  const pluginRuntimeHint = hasPluginRuntimeHint();
  if (!isOtoolsPluginRuntime() && pluginRuntimeHint) {
    otools = await waitForOtoolsApi();
  }

  if (otools) {
    const sharedHostResult = await invokeSharedHostFilesystemCommand(
      otools,
      command,
      payload,
    );
    if (sharedHostResult !== SHARED_HOST_COMMAND_NOT_HANDLED) {
      return sharedHostResult as T;
    }

    const hostStateResult = await invokeHostPluginStateCommand(
      otools,
      command,
      payload,
    );
    if (hostStateResult !== SHARED_HOST_COMMAND_NOT_HANDLED) {
      return hostStateResult as T;
    }
  }

  if (typeof otools?.invokeNative !== "function") {
    if (isTauriPluginCommand(command)) {
      return invokeTauri<T>(command, payload);
    }

    const pluginUuid = readPluginUuidFromContext(otools);
    if (
      pluginUuid &&
      !isHostPluginStateCommand(command) &&
      !isHostOwnedCommand(command) &&
      typeof otools?.invokeNativePlugin === "function"
    ) {
      return otools.invokeNativePlugin<T>(pluginUuid, command, payload ?? null);
    }
    try {
      return await invokeTauri<T>(command, payload);
    } catch (error) {
      if (
        isTauriPluginCommand(command) ||
        isHostOwnedCommand(command) ||
        !shouldFallbackToNativeInvoke(error)
      ) {
        throw error;
      }

      // A build-time plugin identity means this bundle always runs as an
      // otools plugin even when the host bridge has not been injected yet, so
      // a host ACL rejection ("not allowed by ACL") is the cue to wait for the
      // bridge instead of failing fast.
      const lateWaitMs = pluginRuntimeHint || readBuildTimePluginUuid() ? 1200 : 200;
      const lateOtools = await waitForOtoolsApi(lateWaitMs);
      const latePluginUuid = readPluginUuidFromContext(lateOtools);
      if (latePluginUuid && typeof lateOtools?.invokeNativePlugin === "function") {
        return lateOtools.invokeNativePlugin<T>(latePluginUuid, command, payload ?? null);
      }
      if (typeof lateOtools?.invokeNative !== "function") {
        throw error;
      }

      return lateOtools.invokeNative<T>(command, payload ?? null);
    }
  }

  if (command === "get_init_error") {
    return null as T;
  }

  if (DIRECT_TAURI_NOOP_COMMANDS.has(command)) {
    return true as T;
  }

  if (command === "plugin:event|listen") {
    const body = asPayloadRecord(payload);
    const event = typeof body?.event === "string" ? body.event : "";
    const handlerId = typeof body?.handler === "number" ? body.handler : NaN;
    if (!event || Number.isNaN(handlerId)) {
      throw new Error("plugin:event|listen requires event and handler");
    }

    return (await attachTransformListener(event, handlerId)) as T;
  }

  if (command === "plugin:event|unlisten") {
    const body = asPayloadRecord(payload);
    const eventId = typeof body?.eventId === "number" ? body.eventId : NaN;
    if (!Number.isNaN(eventId)) {
      await detachTransformListener(eventId);
    }
    return undefined as T;
  }

  if (isTauriPluginCommand(command)) {
    return invokeTauri<T>(command, payload);
  }

  if (isHostPluginStateCommand(command)) {
    return invokeTauri<T>(command, payload);
  }

  // Host-owned commands are never the plugin's own methods, so skip the native
  // bridge entirely instead of paying a doomed round-trip that cannot fall back.
  if (isHostOwnedCommand(command)) {
    return invokeTauri<T>(command, payload);
  }

  const pluginUuid = readPluginUuidFromContext(otools);
  const invokePluginNative =
    pluginUuid && typeof otools.invokeNativePlugin === "function"
      ? otools.invokeNativePlugin.bind(otools)
      : null;

  if (POPUP_COMMANDS.has(command)) {
    const result = invokePluginNative
      ? await invokeNativeWithHostFallback<{ path?: string }>(
          () => invokePluginNative(pluginUuid, command, payload ?? null),
          command,
          payload,
        )
      : await invokeNativeWithHostFallback(
          () => otools.invokeNative<{ path?: string }>(command, payload ?? null),
          command,
          payload,
        );
    const path = typeof result?.path === "string" ? result.path : null;
    if (path) {
      ensurePopupManager().open(path, command, payload);
      return undefined as T;
    }
    return result as T;
  }

  if (invokePluginNative) {
    const result = await invokeNativeWithHostFallback<T>(
      () => invokePluginNative(pluginUuid, command, payload ?? null),
      command,
      payload,
    );
    emitSyntheticEventsAfterInvoke(command, payload, result);
    return result;
  }

  try {
    const result = await invokeNativeWithHostFallback<T>(
      () => otools.invokeNative<T>(command, payload ?? null),
      command,
      payload,
    );
    emitSyntheticEventsAfterInvoke(command, payload, result);
    return result;
  } catch (error) {
    if (
      !pluginUuid ||
      typeof otools.invokeNativePlugin !== "function" ||
      !shouldFallbackToNativeInvoke(error)
    ) {
      throw error;
    }

    const invokeNativePluginFn = otools.invokeNativePlugin.bind(otools);
    const result = await invokeNativeWithHostFallback<T>(
      () => invokeNativePluginFn(pluginUuid, command, payload ?? null),
      command,
      payload,
    );
    emitSyntheticEventsAfterInvoke(command, payload, result);
    return result;
  }
}

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type UnlistenFn = () => Promise<void> | void;

export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void | Promise<void>,
  options: ListenOptions = {},
): Promise<UnlistenFn> {
  if (event === "otools:custom-open" && getTauriInternals()?.invoke && window.__OTOOLS_CUSTOM_WINDOW__) {
    return listenCustomOpen(handler);
  }
  if (getTauriInternals()?.invoke && (HOST_OWNED_EVENTS.has(event) || options.target)) {
    return listenTauri<T>(event, handler, options);
  }
  if (!getTauriInternals()?.invoke && HOST_OWNED_EVENTS.has(event)) {
    const listener = (raw: globalThis.Event) => {
      void handler({ event, id: -1, payload: (raw as CustomEvent<LocalEventDetail>).detail?.payload as T });
    };
    window.addEventListener(createLocalTauriEventName(event), listener);
    return () => window.removeEventListener(createLocalTauriEventName(event), listener);
  }
  let otools = getOtoolsApi();
  const pluginRuntimeHint = hasPluginRuntimeHint();
  if (!isOtoolsPluginRuntime() && pluginRuntimeHint) {
    otools = await waitForOtoolsApi();
  }

  if (typeof otools?.invokeNative !== "function") {
    return listenTauri<T>(event, handler);
  }

  const localEventListener = (raw: globalThis.Event) => {
    const detail = (raw as CustomEvent<LocalEventDetail>).detail;
    void handler({
      event,
      id: -1,
      payload: (detail?.payload ?? null) as T,
    });
  };

  window.addEventListener(createLocalTauriEventName(event), localEventListener);

  const nativeUnlisten = await listenNativeTopic<T>(event, async (eventPayload) => {
    await handler({
      event,
      id: -1,
      payload: eventPayload,
    });
  });

  return async () => {
    await nativeUnlisten();
    window.removeEventListener(
      createLocalTauriEventName(event),
      localEventListener,
    );
  };
}

export async function emit<T = unknown>(
  event: string,
  payload?: T,
): Promise<void> {
  if (HOST_OWNED_EVENTS.has(event)) {
    await invokeTauri('plugin:event|emit', { event, payload: payload ?? null });
    return;
  }
  emitLocalTauriEvent(event, payload ?? null);
}

function resolveShellApi(otools: OToolsAPI): OToolsShellAPI | undefined {
  return otools.shell ?? otools.runtime?.shell ?? undefined;
}

export function openExternal(url: string): boolean {
  const otools = getOtoolsApi();
  if (!otools) {
    return false;
  }

  const shell = resolveShellApi(otools);
  if (typeof shell?.openExternal === "function") {
    void shell.openExternal(url);
    return true;
  }

  otools.shellOpenExternal(url);
  return true;
}

export function openPath(fullPath: string): boolean {
  const otools = getOtoolsApi();
  if (!otools) {
    return false;
  }

  const shell = resolveShellApi(otools);
  if (typeof shell?.openPath === "function") {
    void shell.openPath(fullPath);
    return true;
  }

  otools.shellOpenPath(fullPath);
  return true;
}
