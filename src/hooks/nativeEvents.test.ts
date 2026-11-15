import assert from "node:assert/strict";
import { test } from "node:test";
import { registerFrontendTestModules } from "./frontendTestModules.ts";

registerFrontendTestModules({
  "@tauri-apps/api/core": 'export { invoke } from "otools-plugin-sdk/runtime";',
  "@tauri-apps/api/event": 'export { listen } from "otools-plugin-sdk/runtime";',
});
const api = await import("../api.ts");

test("pollEvents normalizes the actual host topic/payload contract without losing transfer data", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const request = { sessionId: "incoming", sender: { alias: "Phone" }, files: [{ id: "f1", fileName: "photo.jpg" }] };
  const progress = { sessionId: "incoming", fileId: "f1", percent: 43 };
  const done = { sessionId: "send", status: "failed", error: "TLS connection failed" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (method: string) => {
      assert.equal(method, "poll_events");
      return { ok: true, data: { events: [
        { topic: "incoming-request", payload: request },
        { topic: "transfer-progress", payload: progress },
        { topic: "transfer-done", payload: done },
      ] } };
    } },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  assert.deepEqual(await api.pollEvents(), [
    { event: "incoming-request", data: request },
    { event: "transfer-progress", data: progress },
    { event: "transfer-done", data: done },
  ]);
});

test("pollEvents still accepts old event/data and skips malformed queue entries", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async () => ({ events: [
      { event: "incoming-request", data: { sessionId: "old" } },
      { topic: "server-status", payload: null },
      null,
      { topic: "", payload: { unsafe: true } },
      { data: { sessionId: "no-topic" } },
      { topic: "transfer-done", payload: { sessionId: "new", status: "done" }, data: { sessionId: "wrong" } },
    ] }) },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  assert.deepEqual(await api.pollEvents(), [
    { event: "incoming-request", data: { sessionId: "old" } },
    { event: "server-status", data: null },
    { event: "transfer-done", data: { sessionId: "new", status: "done" } },
  ]);
});

test("canonical payload survives the real vendored SDK native listener boundary", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const windowTarget = new EventTarget();
  let push!: (message: unknown) => void;
  let released = 0;
  Object.assign(windowTarget, {
    getPluginUuid: () => "otools-localsend",
    otools: {
      getPluginUuid: () => "otools-localsend",
      invokeNative: async () => ({}),
      listenNative: async (handler: (message: unknown) => void) => {
        push = handler;
        return () => { released++; };
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const received: unknown[] = [];
  const unsubscribe = await api.onEvent("incoming-request", (payload) => received.push(payload));
  const request = { sessionId: "host-polled-request", sender: { alias: "Phone" }, files: [] };
  // The host consumes topic/payload from the DLL queue, then emits the same
  // envelope through listenNative. Do not use direct Tauri test callbacks here.
  push({ payload: { topic: "incoming-request", payload: request } });
  assert.deepEqual(received, [request]);
  await unsubscribe();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
});
