import assert from "node:assert/strict";
import { test } from "node:test";
import { mountHook, registerFrontendTestModules } from "./frontendTestModules.ts";
import type { QueuedEvent, ServerStatus, Settings, TransferRecord } from "../api";

registerFrontendTestModules();
const { usePollEvents } = await import("./usePollEvents.ts");
const { EVENTS } = await import("../api.ts");
const status = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  state: "running", port: 53317, udpPort: 53318, protocol: "https", fingerprint: "certificate",
  error: null, activeTransfers: 1, revision: 3, ...over,
});
const settings: Settings = {
  alias: "My PC", deviceModel: null, deviceType: "desktop", port: 53317, downloadDir: null,
  pin: null, autoSave: false, notifyOnIncoming: false,
};
const pending: TransferRecord = {
  sessionId: "pending", direction: "Receive", peerAlias: "Phone", status: "Pending", createdAt: 2,
  files: [{ id: "file", fileName: "pending.txt", size: 1, fileType: "text/plain", sha256: null, preview: null, metadata: null }],
};
const done: TransferRecord = { ...pending, sessionId: "done", status: "Done", createdAt: 1, destinations: { file: "D:\\saved.txt" } };
const peer = {
  ip: "192.168.1.2", lastSeenMs: 0,
  info: { alias: "Phone", version: "2.2", deviceModel: null, deviceType: "mobile", fingerprint: "peer", port: 53317, protocol: "https", download: false },
};

function bridge(over: Partial<{
  status: () => Promise<ServerStatus>;
  invoke: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
}> = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const callbacks = new Map<number, (event: { payload: unknown }) => void>();
  const listeners = new Map<string, number>();
  const intervals = new Map<number, () => void>();
  let sequence = 0;
  let queued: QueuedEvent[] = [];
  let currentStatus = status();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setInterval: (callback: () => void) => { const id = ++sequence; intervals.set(id, callback); return id; },
    clearInterval: (id: number) => { intervals.delete(id); },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    __TAURI_INTERNALS__: {
      transformCallback: (callback: (event: { payload: unknown }) => void) => { const id = ++sequence; callbacks.set(id, callback); return id; },
      invoke: async (method: string, payload: Record<string, unknown> = {}) => {
        calls.push({ method, payload });
        if (method === "plugin:event|listen") { listeners.set(String(payload.event), Number(payload.handler)); return sequence; }
        if (method === "plugin:event|unlisten") return {};
        if (over.invoke && ["start_localsend", "stop_localsend", "device_list"].includes(method)) return over.invoke(method, payload);
        switch (method) {
          case "server_status": return over.status ? over.status() : currentStatus;
          case "settings_get": return settings;
          case "device_list": return { devices: [peer], udpPort: 53318 };
          case "transfer_list": return { transfers: [pending, done] };
          case "poll_events": { const events = queued; queued = []; return { events }; }
          case "start_localsend": return { started: true, status: currentStatus };
          case "stop_localsend": return { confirmationRequired: true, activeTransfers: 5, status: currentStatus };
          default: throw new Error(`unexpected native method ${method}`);
        }
      },
    },
  } });
  const restore = () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
  return {
    restore,
    calls,
    setStatus: (next: ServerStatus) => { currentStatus = next; },
    event: (name: string, data: unknown) => { callbacks.get(listeners.get(name) ?? -1)?.({ payload: data }); },
    queue: (events: QueuedEvent[]) => { queued.push(...events); },
    drain: () => { [...intervals.values()][0]?.(); },
    resync: () => { [...intervals.values()][1]?.(); },
  };
}

test("mount rebuilds Pending receive state passively; stopped clears live state and ignores old listen/poll status", async (t) => {
  const native = bridge();
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  assert.equal(hook.current().ready, true);
  assert.equal(hook.current().incoming[0]?.sessionId, "pending");
  assert.equal(native.calls.some((call) => call.method === "start_localsend"), false);
  native.event(EVENTS.transferProgress, { sessionId: "pending", fileId: "file", percent: 55 });
  assert.equal(hook.current().progress.pending.file, 55);
  native.setStatus(status({ state: "stopped", port: 0, udpPort: 0, activeTransfers: 0, revision: 5 }));
  native.event(EVENTS.serverStatus, status({ state: "stopped", port: 0, udpPort: 0, activeTransfers: 0, revision: 5 }));
  const stopped = hook.current();
  assert.equal(stopped.server?.state, "stopped");
  assert.equal(stopped.udpPort, 0);
  assert.deepEqual(stopped.devices, []);
  assert.deepEqual(stopped.incoming, []);
  assert.deepEqual(stopped.progress, {});
  assert.equal(stopped.transfers.find((record) => record.sessionId === "done")?.destinations?.file, "D:\\saved.txt");
  native.queue([{ event: EVENTS.serverStatus, data: status({ revision: 4 }) }]);
  native.drain();
  await hook.flush();
  assert.equal(hook.current().server?.state, "stopped");
  native.event(EVENTS.deviceFound, peer);
  native.event(EVENTS.incomingRequest, { sessionId: "late", sender: peer.info, files: pending.files });
  native.event(EVENTS.transferProgress, { sessionId: "late", fileId: "file", percent: 75 });
  native.resync();
  await hook.flush();
  assert.deepEqual(hook.current().devices, []);
  assert.deepEqual(hook.current().incoming, []);
  assert.deepEqual(hook.current().progress, {});
  assert.equal(hook.current().udpPort, 0);
});

test("status retrieval failure remains unknown without blocking existing history or starting on mount", async (t) => {
  const native = bridge({ status: async () => { throw new Error("status unavailable"); } });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  assert.equal(hook.current().server, null);
  assert.equal(hook.current().hostError, null);
  assert.equal(hook.current().serviceError, "status unavailable");
  assert.equal(hook.current().transfers.length, 2);
  assert.equal(native.calls.some((call) => call.method === "start_localsend"), false);
});

test("the hook exposes one guarded action and native confirmation, cancellation performs no native call", async (t) => {
  const native = bridge();
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  const action = hook.current().stopService();
  await hook.current().stopService();
  await action;
  await hook.flush();
  assert.equal(hook.current().serviceBusy, false);
  assert.deepEqual(hook.current().stopConfirmation, { activeTransfers: 5 });
  assert.equal(native.calls.filter((call) => call.method === "stop_localsend").length, 1);
  const requests = native.calls.length;
  hook.current().cancelStopService();
  assert.equal(hook.current().stopConfirmation, null);
  assert.equal(native.calls.length, requests);
});

test("operation-result and query-only lifecycle changes refresh discovery and terminal history without a status event", async (t) => {
  let current = status({ state: "stopped", port: 0, udpPort: 0, activeTransfers: 0 });
  let devicesReads = 0;
  const native = bridge({
    status: async () => current,
    invoke: async (method) => {
      if (method === "device_list") {
        devicesReads++;
        return { devices: current.state === "running" ? [peer] : [], udpPort: current.udpPort };
      }
      if (method === "start_localsend") {
        current = status({ revision: 4, port: 54444, udpPort: 54444 });
        return { started: true, status: current };
      }
      if (method === "stop_localsend") {
        current = status({ state: "stopped", port: 0, udpPort: 0, activeTransfers: 0, revision: 5 });
        return { confirmationRequired: false, activeTransfers: 0, status: current };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  assert.deepEqual(hook.current().devices, []);
  const beforeDevices = devicesReads;
  await hook.current().startService();
  await hook.flush();
  assert.equal(hook.current().server?.state, "running");
  assert.equal(hook.current().udpPort, 54444);
  assert.ok(devicesReads > beforeDevices, "native operation snapshots must trigger device refresh");
  assert.equal(hook.current().devices[0]?.info.fingerprint, "peer");
  const beforeHistory = native.calls.filter((call) => call.method === "transfer_list").length;
  await hook.current().stopService();
  await hook.flush();
  assert.deepEqual(hook.current().devices, []);
  assert.ok(native.calls.filter((call) => call.method === "transfer_list").length > beforeHistory);
});
