import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mountHook, registerFrontendTestModules } from "./frontendTestModules.ts";
import type { PluginStore } from "./usePollEvents";
import type { ServerStatus } from "../api";

registerFrontendTestModules();
const { ServiceControls, StopServiceDialog } = await import("../components/ServiceControls.tsx");
const { SettingsPage } = await import("../pages/Settings.tsx");
const { IncomingDialog } = await import("../components/IncomingDialog.tsx");
const { App } = await import("../App.tsx");

const server = (state: ServerStatus["state"] = "running"): ServerStatus => ({
  state, port: state === "running" ? 53317 : 0, udpPort: state === "running" ? 53318 : 0,
  protocol: "https", fingerprint: "certificate", error: null, activeTransfers: 2, revision: 3,
});

function store(over: Partial<PluginStore> = {}): PluginStore {
  return {
    ready: true, hostError: null, server: server(), settings: null,
    udpPort: 53318, devices: [], incoming: [], transfers: [], progress: {},
    serviceBusy: false, serviceError: null, stopConfirmation: null, stopReturnFocus: null,
    startService: async () => {}, stopService: async () => {},
    confirmStopService: async () => {}, cancelStopService: () => {},
    refreshServer: async () => {}, refreshDevices: async () => {},
    refreshTransfers: async () => {}, refreshSettings: async () => {}, dismissIncoming: () => {},
    ...over,
  };
}

type ButtonProps = { type?: string; disabled?: boolean; onClick?: () => void; children?: ReactNode };
function buttons(node: ReactNode): ReactElement<ButtonProps>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [
    ...(node.type === "button" ? [node as ReactElement<ButtonProps>] : []),
    ...buttons(node.props.children),
  ];
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...elements(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return text(node.props.children);
}

test("sidebar and Settings controls call the same shared start/stop handlers without saving a draft", async () => {
  const actions: string[] = [];
  const shared = store({
    startService: async () => { actions.push("start"); },
    stopService: async () => { actions.push("stop"); },
  });
  for (const compact of [true, false]) {
    const control = ServiceControls({ store: shared, compact });
    const button = buttons(control).find((item) => text(item.props.children) === "停止服务");
    assert.ok(button);
    assert.equal(button.props.disabled, false);
    assert.equal(button.props.type, "button");
    button.props.onClick?.();
  }
  shared.server = server("stopped");
  buttons(ServiceControls({ store: shared }))[0].props.onClick?.();
  assert.deepEqual(actions, ["stop", "stop", "start"]);
});

test("actual ServiceControls render stopped, failed and transition labels with correct disabled buttons", () => {
  for (const [state, label, disabled] of [
    ["stopped", "启动服务", false], ["failed", "启动服务", false],
    ["running", "停止服务", false], ["starting", "启动中…", true], ["stopping", "停止中…", true],
  ] as const) {
    const control = ServiceControls({ store: store({ server: server(state) }) });
    const button = buttons(control)[0];
    assert.equal(text(button.props.children), label, state);
    assert.equal(button.props.disabled, disabled, state);
  }
  for (const shared of [
    store({ ready: false }), store({ server: null }), store({ hostError: "missing" }),
    store({ serviceBusy: true }), store({ stopConfirmation: { activeTransfers: 2 } }),
  ]) assert.equal(buttons(ServiceControls({ store: shared }))[0].props.disabled, true);
});

test("shared service errors are visible in both compact and Settings controls", () => {
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(createElement(ServiceControls, {
      store: store({ serviceError: "operation refused" }), compact,
    }));
    assert.match(html, /role="alert"/);
    assert.match(html, /operation refused/);
  }
});

test("single stop confirmation shows native count, preserves-data copy and calls parent callbacks", () => {
  const actions: string[] = [];
  const mounted = mountHook(() => StopServiceDialog({
    activeTransfers: 7, busy: false, error: null, preview: true,
    onCancel: () => { actions.push("cancel"); },
    onConfirm: () => { actions.push("force"); },
  }));
  const dialog = mounted.current();
  const html = renderToStaticMarkup(dialog);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(text(dialog), /7 个未完成传输/);
  assert.match(text(dialog), /已完成文件.*传输历史/);
  assert.match(text(dialog), /预览模拟/);
  buttons(dialog).find((item) => text(item.props.children) === "取消")?.props.onClick?.();
  buttons(dialog).find((item) => text(item.props.children) === "确认停止")?.props.onClick?.();
  assert.deepEqual(actions, ["cancel", "force"]);
  const busyMounted = mountHook(() => StopServiceDialog({ activeTransfers: 7, busy: true, error: "retry", onCancel: () => {}, onConfirm: () => {} }));
  const busy = busyMounted.current();
  assert.equal(buttons(busy).every((item) => item.props.disabled === true), true);
  assert.match(renderToStaticMarkup(busy), /role="alert"/);
  busyMounted.unmount();
  mounted.unmount();
});

test("Settings still exposes service controls when settings are unavailable or the host is missing", () => {
  for (const shared of [store({ server: null }), store({ hostError: "Tauri runtime is unavailable" })]) {
    const html = renderToStaticMarkup(createElement(SettingsPage, { store: shared }));
    assert.match(html, /服务状态/);
    assert.match(html, /<button[^>]+disabled/);
  }
});

test("pending incoming dialog keeps a reachable parent stop action rather than trapping service controls behind it", () => {
  const html = renderToStaticMarkup(createElement(IncomingDialog, {
    request: { sessionId: "pending", sender: {
      alias: "Phone", version: "2.2", deviceModel: null, deviceType: "mobile", fingerprint: "peer",
      port: 53317, protocol: "https", download: false,
    }, files: [] },
    busy: false, error: null, onAcceptAll: () => {}, onAcceptSelected: () => {}, onDecline: () => {},
    onStopService: () => {}, serviceBusy: false,
  }));
  assert.match(html, /停止服务/);
});

test("App coordinates one native-count confirmation over Pending incoming and restores it on cancel", async (t) => {
  const settings = {
    alias: "Saved PC", deviceModel: null, deviceType: "desktop", port: 53317, downloadDir: null,
    pin: null, autoSave: false, notifyOnIncoming: false,
  };
  const requestRecord = {
    sessionId: "pending", direction: "Receive", peerAlias: "Phone", status: "Pending", createdAt: 1,
    files: [{ id: "file", fileName: "pending.txt", size: 1, fileType: "text/plain", sha256: null, preview: null, metadata: null }],
  };
  const calls: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const initiatingButton = { focus: () => {}, isConnected: true };
  const testDocument = { activeElement: initiatingButton as unknown };
  Object.defineProperty(globalThis, "document", { configurable: true, value: testDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setInterval: () => 1, clearInterval: () => {},
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (method: string) => {
        calls.push(method);
        switch (method) {
          case "settings_get": return settings;
          case "server_status": return server();
          case "device_list": return { devices: [], udpPort: 53318 };
          case "transfer_list": return { transfers: [requestRecord] };
          case "poll_events": return { events: [] };
          case "stop_localsend": return { confirmationRequired: true, activeTransfers: 7, status: server() };
          default: throw new Error("listen unavailable in test");
        }
      },
    },
  } });
  const app = mountHook(App);
  t.after(async () => {
    app.unmount(); await app.flush();
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  await app.flush();
  const children = elements(app.current());
  const sidebar = children.find((element) => element.type === ServiceControls);
  const incoming = children.find((element) => element.type === IncomingDialog);
  assert.ok(sidebar, "sidebar must use the reusable control");
  assert.ok(incoming);
  assert.equal(typeof incoming.props.onStopService, "function");
  (incoming.props.onStopService as () => void)();
  testDocument.activeElement = { focus: () => {} }; // Busy button blur before async native confirmation.
  await app.flush();
  const withConfirmation = elements(app.current());
  const dialogs = withConfirmation.filter((element) => element.type === StopServiceDialog);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].props.activeTransfers, 7);
  assert.equal(dialogs[0].props.returnFocus, initiatingButton, "async confirmation must retain the actual initiating button before busy blur");
  assert.equal(withConfirmation.find((element) => element.type === IncomingDialog)?.props.hidden, true);
  const count = calls.length;
  (dialogs[0].props.onCancel as () => void)();
  const cancelled = elements(app.current());
  assert.equal(cancelled.filter((element) => element.type === StopServiceDialog).length, 0);
  assert.equal(cancelled.find((element) => element.type === IncomingDialog)?.props.hidden, false);
  assert.equal(calls.length, count, "cancelling confirmation must not call native");
});

test("review 3: unknown-status Pending is suspended without blocking navigation or losing its request on recovery", async (t) => {
  let available = false;
  const requestRecord = {
    sessionId: "pending", direction: "Receive", peerAlias: "Phone", status: "Pending", createdAt: 1,
    files: [{ id: "file", fileName: "pending.txt", size: 1, fileType: "text/plain", sha256: null, preview: null, metadata: null }],
  };
  const calls: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setInterval: () => 1, clearInterval: () => {},
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (method: string) => {
        calls.push(method);
        switch (method) {
          case "settings_get": return { alias: "Saved PC", deviceModel: null, deviceType: "desktop", port: 53317, downloadDir: null, pin: null, autoSave: false, notifyOnIncoming: false };
          case "server_status": if (!available) throw new Error("status unavailable"); return server();
          case "device_list": return { devices: [], udpPort: 0 };
          case "transfer_list": return { transfers: [requestRecord] };
          case "poll_events": return { events: [] };
          default: throw new Error("listen unavailable in test");
        }
      },
    },
  } });
  const app = mountHook(App);
  t.after(async () => {
    app.unmount(); await app.flush();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  await app.flush();
  const unknown = elements(app.current()).find((element) => element.type === IncomingDialog);
  assert.ok(unknown);
  assert.equal(unknown.props.hidden, true, "unknown status must not trap navigation with a disabled modal");
  (unknown.props.onAcceptAll as () => void)();
  (unknown.props.onStopService as () => void)();
  assert.equal(calls.some((method) => method === "session_accept" || method === "stop_localsend"), false);
  const settingsButton = buttons(app.current()).find((button) => text(button.props.children).includes("设置"));
  settingsButton?.props.onClick?.();
  assert.ok(elements(app.current()).some((element) => element.type === SettingsPage));
  available = true;
  const shared = elements(app.current()).find((element) => element.type === ServiceControls)?.props.store as PluginStore;
  await shared.refreshServer();
  await app.flush();
  const recovered = elements(app.current()).find((element) => element.type === IncomingDialog);
  assert.ok(recovered);
  assert.equal(recovered.key, unknown.key);
  assert.equal(recovered.props.hidden, false);
  assert.equal((recovered.props.request as { sessionId: string }).sessionId, "pending");
});

test("review 3: suspending the mounted IncomingDialog retains selected file ids without taking focus", () => {
  let hidden = false;
  const selected: string[][] = [];
  const request = {
    sessionId: "pending", sender: { alias: "Phone", version: "2.2", deviceModel: null, deviceType: "mobile", fingerprint: "peer", port: 53317, protocol: "https", download: false },
    files: ["first", "second"].map((id) => ({ id, fileName: `${id}.txt`, size: 1, fileType: "text/plain", sha256: null, preview: null, metadata: null })),
  };
  const dialog = mountHook(() => IncomingDialog({
    request, hidden, busy: false, error: null, onAcceptAll: () => {},
    onAcceptSelected: (ids) => selected.push(ids), onDecline: () => {},
  }));
  const firstCheckbox = elements(dialog.current()).find((element) => element.type === "input");
  (firstCheckbox?.props.onChange as () => void)();
  hidden = true;
  dialog.current();
  hidden = false;
  buttons(dialog.current()).find((button) => text(button.props.children).includes("接受所选"))?.props.onClick?.();
  assert.deepEqual(selected, [["second"]]);
  dialog.unmount();
});
