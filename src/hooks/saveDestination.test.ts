import assert from "node:assert/strict";
import { test } from "node:test";
import { registerFrontendTestModules } from "./frontendTestModules.ts";

const picks: Array<Record<string, unknown>> = [];
registerFrontendTestModules({
  "otools-plugin-sdk/host-file-tree": "export async function pickFromHostTree(options) { return globalThis.__destinationPick(options); }",
});
Object.defineProperty(globalThis, "__destinationPick", { configurable: true, value: async (options: Record<string, unknown>) => {
  picks.push(options);
  return { kind: "cancelled", source: "host-tree", paths: [], names: [] };
} });
const { chooseImageDestination } = await import("../fileContent.ts");

test("self-drawn save picker starts from the resolved local directory instead of literal tilde", async () => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (method: string, payload: unknown) => {
      calls.push({ method, payload });
      assert.equal(method, "resolve_download_directory");
      return { path: "D:\\fixture\\home\\Download\\OToolsLocalSend" };
    },
  } } });
  try {
    const result = await chooseImageDestination({ id: "image", fileName: "photo.png", size: 123, fileType: "image/png", sha256: null, preview: null, metadata: null }, "~/Download/OToolsLocalSend");
    assert.equal(result, null);
    assert.deepEqual(calls, [{ method: "resolve_download_directory", payload: { path: "~/Download/OToolsLocalSend" } }]);
    assert.equal(picks[0].defaultPath, "D:\\fixture\\home\\Download\\OToolsLocalSend/photo.png");
    assert.equal(picks[0].save, true);
    assert.equal(calls.some((item) => item.method === "session_accept"), false);
  } finally { Reflect.deleteProperty(globalThis, "window"); }
});
