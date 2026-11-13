import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as api from "../api.ts";
import type { ServerStatus } from "../api";

const status: ServerStatus = {
  state: "running", port: 54444, udpPort: 54444, protocol: "https",
  fingerprint: "certificate", error: null, activeTransfers: 3, revision: 8,
};

function bridge(t: TestContext, invoke: (method: string, payload: unknown) => Promise<unknown>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("startService sends only the approved empty payload and unwraps its full status", async (t) => {
  const calls: unknown[] = [];
  bridge(t, async (method, payload) => {
    calls.push({ method, payload });
    return { ok: true, data: { started: true, status } };
  });
  const result = await api.startService();
  assert.deepEqual(calls, [{ method: "start_localsend", payload: {} }]);
  assert.deepEqual(result, { started: true, status });
});

test("stopService defaults to force false and returns the native confirmation count", async (t) => {
  const calls: unknown[] = [];
  bridge(t, async (method, payload) => {
    calls.push({ method, payload });
    return { confirmationRequired: true, activeTransfers: 7, status };
  });
  const result = await api.stopService();
  assert.deepEqual(calls, [{ method: "stop_localsend", payload: { force: false } }]);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.activeTransfers, 7);
  assert.deepEqual(result.status, status);
});

test("forced stop sends force true through callNative and preserves native rejection", async (t) => {
  const calls: unknown[] = [];
  bridge(t, async (method, payload) => {
    calls.push({ method, payload });
    return { ok: false, error: "shutdown already in progress" };
  });
  await assert.rejects(api.stopService(true), /shutdown already in progress/);
  assert.deepEqual(calls, [{ method: "stop_localsend", payload: { force: true } }]);
});

test("mount queries remain passive and a missing-host error is still propagated", async (t) => {
  const calls: string[] = [];
  bridge(t, async (method) => {
    calls.push(method);
    throw new Error("Tauri runtime is unavailable");
  });
  await assert.rejects(api.serverStatus(), /Tauri runtime is unavailable/);
  assert.deepEqual(calls, ["server_status"]);
  assert.equal(api.isPreviewMode(), false);
});
