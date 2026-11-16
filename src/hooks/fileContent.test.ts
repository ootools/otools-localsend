import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { registerFrontendTestModules } from "./frontendTestModules.ts";
import type { FileEntry } from "../api";

registerFrontendTestModules();
const api = await import("../api.ts");
const content = await import("../fileContent.ts");

function bridge(t: TestContext, invoke: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

const file = (over: Partial<FileEntry> = {}): FileEntry => ({
  id: "f", fileName: "message.txt", size: 12, fileType: "text/plain", sha256: null,
  preview: "  第一行\n第二行  ", metadata: null, ...over,
});

test("content classification preserves text whitespace and never treats a wire image URL as content", () => {
  assert.equal(content.textContent(file()), "  第一行\n第二行  ");
  assert.equal(content.textContent(file({ preview: "" })), "");
  assert.equal(content.textContent(file({ preview: null })), null);
  assert.equal(content.textContent(file({ fileType: "text/plain; charset=utf-8" })), null);
  assert.equal(content.textContent(file({ fileType: "image/png", preview: "https://peer/private-image" })), null);
  assert.equal(content.isImageFile(file({ fileType: "image/png", fileName: "photo.bin" })), true);
  assert.equal(content.isImageFile(file({ fileType: "application/octet-stream", fileName: "PHOTO.JPEG" })), true);
  assert.equal(content.isImageFile(file({ fileType: "text/plain", fileName: "note.txt" })), false);
});

test("acceptSession only adds explicit save targets and leaves the legacy empty payload unchanged", async (t) => {
  const calls: unknown[] = [];
  bridge(t, async (method, payload) => { calls.push({ method, payload }); return { accepted: ["f"] }; });
  await api.acceptSession("receive", ["f"], { f: "D:\\fixture\\photo.png" });
  await api.acceptSession("legacy", "all", {});
  assert.deepEqual(calls, [
    { method: "session_accept", payload: { sessionId: "receive", fileIds: ["f"], destinations: { f: "D:\\fixture\\photo.png" } } },
    { method: "session_accept", payload: { sessionId: "legacy" } },
  ]);
});

test("previewFile sends an exclusive history reference and returns only the bounded native response", async (t) => {
  const calls: unknown[] = [];
  const response = { status: "ready", dataUrl: "data:image/png;base64,cG5n", width: 900, height: 600, version: "v1" };
  bridge(t, async (method, payload) => { calls.push({ method, payload }); return { ok: true, data: response }; });
  assert.deepEqual(await api.previewFile({ sessionId: "s", fileId: "f" }), response);
  assert.deepEqual(calls, [{ method: "file_preview", payload: { sessionId: "s", fileId: "f" } }]);
});

test("text copy waits for the actual host result and preserves rejection and false results", async (t) => {
  const calls: unknown[] = [];
  let finish!: (value: boolean) => void;
  let settled = false;
  bridge(t, async (method, payload) => {
    calls.push({ method, payload });
    return new Promise<boolean>((resolve) => { finish = resolve; });
  });
  const copy = content.copyTextContent("  line\nline  ").then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish(true);
  await copy;
  assert.equal(settled, true);
  assert.deepEqual(calls, [{ method: "otools_copy_text", payload: { text: "  line\nline  " } }]);
});

test("a host false clipboard result is never reported as copied", async (t) => {
  bridge(t, async () => false);
  await assert.rejects(content.copyTextContent("fixture"), /复制|clipboard/i);
});

test("image copy uses a stable full-resolution local resource then releases it after host success", async (t) => {
  const calls: unknown[] = [];
  bridge(t, async (method, payload) => {
    calls.push({ method, payload });
    if (method === "prepare_image_copy") return { resourceId: "copy-1", path: "D:\\fixture\\copy.png", width: 2400, height: 1600 };
    if (method === "otools_copy_image") return true;
    if (method === "release_image_copy") return {};
    throw new Error(`unexpected ${method}`);
  });
  await content.copyImageContent({ sessionId: "s", fileId: "f" });
  assert.deepEqual(calls, [
    { method: "prepare_image_copy", payload: { sessionId: "s", fileId: "f" } },
    { method: "otools_copy_image", payload: { image: "D:\\fixture\\copy.png" } },
    { method: "release_image_copy", payload: { resourceId: "copy-1" } },
  ]);
});

test("image clipboard rejection still releases the generated file and preserves the host cause", async (t) => {
  const calls: string[] = [];
  bridge(t, async (method) => {
    calls.push(method);
    if (method === "prepare_image_copy") return { resourceId: "copy-2", path: "D:\\fixture\\copy.png", width: 12, height: 8 };
    if (method === "otools_copy_image") throw new Error("clipboard unavailable");
    if (method === "release_image_copy") return {};
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(content.copyImageContent({ sessionId: "s", fileId: "f" }), /clipboard unavailable/);
  assert.deepEqual(calls, ["prepare_image_copy", "otools_copy_image", "release_image_copy"]);
});

test("folder reveal resolves the real transfer resource first and never opens or executes the file", async (t) => {
  const calls: unknown[] = [];
  bridge(t, async (method, payload) => {
    calls.push({ method, payload });
    if (method === "resolve_transfer_file") return { path: "D:\\fixture\\received.pdf" };
    if (method === "otools_shell_show_item_in_folder") return null;
    throw new Error(`unexpected ${method}`);
  });
  await content.openTransferFolder("s", "f");
  assert.deepEqual(calls, [
    { method: "resolve_transfer_file", payload: { sessionId: "s", fileId: "f" } },
    { method: "otools_shell_show_item_in_folder", payload: { path: "D:\\fixture\\received.pdf" } },
  ]);
});

test("unknown history resources do not dispatch a folder command", async (t) => {
  const calls: string[] = [];
  bridge(t, async (method) => { calls.push(method); throw new Error("file unavailable"); });
  await assert.rejects(content.openTransferFolder("missing", "f"), /file unavailable/);
  assert.deepEqual(calls, ["resolve_transfer_file"]);
});
