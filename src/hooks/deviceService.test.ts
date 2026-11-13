import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { mountHook, registerFrontendTestModules } from "./frontendTestModules.ts";
import type { PluginStore } from "./usePollEvents";
import type { DeviceEntry, ServerStatus } from "../api";

// The DOM-rendered SDK picker is external to this component. Keep its full result boundary.
registerFrontendTestModules({
  "otools-plugin-sdk/host-file-tree": "export async function pickFromHostTree(options) { return globalThis.__testHostPick(options); }",
});
const { DevicesPage } = await import("../pages/Devices.tsx");
const { DeviceCard } = await import("../components/DeviceCard.tsx");

const peer: DeviceEntry = {
  ip: "192.168.1.2", lastSeenMs: 0,
  info: { alias: "Phone", version: "2.2", deviceModel: null, deviceType: "mobile", fingerprint: "peer", port: 54445, protocol: "https", download: false },
};
const running: ServerStatus = {
  state: "running", port: 53317, udpPort: 53318, protocol: "https", fingerprint: "certificate", error: null, activeTransfers: 0, revision: 3,
};
function store(): PluginStore {
  return {
    ready: true, hostError: null, server: running, settings: null, udpPort: 53318,
    devices: [peer], transfers: [], incoming: [], progress: {}, serviceBusy: false, serviceError: null, stopConfirmation: null, stopReturnFocus: null,
    startService: async () => {}, stopService: async () => {}, confirmStopService: async () => {}, cancelStopService: () => {},
    refreshServer: async () => {}, refreshDevices: async () => {}, refreshTransfers: async () => {}, refreshSettings: async () => {}, dismissIncoming: () => {},
  };
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
function select(page: ReturnType<typeof mountHook<ReactNode>>) {
  const device = elements(page.current()).find((element) => element.type === DeviceCard);
  (device?.props.onSelect as () => void)();
  page.current();
}
function sendButtons(node: ReactNode) {
  return elements(node).filter((element) => element.type === "button" && text(element.props.children as ReactNode).includes("发送"));
}

test("review guarded sends: shared busy and non-running states disable both send actions", () => {
  const shared = store();
  const page = mountHook(() => DevicesPage({ store: shared, onGoToTransfers: () => {} }));
  select(page);
  assert.equal(sendButtons(page.current()).length, 2);
  for (const state of ["stopping", "starting", "stopped", "failed"] as const) {
    shared.server = { ...running, state };
    page.rerender();
    assert.equal(sendButtons(page.current()).every((element) => element.props.disabled === true), true, state);
  }
  shared.server = running;
  shared.serviceBusy = true;
  page.rerender();
  assert.equal(sendButtons(page.current()).every((element) => element.props.disabled === true), true);
  page.unmount();
});

test("review guarded sends: a host-picker result cannot send after the current lifecycle has changed", async (t) => {
  const sent: unknown[] = [];
  let authoritative = running;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldPicker = Object.getOwnPropertyDescriptor(globalThis, "__testHostPick");
  Object.defineProperty(globalThis, "__testHostPick", { configurable: true, value: async () => {
    authoritative = { ...running, state: "stopping", revision: 4 };
    return { kind: "picked", source: "host-tree", paths: ["D:\\Host\\picked.txt"], names: ["picked.txt"] };
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (method: string, payload: unknown) => {
      if (method === "server_status") return authoritative;
      if (method === "send_files") { sent.push(payload); return { sessionId: "should-not-send" }; }
      throw new Error(`unexpected ${method}`);
    } },
  } });
  t.after(() => {
    if (oldPicker) Object.defineProperty(globalThis, "__testHostPick", oldPicker);
    else Reflect.deleteProperty(globalThis, "__testHostPick");
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const shared = store();
  let navigations = 0;
  const page = mountHook(() => DevicesPage({ store: shared, onGoToTransfers: () => { navigations++; } }));
  t.after(() => page.unmount());
  select(page);
  const button = sendButtons(page.current()).find((element) => text(element.props.children as ReactNode).includes("发送文件"));
  (button?.props.onClick as () => void)();
  await page.flush();
  assert.deepEqual(sent, []);
  assert.equal(navigations, 0);
});

test("review guarded sends: unchanged running selection still sends exact host tree paths to the peer port", async (t) => {
  const sent: unknown[] = [];
  const paths = ["D:\\Host\\a.txt", "D:\\Host\\b.txt"];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldPicker = Object.getOwnPropertyDescriptor(globalThis, "__testHostPick");
  Object.defineProperty(globalThis, "__testHostPick", { configurable: true, value: async () => ({ kind: "picked", source: "host-tree", paths, names: ["a.txt", "b.txt"] }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (method: string, payload: unknown) => {
      if (method === "server_status") return running;
      if (method === "send_files") { sent.push(payload); return { sessionId: "sent" }; }
      throw new Error(`unexpected ${method}`);
    } },
  } });
  t.after(() => {
    if (oldPicker) Object.defineProperty(globalThis, "__testHostPick", oldPicker);
    else Reflect.deleteProperty(globalThis, "__testHostPick");
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const page = mountHook(() => DevicesPage({ store: store(), onGoToTransfers: () => {} }));
  t.after(() => page.unmount());
  select(page);
  const button = sendButtons(page.current()).find((element) => text(element.props.children as ReactNode).includes("发送文件"));
  (button?.props.onClick as () => void)();
  await page.flush();
  assert.deepEqual(sent, [{ ip: "192.168.1.2", port: 54445, files: [{ path: paths[0] }, { path: paths[1] }] }]);
});
