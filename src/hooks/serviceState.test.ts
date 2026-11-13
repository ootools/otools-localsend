import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createServiceController,
  liveServiceStateForStatus,
  normalizeServerStatus,
  serviceAllowsLiveTraffic,
  serviceControlView,
  type ServiceControllerOptions,
} from "./serviceState.ts";
import type { ServerStatus, StartServiceResult, StopServiceResult, TransferRecord } from "../api";

const snapshot = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  state: "stopped",
  port: 0,
  udpPort: 0,
  protocol: "https",
  fingerprint: "saved-certificate",
  error: null,
  activeTransfers: 0,
  revision: 3,
  ...over,
});

const controls = (server: ServerStatus | null) => ({
  server,
  ready: true,
  hostError: null,
  serviceBusy: false,
  serviceError: null,
  stopConfirmation: null,
});

test("a normal port-zero stopped snapshot remains stopped with its certificate", () => {
  assert.deepEqual(normalizeServerStatus(snapshot()), {
    state: "stopped", port: 0, udpPort: 0, protocol: "https",
    fingerprint: "saved-certificate", error: null, activeTransfers: 0, revision: 3,
  });
});

test("starting is explicit rather than inferred from an unbound port", () => {
  const status = normalizeServerStatus(snapshot({ state: "starting", revision: 4 }));
  assert.equal(status?.state, "starting");
  assert.equal(status?.port, 0);
  assert.equal(status?.udpPort, 0);
});

test("running snapshots retain both actual ports and the native active count", () => {
  assert.deepEqual(normalizeServerStatus(snapshot({
    state: "running", port: 54444, udpPort: 53317, activeTransfers: 7, revision: 5,
  })), {
    state: "running", port: 54444, udpPort: 53317, protocol: "https",
    fingerprint: "saved-certificate", error: null, activeTransfers: 7, revision: 5,
  });
});

test("failed snapshots retain the native error and can offer a retry", () => {
  const server = normalizeServerStatus(snapshot({ state: "failed", error: "port in use" }));
  assert.equal(server?.error, "port in use");
  const view = serviceControlView(controls(server));
  assert.equal(view.action, "start");
  assert.equal(view.disabled, false);
});

test("partial, upper-case, and invalid snapshots stay unknown instead of faking starting", () => {
  const invalid: unknown[] = [
    null,
    { port: 53317, protocol: "https", fingerprint: "old", error: null },
    { error: "old partial failure" },
    { ...snapshot(), state: "Stopped" },
    { ...snapshot(), revision: -1 },
    { ...snapshot(), revision: Number.NaN },
    { ...snapshot(), activeTransfers: -1 },
    { ...snapshot(), activeTransfers: 0.5 },
    { ...snapshot(), udpPort: undefined },
    { ...snapshot(), port: 65536 },
    { ...snapshot(), protocol: "http" },
    { ...snapshot(), fingerprint: undefined },
    { ...snapshot(), error: undefined },
  ];
  for (const payload of invalid) assert.equal(normalizeServerStatus(payload), null);
});

test("each explicit lifecycle exposes only its allowed service action", () => {
  const cases = [
    { state: "stopped", action: "start", label: "启动服务", disabled: false },
    { state: "failed", action: "start", label: "启动服务", disabled: false },
    { state: "running", action: "stop", label: "停止服务", disabled: false },
    { state: "starting", action: null, label: "启动中…", disabled: true },
    { state: "stopping", action: null, label: "停止中…", disabled: true },
  ] as const;
  for (const { state, action, label, disabled } of cases) {
    const view = serviceControlView(controls(snapshot({ state })));
    assert.equal(view.action, action, state);
    assert.equal(view.label, label, state);
    assert.equal(view.disabled, disabled, state);
  }
});

test("loading, unknown, missing-host, busy and pending-confirmation controls are disabled", () => {
  const running = controls(snapshot({ state: "running", port: 53317, udpPort: 53317 }));
  for (const input of [
    { ...running, ready: false },
    controls(null),
    { ...running, hostError: "Tauri runtime is unavailable" },
    { ...running, serviceBusy: true },
    { ...running, stopConfirmation: { activeTransfers: 4 } },
  ]) assert.equal(serviceControlView(input).disabled, true);
  assert.equal(serviceControlView(controls(null)).statusLabel, "服务状态未知");
  assert.equal(serviceControlView(controls(snapshot())).statusLabel, "服务已停止");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function controller(over: Partial<ServiceControllerOptions> = {}) {
  return createServiceController({
    startService: async () => ({ started: true, status: snapshot({ state: "starting", revision: 4 }) }),
    stopService: async () => ({
      confirmationRequired: false, activeTransfers: 0,
      status: snapshot({ state: "stopping", revision: 4 }),
    }),
    serverStatus: async () => snapshot({ revision: 5 }),
    onChange: () => {},
    onStatus: () => {},
    ...over,
  });
}

const makeReady = (service: ReturnType<typeof createServiceController>, server: ServerStatus) => {
  service.setAvailability(true, null);
  service.applyStatus(server);
};

test("a lower-revision running event cannot resurrect a stopped service", () => {
  const accepted: string[] = [];
  const service = controller({ onStatus: (server) => accepted.push(server.state) });
  makeReady(service, snapshot({ state: "running", port: 53317, udpPort: 53317, revision: 8 }));
  assert.equal(service.applyStatus(snapshot({ state: "stopped", revision: 10 })), true);
  assert.equal(service.applyStatus(snapshot({ state: "running", port: 53317, udpPort: 53317, revision: 9 })), false);
  assert.equal(service.getState().server?.state, "stopped");
  assert.equal(service.getState().server?.revision, 10);
  assert.deepEqual(accepted, ["running", "stopped"]);
});

test("equal revisions may refresh counts without replaying stale lifecycle changes", () => {
  const service = controller();
  makeReady(service, snapshot({ state: "running", port: 53317, udpPort: 53317, revision: 8 }));
  service.applyStatus(snapshot({ state: "running", port: 53317, udpPort: 53317, activeTransfers: 2, revision: 8 }));
  assert.equal(service.getState().server?.activeTransfers, 2);
  assert.equal(service.applyStatus({ port: 53317 }), false);
  assert.equal(service.getState().server?.activeTransfers, 2);
});

test("start applies its operation result and explicitly re-queries authoritative status", async () => {
  const order: string[] = [];
  const service = controller({
    startService: async () => {
      order.push("start");
      return { started: true, status: snapshot({ state: "starting", revision: 4 }) };
    },
    serverStatus: async () => {
      order.push("query");
      return snapshot({ state: "running", port: 54444, udpPort: 54444, revision: 5 });
    },
    onStatus: (server) => order.push(server.state),
  });
  makeReady(service, snapshot());
  order.length = 0;
  await service.start();
  assert.deepEqual(order, ["start", "starting", "query", "running"]);
  assert.equal(service.getState().server?.port, 54444);
  assert.equal(service.getState().serviceBusy, false);
});

test("two entrypoints share a synchronous busy guard through the final re-query", async () => {
  const pendingStart = deferred<StartServiceResult>();
  const pendingQuery = deferred<ServerStatus>();
  let attempts = 0;
  const service = controller({
    startService: () => { attempts++; return pendingStart.promise; },
    serverStatus: () => pendingQuery.promise,
  });
  makeReady(service, snapshot());
  const first = service.start();
  const second = service.start();
  assert.equal(service.getState().serviceBusy, true);
  assert.equal(attempts, 1);
  await second;
  pendingStart.resolve({ started: true, status: snapshot({ state: "starting", revision: 4 }) });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(service.getState().serviceBusy, true);
  await service.start();
  assert.equal(attempts, 1);
  pendingQuery.resolve(snapshot({ state: "running", port: 53317, udpPort: 53317, revision: 5 }));
  await first;
  assert.equal(service.getState().serviceBusy, false);
});

test("a throwing start releases busy, shows the error and permits a retry", async () => {
  let attempts = 0;
  const service = controller({
    startService: async () => {
      attempts++;
      if (attempts === 1) throw new Error("permission denied");
      return { started: true, status: snapshot({ state: "starting", revision: 4 }) };
    },
  });
  makeReady(service, snapshot());
  await service.start();
  assert.equal(service.getState().serviceBusy, false);
  assert.equal(service.getState().serviceError, "permission denied");
  assert.equal(service.getState().server?.state, "stopped");
  await service.start();
  assert.equal(attempts, 2);
  assert.equal(service.getState().serviceError, null);
});

test("a throwing stop also releases busy and leaves a retryable running snapshot", async () => {
  let attempts = 0;
  const service = controller({
    stopService: async () => { attempts++; throw "stop refused"; },
    serverStatus: async () => snapshot({ state: "running", port: 53317, udpPort: 53317 }),
  });
  makeReady(service, snapshot({ state: "running", port: 53317, udpPort: 53317 }));
  await service.stop();
  assert.equal(service.getState().serviceError, "stop refused");
  assert.equal(service.getState().serviceBusy, false);
  await service.stop();
  assert.equal(attempts, 2);
});

test("status retrieval failure is unknown, visible and does not pretend to start", async () => {
  let starts = 0;
  const service = controller({
    startService: async () => { starts++; return { started: true, status: snapshot() }; },
    serverStatus: async () => { throw new Error("status unavailable"); },
  });
  service.setAvailability(true, null);
  await service.refreshStatus();
  await service.start();
  assert.equal(service.getState().server, null);
  assert.equal(service.getState().serviceError, "status unavailable");
  assert.equal(starts, 0);
});

test("a failed post-operation re-query retains the result snapshot and releases busy", async () => {
  const service = controller({ serverStatus: async () => { throw new Error("query failed"); } });
  makeReady(service, snapshot());
  await service.start();
  assert.equal(service.getState().server?.state, "starting");
  assert.equal(service.getState().serviceError, "query failed");
  assert.equal(service.getState().serviceBusy, false);
});

test("a successful status refresh recovers unknown state without invoking start", async () => {
  let starts = 0;
  const service = controller({
    startService: async () => { starts++; return { started: true, status: snapshot() }; },
    serverStatus: async () => snapshot({ state: "failed", error: "bind failed" }),
  });
  service.setAvailability(true, null);
  await service.refreshStatus();
  assert.equal(service.getState().server?.state, "failed");
  assert.equal(service.getState().serviceError, null);
  assert.equal(starts, 0);
});

test("stop confirmation uses the native result count; cancellation makes no further API request", async () => {
  const forces: boolean[] = [];
  let queries = 0;
  const running = snapshot({ state: "running", port: 53317, udpPort: 53317, activeTransfers: 1 });
  const service = controller({
    stopService: async (force) => {
      forces.push(force);
      return { confirmationRequired: true, activeTransfers: 7, status: running };
    },
    serverStatus: async () => { queries++; return running; },
  });
  makeReady(service, running);
  await service.stop();
  assert.deepEqual(service.getState().stopConfirmation, { activeTransfers: 7 });
  assert.equal(service.getState().serviceBusy, false);
  service.cancelStop();
  assert.equal(service.getState().stopConfirmation, null);
  assert.equal(service.getState().server?.state, "running");
  assert.deepEqual(forces, [false]);
  assert.equal(queries, 1);
});

test("confirmation is single and force-stop is issued exactly once from the shared controller", async () => {
  const forceResult = deferred<StopServiceResult>();
  const forces: boolean[] = [];
  const running = snapshot({ state: "running", port: 53317, udpPort: 53317, activeTransfers: 3 });
  const service = controller({
    stopService: (force) => {
      forces.push(force);
      if (force) return forceResult.promise;
      return Promise.resolve({ confirmationRequired: true, activeTransfers: 3, status: running });
    },
    serverStatus: async () => forces.includes(true)
      ? snapshot({ state: "stopping", revision: 4 }) : running,
  });
  makeReady(service, running);
  await service.stop();
  await service.stop();
  assert.deepEqual(forces, [false]);
  const first = service.confirmStop();
  await service.confirmStop();
  assert.equal(service.getState().serviceBusy, true);
  service.cancelStop();
  assert.deepEqual(service.getState().stopConfirmation, { activeTransfers: 3 });
  forceResult.resolve({ confirmationRequired: false, activeTransfers: 3, status: snapshot({ state: "stopping", revision: 4 }) });
  await first;
  assert.deepEqual(forces, [false, true]);
  assert.equal(service.getState().stopConfirmation, null);
  assert.equal(service.getState().server?.state, "stopping");
  assert.equal(service.getState().serviceBusy, false);
});

test("failed force-stop keeps the confirmation retryable with a visible error", async () => {
  const running = snapshot({ state: "running", port: 53317, udpPort: 53317 });
  let forceAttempts = 0;
  const service = controller({
    stopService: async (force) => {
      if (force) { forceAttempts++; throw new Error("cleanup refused"); }
      return { confirmationRequired: true, activeTransfers: 2, status: running };
    },
    serverStatus: async () => running,
  });
  makeReady(service, running);
  await service.stop();
  await service.confirmStop();
  assert.equal(service.getState().serviceBusy, false);
  assert.equal(service.getState().serviceError, "cleanup refused");
  assert.deepEqual(service.getState().stopConfirmation, { activeTransfers: 2 });
  await service.confirmStop();
  assert.equal(forceAttempts, 2);
});

test("unknown, loading, missing-host and transitional states never issue start or stop", async () => {
  for (const state of [null, "starting", "stopping"] as const) {
    let calls = 0;
    const service = controller({
      startService: async () => { calls++; return { started: true, status: snapshot() }; },
      stopService: async () => { calls++; return { confirmationRequired: false, activeTransfers: 0, status: snapshot() }; },
    });
    service.setAvailability(true, null);
    if (state) service.applyStatus(snapshot({ state }));
    await service.start();
    await service.stop();
    await service.confirmStop();
    assert.equal(calls, 0);
  }
  let calls = 0;
  const service = controller({ startService: async () => { calls++; return { started: true, status: snapshot() }; } });
  service.applyStatus(snapshot());
  await service.start();
  service.setAvailability(true, "missing host");
  await service.start();
  assert.equal(calls, 0);
});

test("delayed operation results and re-queries cannot replace a newer stopped event", async () => {
  const result = deferred<StartServiceResult>();
  const service = controller({
    startService: () => result.promise,
    serverStatus: async () => snapshot({ state: "running", port: 53317, udpPort: 53317, revision: 5 }),
  });
  makeReady(service, snapshot());
  const action = service.start();
  service.applyStatus(snapshot({ state: "stopped", revision: 9 }));
  result.resolve({ started: true, status: snapshot({ state: "starting", revision: 4 }) });
  await action;
  assert.equal(service.getState().server?.state, "stopped");
  assert.equal(service.getState().server?.revision, 9);
});

test("stopped and failed snapshots clear only live state, not completed history or files", () => {
  const history: TransferRecord[] = [{
    sessionId: "done", direction: "Receive", peerAlias: "Phone", files: [],
    status: "Done", createdAt: 1, destinations: { file: "D:\\Downloads\\saved.txt" },
  }];
  const live = {
    udpPort: 53317,
    devices: ["device"],
    incoming: ["pending"],
    progress: { session: { file: 50 } },
    transfers: history,
  };
  for (const state of ["stopped", "failed"] as const) {
    const next = liveServiceStateForStatus(live, snapshot({ state }));
    assert.deepEqual(next.devices, []);
    assert.equal(next.udpPort, 0);
    assert.deepEqual(next.incoming, []);
    assert.deepEqual(next.progress, {});
    assert.equal(next.transfers, history);
    assert.equal(next.transfers[0].destinations?.file, "D:\\Downloads\\saved.txt");
  }
});

test("background status recovery does not erase a failed manual-operation error", async () => {
  const service = controller({ startService: async () => { throw new Error("start denied"); } });
  makeReady(service, snapshot());
  await service.start();
  await service.refreshStatus();
  assert.equal(service.getState().serviceError, "start denied");
  await service.start();
  assert.equal(service.getState().serviceError, "start denied");
});

test("equal revisions cannot change lifecycle even when a delayed response has different ports", () => {
  const service = controller();
  makeReady(service, snapshot({ state: "stopped", revision: 10 }));
  assert.equal(service.applyStatus(snapshot({ state: "running", port: 53317, udpPort: 53317, revision: 10 })), false);
  assert.equal(service.getState().server?.state, "stopped");
});

test("a non-string state cannot masquerade as a valid lifecycle via toString", () => {
  assert.equal(normalizeServerStatus({ ...snapshot(), state: { toString: () => "stopped" } }), null);
});

test("running restores actual UDP port and only running allows new live traffic", () => {
  const live = { udpPort: 0, devices: ["device"], incoming: ["pending"], progress: {} };
  const running = snapshot({ state: "running", port: 54444, udpPort: 54445 });
  const next = liveServiceStateForStatus(live, running);
  assert.equal(next.udpPort, 54445);
  assert.equal(next.devices, live.devices);
  assert.equal(next.incoming, live.incoming);
  assert.equal(serviceAllowsLiveTraffic(running), true);
  for (const state of ["stopped", "starting", "stopping", "failed"] as const) {
    assert.equal(serviceAllowsLiveTraffic(snapshot({ state })), false, state);
  }
  assert.equal(serviceAllowsLiveTraffic(null), false);
});
