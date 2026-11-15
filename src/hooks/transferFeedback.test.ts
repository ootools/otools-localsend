import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, isValidElement, type ReactNode } from "react";
import { mountHook, registerFrontendTestModules } from "./frontendTestModules.ts";
import type { TransferRecord } from "../api";

registerFrontendTestModules();
const { TransferCard } = await import("../components/TransferCard.tsx");

const record = (over: Partial<TransferRecord> = {}): TransferRecord => ({
  sessionId: "send-id", direction: "Send", peerAlias: "Phone", status: "Pending", createdAt: 1,
  stage: "waiting",
  files: [{ id: "f1", fileName: "notes.txt", size: 12, fileType: "text/plain", sha256: null, preview: null, metadata: null }],
  ...over,
});

function allElements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(allElements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as unknown as { type: unknown; props: Record<string, unknown> }, ...allElements(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return text(node.props.children);
}

test("waiting transfers explain receiver consent rather than claiming data was already sent", () => {
  const html = renderToStaticMarkup(createElement(TransferCard, { record: record() }));
  assert.match(html, /等待对方确认/);
});

test("failed records expose the sanitized native transport error and are not pending", () => {
  const html = renderToStaticMarkup(createElement(TransferCard, { record: record({ status: "Failed", stage: "finished", error: "准备上传失败（HTTP 401，需要 PIN）" }) }));
  assert.match(html, /已失败/);
  assert.match(html, /准备上传失败/);
  assert.match(html, /HTTP 401/);
  assert.doesNotMatch(html, /待确认/);
});

test("nonterminal transfers have a cancel action and terminal ones do not", async (t) => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (method: string, payload: unknown) => { calls.push({ method, payload }); return {}; } },
  } });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  for (const status of ["Pending", "Transferring"] as const) {
    const card = mountHook(() => TransferCard({ record: record({ status }) }));
    t.after(() => card.unmount());
    const cancel = allElements(card.current()).find((element) => element.type === "button" && text(element.props.children as ReactNode).includes("取消传输"));
    assert.ok(cancel, `${status} cannot be cancelled`);
    (cancel.props.onClick as () => void)();
    await card.flush();
  }
  assert.deepEqual(calls, [
    { method: "session_cancel", payload: { sessionId: "send-id" } },
    { method: "session_cancel", payload: { sessionId: "send-id" } },
  ]);
  for (const status of ["Done", "Cancelled", "Failed"] as const) {
    const html = renderToStaticMarkup(createElement(TransferCard, { record: record({ status }) }));
    assert.doesNotMatch(html, /取消传输/);
  }
});
