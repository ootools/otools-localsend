import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mountHook, registerFrontendTestModules } from "./frontendTestModules.ts";
import type { FilePreview, FileResourceQuery } from "../api";

registerFrontendTestModules();
const { useFilePreview } = await import("./useFilePreview.ts");
const ready = (version: string): FilePreview => ({
  status: "ready", dataUrl: "data:image/png;base64,cG5n", width: 1200, height: 800, version,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function bridge(t: TestContext, invoke: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("image hook requests local bytes once and does not reload on unrelated record rerenders", async (t) => {
  const calls: unknown[] = [];
  bridge(t, async (method, payload) => { calls.push({ method, payload }); return ready("a"); });
  const hook = mountHook(() => useFilePreview({ sessionId: "cache-stable", fileId: "f" }));
  t.after(() => hook.unmount());
  await hook.flush();
  assert.equal(hook.current().status, "ready");
  for (let repeat = 0; repeat < 20; repeat++) hook.rerender();
  await hook.flush();
  assert.deepEqual(calls, [{ method: "file_preview", payload: { sessionId: "cache-stable", fileId: "f" } }]);
});

test("late preview from an old resource cannot appear after a session switch", async (t) => {
  const slow = deferred<FilePreview>();
  bridge(t, async (_method, payload) => payload.sessionId === "late-a" ? slow.promise : ready("b"));
  let query: FileResourceQuery = { sessionId: "late-a", fileId: "f" };
  const hook = mountHook(() => useFilePreview(query));
  t.after(() => hook.unmount());
  assert.equal(hook.current().status, "loading");
  query = { sessionId: "late-b", fileId: "f" };
  hook.rerender();
  await hook.flush();
  assert.equal(hook.current().version, "b");
  slow.resolve(ready("a"));
  await hook.flush();
  assert.equal(hook.current().version, "b");
});

test("preview with no received resource never triggers a native read", async (t) => {
  bridge(t, async () => { throw new Error("pending metadata must not read bytes"); });
  const hook = mountHook(() => useFilePreview(null));
  t.after(() => hook.unmount());
  await hook.flush();
  assert.equal(hook.current().status, "unavailable");
  assert.equal(hook.current().reason, "not-received");
});

test("concurrent image consumers coalesce the same native resource request", async (t) => {
  const slow = deferred<FilePreview>();
  let calls = 0;
  bridge(t, async () => { calls++; return slow.promise; });
  const query = { sessionId: "shared-request", fileId: "f" };
  const first = mountHook(() => useFilePreview(query));
  const second = mountHook(() => useFilePreview(query));
  t.after(() => { first.unmount(); second.unmount(); });
  await Promise.resolve();
  assert.equal(calls, 1);
  slow.resolve(ready("shared"));
  await first.flush();
  await second.flush();
  assert.equal(first.current().version, "shared");
  assert.equal(second.current().version, "shared");
});

test("preview requests are bounded to two simultaneous native decodes", async (t) => {
  const jobs: Array<ReturnType<typeof deferred<FilePreview>>> = [];
  let active = 0;
  let peak = 0;
  bridge(t, async () => {
    const job = deferred<FilePreview>();
    jobs.push(job); active++; peak = Math.max(peak, active);
    try { return await job.promise; } finally { active--; }
  });
  const hooks = Array.from({ length: 5 }, (_, index) => mountHook(() => useFilePreview({ path: `D:\\fixture\\bounded-${index}.png` })));
  t.after(() => hooks.forEach((hook) => hook.unmount()));
  await Promise.resolve();
  assert.equal(jobs.length, 2);
  for (let index = 0; index < hooks.length; index++) {
    jobs[index]?.resolve(ready(String(index)));
    await hooks[0].flush();
  }
  assert.equal(jobs.length, 5);
  assert.equal(peak, 2);
});

test("image hook rejects URL preview data rather than loading a remote address", async (t) => {
  bridge(t, async () => ({ status: "ready", dataUrl: "https://peer/secret", width: 1, height: 1, version: "bad" }));
  const hook = mountHook(() => useFilePreview({ sessionId: "invalid-url", fileId: "f" }));
  t.after(() => hook.unmount());
  await hook.flush();
  assert.equal(hook.current().status, "unavailable");
  assert.equal(hook.current().dataUrl, undefined);
});

test("a changed actual path identity invalidates the cache even when session and file IDs stay equal", async (t) => {
  let sequence = 0;
  bridge(t, async () => ready(String(++sequence)));
  let version = "temporary-path";
  const hook = mountHook(() => useFilePreview({ sessionId: "commit-change", fileId: "f" }, true, version));
  t.after(() => hook.unmount());
  await hook.flush();
  assert.equal(hook.current().version, "1");
  version = "committed-path";
  hook.rerender();
  await hook.flush();
  assert.equal(hook.current().version, "2");
});
