import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerStatus } from "../api";

// This test process imports the real frontend API in isolated preview mode.
// Any accidental SDK call throws, so simulation cannot silently use a real bridge.
Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "?preview=1" } });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __TAURI_INTERNALS__: {
    invoke: () => { throw new Error("preview must not invoke native"); },
    transformCallback: () => { throw new Error("preview must not subscribe through the SDK"); },
  } },
});
const api = await import("../api.ts");

const completeStatus = (status: ServerStatus) => {
  assert.equal(status.protocol, "https");
  assert.ok(["stopped", "starting", "running", "stopping", "failed"].includes(status.state));
  assert.equal(typeof status.port, "number");
  assert.equal(typeof status.udpPort, "number");
  assert.ok(status.fingerprint === null || typeof status.fingerprint === "string");
  assert.ok(status.error === null || typeof status.error === "string");
  assert.equal(typeof status.activeTransfers, "number");
  assert.equal(typeof status.revision, "number");
};

const waitForTransition = () => new Promise<void>((resolve) => setTimeout(resolve, 450));

test("preview service lifecycle is mutable, isolated, revisioned and preserves completed records", async (t) => {
  await t.test("initial running snapshot counts Pending receive and active transfer records", async () => {
    assert.equal(api.isPreviewMode(), true);
    const status = await api.serverStatus();
    completeStatus(status);
    assert.equal(status.state, "running");
    assert.equal(status.activeTransfers, 2);
    const records = await api.listTransfers();
    assert.equal(records.filter((record) => record.status === "Pending" || record.status === "Transferring").length, 2);
    assert.equal(records.find((record) => record.sessionId === "preview-incoming")?.status, "Pending");
    assert.equal((await api.listDevices()).udpPort, status.udpPort);
  });

  await t.test("preview listen is simulated and default stop returns confirmation without action", async () => {
    const statuses: ServerStatus[] = [];
    const unlisten = await api.onEvent<ServerStatus>(api.EVENTS.serverStatus, (status) => statuses.push(status));
    const before = await api.serverStatus();
    const result = await api.stopService();
    completeStatus(result.status);
    assert.equal(result.confirmationRequired, true);
    assert.equal(result.activeTransfers, 2);
    assert.equal(result.status.state, "running");
    assert.equal((await api.serverStatus()).revision, before.revision);
    assert.equal((await api.listDevices()).devices.length, 3);
    assert.deepEqual(statuses, []);
    await unlisten();
  });

  await t.test("force-stop emits stopping then stopped and cancels only unfinished preview records", async () => {
    const before = await api.serverStatus();
    const completed = (await api.listTransfers()).filter((record) => record.status === "Done");
    const statuses: ServerStatus[] = [];
    const unlisten = await api.onEvent<ServerStatus>(api.EVENTS.serverStatus, (status) => statuses.push(status));
    const result = await api.stopService(true);
    completeStatus(result.status);
    assert.equal(result.confirmationRequired, false);
    assert.equal(result.activeTransfers, 2);
    assert.equal(result.status.state, "stopping");
    await assert.rejects(api.startService(), /stopping|停止中/);
    await waitForTransition();
    const stopped = await api.serverStatus();
    completeStatus(stopped);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.port, 0);
    assert.equal(stopped.udpPort, 0);
    assert.equal(stopped.activeTransfers, 0);
    assert.equal(stopped.fingerprint, before.fingerprint);
    assert.ok(stopped.revision > result.status.revision);
    assert.deepEqual((await api.listDevices()).devices, []);
    assert.equal((await api.listDevices()).udpPort, 0);
    const records = await api.listTransfers();
    assert.equal(records.find((record) => record.sessionId === "preview-incoming")?.status, "Cancelled");
    assert.equal(records.find((record) => record.sessionId === "t1")?.status, "Cancelled");
    assert.deepEqual(records.filter((record) => record.status === "Done"), completed);
    const events = await api.pollEvents();
    assert.equal(events.some((event) => event.event === api.EVENTS.incomingRequest), false);
    assert.equal(events.filter((event) => event.event === api.EVENTS.transferDone).length, 2);
    for (const event of events.filter((event) => event.event === api.EVENTS.serverStatus)) completeStatus(event.data as ServerStatus);
    assert.deepEqual(statuses.map((status) => status.state), ["stopping", "stopped"]);
    await unlisten();
  });

  await t.test("settings_set persists simulation and a passive stopped query never starts", async () => {
    const saved = { ...(await api.getSettings()), alias: "Saved preview name", port: 54444 };
    assert.deepEqual(await api.setSettings(saved), saved);
    assert.deepEqual(await api.getSettings(), saved);
    assert.equal((await api.serverStatus()).state, "stopped");
    assert.deepEqual(await api.pollEvents(), []);
    const repeatedStop = await api.stopService();
    assert.equal(repeatedStop.confirmationRequired, false);
    assert.equal(repeatedStop.status.state, "stopped");
  });

  await t.test("restart uses saved ports, restores discovery and advances revisions without new pending ghosts", async () => {
    const before = await api.serverStatus();
    const result = await api.startService();
    completeStatus(result.status);
    assert.equal(result.started, true);
    assert.equal(result.status.state, "starting");
    const repeated = await api.startService();
    assert.equal(repeated.status.revision, result.status.revision);
    await waitForTransition();
    const running = await api.serverStatus();
    assert.equal(running.state, "running");
    assert.equal(running.port, 54444);
    assert.equal(running.udpPort, 54444);
    assert.equal(running.activeTransfers, 0);
    assert.equal(running.fingerprint, before.fingerprint);
    assert.ok(running.revision > before.revision);
    const devices = await api.listDevices();
    assert.equal(devices.devices.length, 3);
    assert.equal(devices.udpPort, 54444);
    const events = await api.pollEvents();
    assert.equal(events.some((event) => event.event === api.EVENTS.incomingRequest), false);
    assert.equal(events.some((event) => event.event === api.EVENTS.deviceFound), true);
    assert.equal((await api.listTransfers()).filter((record) => record.status === "Pending").length, 0);
  });

  await t.test("preview send creates active records, stop counts them and later starts do not recreate cancelled sends", async () => {
    const device = (await api.listDevices()).devices[0];
    const sent = await api.sendText(device.ip, device.info.port, "test simulation");
    assert.equal((await api.listTransfers()).find((record) => record.sessionId === sent.sessionId)?.status, "Transferring");
    const result = await api.stopService();
    assert.equal(result.confirmationRequired, true);
    assert.equal(result.activeTransfers, 1);
    await api.stopService(true);
    await waitForTransition();
    assert.equal((await api.listTransfers()).find((record) => record.sessionId === sent.sessionId)?.status, "Cancelled");
    await assert.rejects(api.sendText(device.ip, device.info.port, "no service"), /running|运行/);
  });
});
