import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingIncomingFromTransfers } from "./incomingRebuild.ts";
import type { TransferRecord } from "../api";

const record = (over: Partial<TransferRecord> = {}): TransferRecord => ({
  sessionId: "s1",
  direction: "Receive",
  peerAlias: "手机",
  files: [{
    id: "f1",
    fileName: "a.txt",
    size: 1,
    fileType: "text/plain",
    sha256: null,
    preview: null,
    metadata: null,
  }],
  status: "Pending",
  createdAt: 1,
  ...over,
});

test("pending receive records rebuild into a dialog source", () => {
  const queue = pendingIncomingFromTransfers([record()]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].sessionId, "s1");
  assert.equal(queue[0].sender.alias, "手机");
  assert.equal(queue[0].files[0].fileName, "a.txt");
});

test("non-pending and send-direction records are ignored", () => {
  const queue = pendingIncomingFromTransfers([
    record({ sessionId: "a", status: "Transferring" }),
    record({ sessionId: "b", status: "Done" }),
    record({ sessionId: "c", direction: "Send" }),
  ]);
  assert.deepEqual(queue, []);
});

test("duplicate session ids produce exactly one dialog", () => {
  const queue = pendingIncomingFromTransfers([record({ sessionId: "x" }), record({ sessionId: "x" })]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].sessionId, "x");
});

test("missing alias falls back to a placeholder sender", () => {
  const queue = pendingIncomingFromTransfers([record({ peerAlias: "" })]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].sender.alias, "未知设备");
});

test("records without files still rebuild without throwing", () => {
  const missingFiles = { ...record(), files: undefined } as unknown as TransferRecord;
  const queue = pendingIncomingFromTransfers([missingFiles]);
  assert.deepEqual(queue[0].files, []);
});
