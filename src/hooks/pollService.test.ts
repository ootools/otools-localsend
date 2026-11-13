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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function bridge(over: Partial<{
  status: () => Promise<ServerStatus>;
  transfers: () => Promise<TransferRecord[]>;
  poll: () => Promise<QueuedEvent[]>;
  devices: () => Promise<{ devices: typeof peer[]; udpPort: number }>;
  settings: () => Promise<Settings>;
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
          case "settings_get": return over.settings ? over.settings() : settings;
          case "device_list": return over.devices ? over.devices() : { devices: [peer], udpPort: 53318 };
          case "transfer_list": return { transfers: over.transfers ? await over.transfers() : [pending, done] };
          case "poll_events": {
            if (over.poll) return { events: await over.poll() };
            const events = queued; queued = []; return { events };
          }
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

test("review 1: a held pre-stop poll batch cannot resurrect old devices, Pending or progress after restart", async (t) => {
  const oldBatch = deferred<QueuedEvent[]>();
  let firstPoll = true;
  let current = status({ activeTransfers: 0 });
  let records: TransferRecord[] = [];
  const stalePeer = { ...peer, info: { ...peer.info, fingerprint: "old-device" } };
  const native = bridge({
    status: async () => current,
    transfers: async () => records,
    poll: () => { if (firstPoll) { firstPoll = false; return oldBatch.promise; } return Promise.resolve([]); },
    invoke: async (method, payload) => {
      if (method === "device_list") return { devices: [], udpPort: current.udpPort };
      if (method === "stop_localsend") {
        if (!payload.force) return { confirmationRequired: true, activeTransfers: 1, status: current };
        current = status({ state: "stopping", revision: 4 });
        return { confirmationRequired: false, activeTransfers: 1, status: current };
      }
      if (method === "start_localsend") {
        current = status({ state: "starting", port: 0, udpPort: 0, revision: 6 });
        return { started: true, status: current };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  records = [{ ...pending, sessionId: "old-pending" }];
  await hook.current().stopService();
  await hook.current().confirmStopService();
  records = [{ ...pending, sessionId: "old-pending", status: "Cancelled" }];
  native.event(EVENTS.transferDone, { sessionId: "old-pending", status: "cancelled" });
  current = status({ state: "stopped", port: 0, udpPort: 0, activeTransfers: 0, revision: 5 });
  native.event(EVENTS.serverStatus, current);
  await hook.flush();
  await hook.current().startService();
  current = status({ revision: 7, activeTransfers: 0 });
  native.event(EVENTS.serverStatus, current);
  await hook.flush();
  oldBatch.resolve([
    { event: EVENTS.incomingRequest, data: { sessionId: "old-pending", sender: peer.info, files: pending.files } },
    { event: EVENTS.deviceFound, data: stalePeer },
    { event: EVENTS.transferProgress, data: { sessionId: "old-pending", fileId: "file", percent: 70 } },
    { event: EVENTS.serverStatus, data: status() },
  ]);
  await hook.flush();
  assert.equal(hook.current().server?.revision, 7);
  assert.equal(hook.current().transfers[0]?.status, "Cancelled");
  assert.deepEqual(hook.current().devices, []);
  assert.deepEqual(hook.current().incoming, []);
  assert.deepEqual(hook.current().progress, {});
});

test("review 1: terminal history and done/cancelled/failed events tombstone late Pending and progress in the current epoch", async (t) => {
  let records: TransferRecord[] = [done];
  const native = bridge({ transfers: async () => records });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  for (const [sessionId, terminal] of [["done", "done"], ["cancelled", "cancelled"], ["failed", "failed"]] as const) {
    if (sessionId !== "done") {
      records = [...records, { ...pending, sessionId, status: terminal === "cancelled" ? "Cancelled" : "Failed" }];
      native.event(EVENTS.transferDone, { sessionId, status: terminal });
    }
    native.event(EVENTS.incomingRequest, { sessionId, sender: peer.info, files: pending.files });
    native.event(EVENTS.transferProgress, { sessionId, fileId: "file", percent: 75 });
  }
  await hook.flush();
  assert.deepEqual(hook.current().incoming, []);
  assert.deepEqual(hook.current().progress, {});
  native.event(EVENTS.incomingRequest, { sessionId: "fresh-uuid", sender: peer.info, files: pending.files });
  assert.equal(hook.current().incoming[0]?.sessionId, "fresh-uuid");
});

test("review 2: query-only running recovery reconstructs missed Pending exactly once and handled requests stay dismissed", async (t) => {
  let current = status({ state: "starting", port: 0, udpPort: 0 });
  let records: TransferRecord[] = [];
  const native = bridge({ status: async () => current, transfers: async () => records });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  current = status({ revision: 4 });
  records = [pending];
  native.event(EVENTS.incomingRequest, { sessionId: "pending", sender: peer.info, files: pending.files });
  native.drain();
  await hook.flush();
  assert.equal(hook.current().server?.state, "running");
  assert.deepEqual(hook.current().incoming.map((request) => request.sessionId), ["pending"]);
  await hook.current().refreshTransfers();
  assert.equal(hook.current().incoming.length, 1);
  hook.current().dismissIncoming("pending");
  await hook.current().refreshTransfers();
  native.event(EVENTS.incomingRequest, { sessionId: "pending", sender: peer.info, files: pending.files });
  assert.deepEqual(hook.current().incoming, []);
  records = [...records, { ...pending, sessionId: "fresh-uuid", createdAt: 3 }];
  await hook.current().refreshTransfers();
  assert.deepEqual(hook.current().incoming.map((request) => request.sessionId), ["fresh-uuid"]);
});

test("review 4: delayed earlier history cannot replace a later stopped Done record or remove its destination", async (t) => {
  const oldHistory = deferred<TransferRecord[]>();
  let holdNext = false;
  let records: TransferRecord[] = [{ ...pending, status: "Transferring" }];
  const native = bridge({ transfers: () => {
    if (holdNext) { holdNext = false; return oldHistory.promise; }
    return Promise.resolve(records);
  } });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  holdNext = true;
  const earlier = hook.current().refreshTransfers();
  records = [{ ...pending, status: "Done", destinations: { file: "D:\\completed.txt" } }];
  native.event(EVENTS.transferDone, { sessionId: "pending", status: "done" });
  const stopped = status({ state: "stopped", port: 0, udpPort: 0, activeTransfers: 0, revision: 5 });
  native.setStatus(stopped);
  native.event(EVENTS.serverStatus, stopped);
  await hook.flush();
  assert.equal(hook.current().transfers[0]?.status, "Done");
  assert.equal(hook.current().transfers[0]?.destinations?.file, "D:\\completed.txt");
  oldHistory.resolve([{ ...pending, status: "Transferring" }]);
  await earlier;
  assert.equal(hook.current().transfers[0]?.status, "Done");
  assert.equal(hook.current().transfers[0]?.destinations?.file, "D:\\completed.txt");
});

test("review 4: a later history snapshot cannot regress known terminal records, but distinct new UUIDs remain valid", async (t) => {
  let records: TransferRecord[] = [done];
  const native = bridge({ transfers: async () => records });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  records = [{ ...done, status: "Transferring", destinations: undefined }, { ...pending, sessionId: "fresh-uuid" }];
  await hook.current().refreshTransfers();
  assert.equal(hook.current().transfers.find((record) => record.sessionId === "done")?.status, "Done");
  assert.equal(hook.current().transfers.find((record) => record.sessionId === "done")?.destinations?.file, "D:\\saved.txt");
  assert.equal(hook.current().transfers.find((record) => record.sessionId === "fresh-uuid")?.status, "Pending");
});

test("review 4: failed lifecycle cleanup refreshes authoritative cancelled history", async (t) => {
  let records: TransferRecord[] = [{ ...pending, status: "Transferring" }];
  const native = bridge({ transfers: async () => records });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  records = [{ ...pending, status: "Cancelled" }];
  const failed = status({ state: "failed", port: 0, udpPort: 0, error: "cleanup failed", activeTransfers: 0, revision: 4 });
  native.setStatus(failed);
  native.event(EVENTS.serverStatus, failed);
  await hook.flush();
  assert.equal(hook.current().transfers[0]?.status, "Cancelled");
});

for (const initial of ["starting", "stopping", "unknown"] as const) {
  test(`review 5: ${initial} status recovers independently when poll_events rejects`, async (t) => {
    let current: ServerStatus | null = initial === "unknown" ? null : status({ state: initial });
    const native = bridge({
      status: async () => { if (!current) throw new Error("status temporarily unavailable"); return current; },
      poll: async () => { throw new Error("event channel unavailable"); },
    });
    const hook = mountHook(usePollEvents);
    t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
    await hook.flush();
    const queries = native.calls.filter((call) => call.method === "server_status").length;
    current = status({ revision: 4 });
    native.drain();
    await hook.flush();
    assert.ok(native.calls.filter((call) => call.method === "server_status").length > queries);
    assert.equal(hook.current().server?.state, "running");
    assert.equal(hook.current().serviceError, null);
  });
}

test("review 5: independent state-query failure stays visible even if the event channel also fails", async (t) => {
  let failStatus = false;
  const native = bridge({
    status: async () => { if (failStatus) throw new Error("authoritative status failed"); return status({ state: "starting" }); },
    poll: async () => { throw new Error("event channel unavailable"); },
  });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  failStatus = true;
  native.drain();
  await hook.flush();
  assert.equal(hook.current().serviceError, "authoritative status failed");
});

test("review 6: a real native status success clears initial host-missing availability and passively resyncs", async (t) => {
  let available = false;
  let current = status({ state: "stopped", port: 0, udpPort: 0, activeTransfers: 0 });
  const native = bridge({
    status: async () => { if (!available) throw new Error("bridge not ready"); return current; },
    transfers: async () => { if (!available) throw new Error("bridge not ready"); return [done]; },
    devices: async () => { if (!available) throw new Error("bridge not ready"); return { devices: [], udpPort: 0 }; },
  });
  const hook = mountHook(usePollEvents);
  t.after(async () => { hook.unmount(); await hook.flush(); native.restore(); });
  await hook.flush();
  assert.ok(hook.current().hostError);
  available = true;
  native.drain();
  await hook.flush();
  assert.equal(hook.current().server?.state, "stopped");
  assert.equal(hook.current().hostError, null);
  assert.equal(hook.current().transfers[0]?.status, "Done");
  assert.equal(native.calls.some((call) => call.method === "start_localsend"), false);
  await hook.current().startService();
  assert.equal(native.calls.filter((call) => call.method === "start_localsend").length, 1);
});
