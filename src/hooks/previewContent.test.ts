import assert from "node:assert/strict";
import { test } from "node:test";
import { registerFrontendTestModules } from "./frontendTestModules.ts";

registerFrontendTestModules();
Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "?preview=1" } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
  invoke: () => { throw new Error("preview must not use the real host"); },
} } });
const api = await import("../api.ts");
const content = await import("../fileContent.ts");

test("preview content operations stage save without accepting and use simulated completed images only", async () => {
  assert.equal((await api.getSettings()).downloadDir, "~/Download/OToolsLocalSend");
  const records = await api.listTransfers();
  const pending = records.find((record) => record.sessionId === "preview-incoming")!;
  const image = pending.files.find((file) => file.fileType === "image/png")!;
  assert.ok(image, "preview lacks a pending image fixture");
  const path = await content.chooseImageDestination(image);
  assert.equal(path, "~/Download/OToolsLocalSend/旅行风景.png");
  assert.equal((await api.listTransfers()).find((record) => record.sessionId === pending.sessionId)?.status, "Pending");
  assert.equal((await api.previewFile({ sessionId: pending.sessionId, fileId: image.id })).status, "unavailable");
  await api.acceptSession(pending.sessionId, [image.id], { [image.id]: "/preview/Download/OToolsLocalSend/另存图片.png" });
  await new Promise<void>((resolve) => setTimeout(resolve, 700));
  const accepted = (await api.listTransfers()).find((record) => record.sessionId === pending.sessionId)!;
  assert.equal(accepted.status, "Done");
  assert.deepEqual(accepted.destinations, { [image.id]: "/preview/Download/OToolsLocalSend/另存图片.png" });
  const preview = await api.previewFile({ sessionId: pending.sessionId, fileId: image.id });
  assert.equal(preview.status, "ready");
  assert.match(preview.dataUrl ?? "", /^data:image\/png;base64,/);
  await content.copyImageContent({ sessionId: pending.sessionId, fileId: image.id });
  await content.copyTextContent("preview\ntext");
  await content.openTransferFolder(pending.sessionId, image.id);
});

test("preview file sends preserve local sources and classify images without altering wire preview", async () => {
  const sent = await api.sendFiles("192.168.31.20", 53317, ["/preview/photo.png"]);
  const record = (await api.listTransfers()).find((item) => item.sessionId === sent.sessionId)!;
  assert.equal(record.files[0].fileType, "image/png");
  assert.equal(record.files[0].preview, null);
  assert.equal(record.sources?.[record.files[0].id], "/preview/photo.png");
});
