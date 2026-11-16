import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { mountHook, registerFrontendTestModules } from "./frontendTestModules.ts";
import type { DeviceEntry, FileEntry, IncomingRequestEvent, ServerStatus, Settings, TransferRecord } from "../api";
import type { PluginStore } from "./usePollEvents";

// Only the SDK's DOM picker is replaced. Components, content actions and native API remain real.
registerFrontendTestModules({
  "otools-plugin-sdk/host-file-tree": "export async function pickFromHostTree(options) { return globalThis.__uiHostPick(options); }",
  "otools-plugin-sdk/dialog": "export async function pickDirectory(options) { return globalThis.__uiDirectoryPick(options); }",
});
const { IncomingDialog } = await import("../components/IncomingDialog.tsx");
const { TransferCard } = await import("../components/TransferCard.tsx");
const { FileImagePreview } = await import("../components/FileImagePreview.tsx");
const { DevicesPage } = await import("../pages/Devices.tsx");
const { DeviceCard } = await import("../components/DeviceCard.tsx");
const { SettingsPage } = await import("../pages/Settings.tsx");

const DEFAULT_DIRECTORY = "~/Download/OToolsLocalSend";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZfkAAAAASUVORK5CYII=";
type Element = ReactElement<Record<string, unknown>>;
type NativeCall = { method: string; payload: Record<string, unknown> };
type PickResult = { kind: "picked" | "cancelled"; source: "host-tree"; paths: string[]; names: string[] };
const picked = (path: string): PickResult => ({ kind: "picked", source: "host-tree", paths: [path], names: [path.split(/[\\/]/).pop()!] });
const cancelled: PickResult = { kind: "cancelled", source: "host-tree", paths: [], names: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function replaceGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}
function boundaries(
  t: TestContext,
  invoke: (method: string, payload: Record<string, unknown>) => Promise<unknown> = async (method) => { throw new Error(`unexpected ${method}`); },
  pick: (options: Record<string, unknown>) => Promise<PickResult> = async () => cancelled,
) {
  const calls: NativeCall[] = [];
  const picks: Record<string, unknown>[] = [];
  replaceGlobal(t, "window", { __TAURI_INTERNALS__: { invoke: async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === "resolve_download_directory") return { path: "D:\\fixture\\home\\Download\\OToolsLocalSend" };
    return invoke(method, payload);
  } }, setTimeout: () => 0 });
  replaceGlobal(t, "__uiHostPick", async (options: Record<string, unknown>) => { picks.push(options); return pick(options); });
  replaceGlobal(t, "__uiDirectoryPick", async () => DEFAULT_DIRECTORY);
  return { calls, picks };
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as Element, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return text(node.props.children);
}
function button(node: ReactNode, label: string): Element {
  const found = elements(node).find((element) => element.type === "button" && text(element.props.children as ReactNode).includes(label));
  assert.ok(found, `missing ${label} action`);
  return found;
}
function click(element: Element) {
  assert.notEqual(element.props.disabled, true, "action must be available");
  (element.props.onClick as () => void)();
}
function fileButton(node: ReactNode, fileName: string, label: string) {
  const row = elements(node).find((element) => element.type === "li" && text(element).includes(fileName));
  assert.ok(row, `missing ${fileName} row`);
  return button(row, label);
}
function checkbox(node: ReactNode, fileName: string) {
  const row = elements(node).find((element) => element.type === "li" && text(element).includes(fileName));
  const input = elements(row).find((element) => element.type === "input" && element.props.type === "checkbox");
  assert.ok(input, `missing ${fileName} selection`);
  return input;
}
function image(id = "a"): FileEntry {
  return { id, fileName: `${id}.png`, size: 128, fileType: "image/png", sha256: null, preview: null, metadata: null };
}
function message(body = "  第一行\n第二行  "): FileEntry {
  return { id: "text", fileName: "message.txt", size: 20, fileType: "text/plain", sha256: null, preview: body, metadata: null };
}
function documentFile(id = "doc"): FileEntry {
  return { id, fileName: `${id}.pdf`, size: 64, fileType: "application/pdf", sha256: null, preview: null, metadata: null };
}
const peer: DeviceEntry = {
  ip: "192.168.1.2", lastSeenMs: 0,
  info: { alias: "Phone", version: "2.2", deviceModel: null, deviceType: "mobile", fingerprint: "peer", port: 54445, protocol: "https", download: false },
};
function request(files: FileEntry[] = [image("a"), image("b")], sessionId = "incoming"): IncomingRequestEvent {
  return { sessionId, sender: peer.info, files };
}
type DialogProps = Parameters<typeof IncomingDialog>[0] & { downloadDir?: string | null };
function incoming(t: TestContext, overrides: Partial<DialogProps> = {}) {
  const accepted: Array<{ ids: "all" | string[]; destinations?: Record<string, string> }> = [];
  let declined = 0;
  let props: DialogProps = {
    request: request(), busy: false, error: null, downloadDir: DEFAULT_DIRECTORY,
    onAcceptAll: (destinations?: Record<string, string>) => { accepted.push({ ids: "all", destinations }); },
    onAcceptSelected: (ids: string[], destinations?: Record<string, string>) => { accepted.push({ ids, destinations }); },
    onDecline: () => { declined++; }, ...overrides,
  };
  const hook = mountHook(() => IncomingDialog(props));
  t.after(() => hook.unmount());
  return { hook, accepted, declined: () => declined, update: (next: Partial<DialogProps>) => { props = { ...props, ...next }; return hook.rerender(); } };
}

// Removing await, trimming preview, or routing copy through acceptance must break these tests.
test("incoming text copy preserves the original body and waits for host success without accepting", async (t) => {
  const copy = deferred<boolean>();
  const { calls } = boundaries(t, async (method) => { assert.equal(method, "otools_copy_text"); return copy.promise; });
  const dialog = incoming(t, { request: request([message()]) });
  const bubble = elements(dialog.hook.current()).find((element) => element.props.className === "msg-bubble");
  assert.equal(bubble?.props.children, "  第一行\n第二行  ");
  click(button(dialog.hook.current(), "复制文本"));
  await dialog.hook.flush();
  assert.equal(button(dialog.hook.current(), "复制").props.disabled, true);
  assert.doesNotMatch(text(dialog.hook.current()), /已复制/);
  assert.deepEqual(dialog.accepted, []);
  copy.resolve(true);
  await dialog.hook.flush();
  assert.match(text(dialog.hook.current()), /已复制/);
  assert.deepEqual(calls, [{ method: "otools_copy_text", payload: { text: "  第一行\n第二行  " } }]);
  assert.deepEqual(dialog.accepted, []);
  assert.equal(dialog.declined(), 0);
});

for (const failure of ["false", "reject"] as const) {
  test(`incoming text copy ${failure} stays visible as an error rather than success`, async (t) => {
    boundaries(t, async () => { if (failure === "reject") throw new Error("clipboard denied"); return false; });
    const dialog = incoming(t, { request: request([message()]) });
    click(button(dialog.hook.current(), "复制文本"));
    await dialog.hook.flush();
    const alert = elements(dialog.hook.current()).find((element) => element.props.role === "alert");
    assert.ok(alert, "clipboard failure must be visible");
    assert.match(text(alert), failure === "reject" ? /clipboard denied/ : /复制.*失败/);
    assert.doesNotMatch(text(dialog.hook.current()), /已复制/);
    assert.match(text(dialog.hook.current()), /第一行\n第二行/);
    assert.deepEqual(dialog.accepted, []);
    assert.equal(dialog.declined(), 0);
  });
}

test("mixed incoming entries show text messages but do not invent the body of a plain text file", async (t) => {
  const { calls } = boundaries(t, async () => true);
  const plainFile = { ...message(), id: "plain", fileName: "notes.txt", preview: null };
  const dialog = incoming(t, { request: request([message(), plainFile, image()]) });
  const bubbles = elements(dialog.hook.current()).filter((element) => element.props.className === "msg-bubble");
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].props.children, "  第一行\n第二行  ");
  click(fileButton(dialog.hook.current(), "message.txt", "复制文本"));
  await dialog.hook.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(dialog.accepted, []);
});

test("pending incoming images expose no remote preview or image bytes before consent", () => {
  const dialog = mountHook(() => IncomingDialog({
    request: request([{ ...image(), preview: "https://peer/private-preview" }]), busy: false, error: null,
    onAcceptAll: () => { assert.fail("preview accepted an image"); }, onAcceptSelected: () => { assert.fail("preview accepted an image"); }, onDecline: () => {},
  }));
  try {
    assert.match(text(dialog.current()), /接受后显示预览/);
    assert.equal(elements(dialog.current()).some((element) => element.type === "img" || element.type === FileImagePreview), false);
    assert.doesNotMatch(text(dialog.current()), /https:\/\/peer/);
    assert.equal(elements(dialog.current()).some((element) => element.type === "button" && text(element).includes("复制图片")), false);
  } finally { dialog.unmount(); }
});

test("image save picker stages a local destination and only explicit acceptance submits it", async (t) => {
  const { calls, picks } = boundaries(t, undefined, async () => picked("D:\\fixture\\a.png"));
  const dialog = incoming(t);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  assert.match(text(dialog.hook.current()), /D:\\fixture\\a\.png/);
  assert.match(text(dialog.hook.current()), /同名|已存在/);
  assert.match(text(dialog.hook.current()), /不覆盖|顺延/);
  assert.deepEqual(dialog.accepted, []);
  assert.equal(dialog.declined(), 0);
  assert.deepEqual(calls, [{ method: "resolve_download_directory", payload: { path: "~/Download/OToolsLocalSend" } }], "selecting a target must not request any image bytes");
  assert.equal(picks[0].save, true);
  assert.equal(picks[0].defaultPath, "D:\\fixture\\home\\Download\\OToolsLocalSend/a.png");
  assert.deepEqual(picks[0].filters, [{ name: "图片", extensions: ["png"] }]);
  click(button(dialog.hook.current(), "全部接受"));
  assert.deepEqual(dialog.accepted, [{ ids: "all", destinations: { a: "D:\\fixture\\a.png" } }]);
});

test("selected acceptance filters staged destinations to the actual selected file IDs", async (t) => {
  boundaries(t, undefined, async (options) => picked(String(options.defaultPath).endsWith("a.png") ? "D:\\fixture\\a.png" : "D:\\fixture\\b.png"));
  const dialog = incoming(t);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  click(fileButton(dialog.hook.current(), "b.png", "另存为"));
  await dialog.hook.flush();
  (checkbox(dialog.hook.current(), "a.png").props.onChange as () => void)();
  click(button(dialog.hook.current(), "接受所选"));
  assert.deepEqual(dialog.accepted, [{ ids: ["b"], destinations: { b: "D:\\fixture\\b.png" } }]);
});

test("cancelling a replacement picker preserves existing drafts and selection", async (t) => {
  let attempt = 0;
  boundaries(t, undefined, async () => ++attempt === 1 ? picked("D:\\fixture\\kept.png") : cancelled);
  const dialog = incoming(t);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  (checkbox(dialog.hook.current(), "b.png").props.onChange as () => void)();
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  assert.match(text(dialog.hook.current()), /D:\\fixture\\kept\.png/);
  assert.equal(checkbox(dialog.hook.current(), "b.png").props.checked, false);
  assert.deepEqual(dialog.accepted, []);
  click(button(dialog.hook.current(), "接受所选"));
  assert.deepEqual(dialog.accepted, [{ ids: ["a"], destinations: { a: "D:\\fixture\\kept.png" } }]);
});

test("resetting a staged image target preserves selection and omits an empty destinations map", async (t) => {
  boundaries(t, undefined, async () => picked("D:\\fixture\\a.png"));
  const dialog = incoming(t);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  (checkbox(dialog.hook.current(), "b.png").props.onChange as () => void)();
  click(fileButton(dialog.hook.current(), "a.png", "使用默认目录"));
  assert.doesNotMatch(text(dialog.hook.current()), /D:\\fixture\\a\.png/);
  assert.equal(checkbox(dialog.hook.current(), "b.png").props.checked, false);
  click(button(dialog.hook.current(), "接受所选"));
  assert.deepEqual(dialog.accepted, [{ ids: ["a"], destinations: undefined }]);
});

test("an active image picker locks acceptance and decline, including previously rendered callbacks", async (t) => {
  const pick = deferred<PickResult>();
  boundaries(t, undefined, async () => pick.promise);
  const dialog = incoming(t);
  const accept = button(dialog.hook.current(), "全部接受").props.onClick as () => void;
  const decline = button(dialog.hook.current(), "拒绝").props.onClick as () => void;
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  assert.equal(button(dialog.hook.current(), "全部接受").props.disabled, true);
  assert.equal(button(dialog.hook.current(), "接受所选").props.disabled, true);
  assert.equal(button(dialog.hook.current(), "拒绝").props.disabled, true);
  accept(); decline();
  assert.deepEqual(dialog.accepted, []);
  assert.equal(dialog.declined(), 0);
  pick.resolve(cancelled);
  await dialog.hook.flush();
  assert.equal(button(dialog.hook.current(), "全部接受").props.disabled, false);
  assert.deepEqual(dialog.accepted, []);
});

test("stop overlay suspension retains already staged targets and the exact selected set", async (t) => {
  boundaries(t, undefined, async () => picked("D:\\fixture\\a.png"));
  const dialog = incoming(t);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  (checkbox(dialog.hook.current(), "b.png").props.onChange as () => void)();
  dialog.update({ hidden: true, serviceBusy: true });
  assert.equal(elements(dialog.hook.current())[0].props.hidden, true);
  dialog.update({ hidden: false, serviceBusy: false, request: request() });
  await dialog.hook.flush();
  assert.match(text(dialog.hook.current()), /D:\\fixture\\a\.png/);
  assert.equal(checkbox(dialog.hook.current(), "b.png").props.checked, false);
  click(button(dialog.hook.current(), "接受所选"));
  assert.deepEqual(dialog.accepted, [{ ids: ["a"], destinations: { a: "D:\\fixture\\a.png" } }]);
});

for (const change of ["hidden", "serviceBusy", "busy"] as const) {
  test(`a picker completed after a ${change} transition cannot add a late target`, async (t) => {
    const late = deferred<PickResult>();
    let attempt = 0;
    boundaries(t, undefined, async () => ++attempt === 1 ? picked("D:\\fixture\\kept.png") : late.promise);
    const dialog = incoming(t);
    click(fileButton(dialog.hook.current(), "a.png", "另存为"));
    await dialog.hook.flush();
    (checkbox(dialog.hook.current(), "b.png").props.onChange as () => void)();
    click(fileButton(dialog.hook.current(), "b.png", "另存为"));
    dialog.update({ [change]: true });
    dialog.update({ [change]: false });
    late.resolve(picked("D:\\fixture\\late.png"));
    await dialog.hook.flush();
    assert.match(text(dialog.hook.current()), /D:\\fixture\\kept\.png/);
    assert.doesNotMatch(text(dialog.hook.current()), /D:\\fixture\\late\.png/);
    assert.equal(checkbox(dialog.hook.current(), "b.png").props.checked, false);
    assert.deepEqual(dialog.accepted, []);
    click(button(dialog.hook.current(), "全部接受"));
    assert.deepEqual(dialog.accepted, [{ ids: "all", destinations: { a: "D:\\fixture\\kept.png" } }]);
  });
}

test("session replacement invalidates pending pickers and resets only the new session's local draft", async (t) => {
  const late = deferred<PickResult>();
  boundaries(t, undefined, async () => late.promise);
  const dialog = incoming(t);
  (checkbox(dialog.hook.current(), "b.png").props.onChange as () => void)();
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  dialog.update({ request: request([image("a"), image("b")], "replacement") });
  await dialog.hook.flush();
  late.resolve(picked("D:\\fixture\\old-session.png"));
  await dialog.hook.flush();
  assert.doesNotMatch(text(dialog.hook.current()), /old-session/);
  assert.equal(checkbox(dialog.hook.current(), "b.png").props.checked, true);
  click(button(dialog.hook.current(), "接受所选"));
  assert.deepEqual(dialog.accepted, [{ ids: ["a", "b"], destinations: undefined }]);
});

test("unmount invalidates an outstanding image picker without post-unmount state changes", async (t) => {
  const late = deferred<PickResult>();
  boundaries(t, undefined, async () => late.promise);
  const dialog = incoming(t);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  const before = dialog.hook.current();
  dialog.hook.unmount();
  late.resolve(picked("D:\\fixture\\late.png"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dialog.hook.current(), before, "late picker must not dirty the unmounted component");
  assert.deepEqual(dialog.accepted, []);
  assert.equal(dialog.declined(), 0);
});

test("picker failure is visible while preserving the existing local draft", async (t) => {
  let attempt = 0;
  boundaries(t, undefined, async () => { if (++attempt === 1) return picked("D:\\fixture\\kept.png"); throw new Error("picker unavailable"); });
  const dialog = incoming(t);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  await dialog.hook.flush();
  assert.match(text(dialog.hook.current()), /D:\\fixture\\kept\.png/);
  assert.match(text(elements(dialog.hook.current()).find((element) => element.props.role === "alert")), /picker unavailable/);
  assert.deepEqual(dialog.accepted, []);
});

// Keyboard probes use a small document boundary, not mocked dialog markup or focus helpers.
function focusDocument() {
  let active: FocusNode | null = null;
  let hostTree: FocusNode | null = null;
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const dispatch = (name: string, event: unknown) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(event); };
  class FocusNode {
    disabled = false;
    hidden = false;
    isConnected = true;
    children: FocusNode[] = [];
    parent: FocusNode | null = null;
    readonly name: string;
    readonly button: boolean;
    constructor(name: string, button = false) { this.name = name; this.button = button; }
    focus() { active = this; dispatch("focusin", { target: this }); }
    contains(target: unknown): boolean { return target === this || this.children.some((child) => child.contains(target)); }
    closest(selector: string): FocusNode | null { return selector === "[hidden]" && this.hidden ? this : this.parent?.closest(selector) ?? null; }
    querySelectorAll() { return this.children.filter((child) => child.button && !child.disabled && !child.hidden); }
    getAttribute(name: string) { return name === "aria-disabled" ? "false" : null; }
  }
  const owner = {
    get activeElement() { return active; },
    addEventListener(name: string, listener: (event: unknown) => void) {
      const current = listeners.get(name) ?? new Set(); current.add(listener); listeners.set(name, current);
    },
    removeEventListener(name: string, listener: (event: unknown) => void) { listeners.get(name)?.delete(listener); },
    querySelector(selector: string) { return selector.includes("[data-host-tree]") ? hostTree : null; },
  };
  const root = new FocusNode("incoming-root");
  const save = new FocusNode("save", true);
  const decline = new FocusNode("decline", true);
  const accept = new FocusNode("accept", true);
  root.children = [save, decline, accept];
  for (const child of root.children) child.parent = root;
  Object.assign(root, { ownerDocument: owner });
  const initiating = new FocusNode("initiating", true);
  const background = new FocusNode("background", true);
  const overlay = new FocusNode("sdk-overlay", true);
  const key = (key: string, shiftKey = false) => {
    let prevented = false;
    dispatch("keydown", { key, shiftKey, target: active, preventDefault() { prevented = true; }, stopPropagation() {} });
    return prevented;
  };
  return { owner, root, save, decline, accept, initiating, background, overlay, active: () => active, key, setHostTree: (visible: boolean) => { hostTree = visible ? overlay : null; } };
}
function focusIncoming(t: TestContext) {
  const dom = focusDocument();
  replaceGlobal(t, "document", dom.owner);
  dom.initiating.focus();
  let declines = 0;
  let props: DialogProps = { request: request(), busy: false, error: null, onAcceptAll: () => {}, onAcceptSelected: () => {}, onDecline: () => { declines++; } };
  const hook = mountHook(() => IncomingDialog(props), (node) => {
    dom.root.hidden = Boolean(props.hidden);
    const buttons = elements(node).filter((element) => element.type === "button");
    dom.save.disabled = buttons.find((element) => /另存为|选择中/.test(text(element)))?.props.disabled === true;
    dom.decline.disabled = buttons.find((element) => text(element) === "拒绝")?.props.disabled === true;
    dom.accept.disabled = buttons.find((element) => text(element) === "全部接受")?.props.disabled === true;
    if (!isValidElement(node)) return;
    const ref = (node as unknown as { ref?: unknown }).ref;
    if (typeof ref === "function") ref(dom.root);
    else if (ref && typeof ref === "object") (ref as { current: unknown }).current = dom.root;
  });
  t.after(() => hook.unmount());
  const detachRef = () => {
    const node = hook.current();
    if (!isValidElement(node)) return;
    const ref = (node as unknown as { ref?: unknown }).ref;
    if (typeof ref === "function") ref(null);
    else if (ref && typeof ref === "object") (ref as { current: unknown }).current = null;
  };
  return { ...dom, hook, detachRef, declines: () => declines, update: (next: Partial<DialogProps>) => { props = { ...props, ...next }; hook.rerender(); } };
}

test("incoming keyboard focus belongs only to the visible top modal and returns after stop-overlay suspension", (t) => {
  boundaries(t);
  const dialog = focusIncoming(t);
  assert.equal(dialog.active(), dialog.save, "focus must enter the visible incoming modal");
  dialog.accept.focus();
  assert.equal(dialog.key("Tab"), true);
  assert.equal(dialog.active(), dialog.save);
  assert.equal(dialog.key("Tab", true), true);
  assert.equal(dialog.active(), dialog.accept);
  dialog.background.focus();
  assert.equal(dialog.root.contains(dialog.active()), true);
  dialog.update({ hidden: true });
  dialog.overlay.focus();
  assert.equal(dialog.active(), dialog.overlay);
  assert.equal(dialog.key("Escape"), false, "hidden incoming modal must not consume another modal's Escape");
  assert.equal(dialog.declines(), 0);
  dialog.update({ hidden: false });
  assert.equal(dialog.active(), dialog.save);
  assert.equal(dialog.key("Escape"), true);
  assert.equal(dialog.declines(), 1);
});

test("the active SDK save picker gets focus and keys without a competing incoming focus trap", async (t) => {
  const pick = deferred<PickResult>();
  boundaries(t, undefined, async () => pick.promise);
  const dialog = focusIncoming(t);
  assert.equal(dialog.active(), dialog.save);
  click(fileButton(dialog.hook.current(), "a.png", "另存为"));
  dialog.setHostTree(true);
  dialog.overlay.focus();
  assert.equal(dialog.active(), dialog.overlay, "opening a picker must not redirect its focus back to incoming");
  assert.equal(dialog.key("Escape"), false);
  assert.equal(dialog.key("Tab"), false);
  assert.equal(dialog.declines(), 0);
  dialog.hook.current();
  assert.equal(dialog.active(), dialog.overlay, "suspending incoming focus must not restore a background button");
  dialog.setHostTree(false);
  pick.resolve(cancelled);
  await dialog.hook.flush();
  assert.equal(dialog.active(), dialog.save);
});

test("incoming focus handlers also defer to an already-open SDK tree and never trap its keys", (t) => {
  boundaries(t);
  const dialog = focusIncoming(t);
  dialog.setHostTree(true);
  dialog.overlay.focus();
  assert.equal(dialog.active(), dialog.overlay);
  assert.equal(dialog.key("Escape"), false);
  assert.equal(dialog.key("Tab"), false);
  assert.equal(dialog.declines(), 0);
  dialog.setHostTree(false);
  dialog.background.focus();
  assert.equal(dialog.root.contains(dialog.active()), true);
});

test("closing incoming restores its initiating focus and removes keyboard containment", (t) => {
  boundaries(t);
  const dialog = focusIncoming(t);
  assert.equal(dialog.active(), dialog.save);
  dialog.hook.unmount();
  assert.equal(dialog.active(), dialog.initiating);
  dialog.background.focus();
  assert.equal(dialog.active(), dialog.background);
  assert.equal(dialog.key("Escape"), false);
  assert.equal(dialog.declines(), 0);
});

test("incoming unmount restores its initiating focus even after React detaches the modal ref", (t) => {
  boundaries(t);
  const dialog = focusIncoming(t);
  assert.equal(dialog.active(), dialog.save);
  dialog.detachRef();
  dialog.hook.unmount();
  assert.equal(dialog.active(), dialog.initiating);
});

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return { sessionId: "history", direction: "Send", peerAlias: "Phone", status: "Pending", createdAt: 1, stage: "waiting", files: [documentFile()], ...overrides };
}
function transferRow(t: TestContext, value: TransferRecord, id = value.files[0].id) {
  const card = mountHook(() => TransferCard({ record: value, progress: { [id]: 40 } }));
  const row = elements(card.current()).find((element) => typeof element.type === "function" && (element.props.file as FileEntry | undefined)?.id === id);
  assert.ok(row, `missing history row ${id}`);
  // mountHook intentionally does not auto-render nested components; mount the real row directly.
  const hook = mountHook(() => (row.type as (props: Record<string, unknown>) => ReactNode)(row.props));
  t.after(() => { hook.unmount(); card.unmount(); });
  return hook;
}

test("history text messages expose their original body and awaited copy without requiring a path", async (t) => {
  const copy = deferred<boolean>();
  const { calls } = boundaries(t, async (method) => { assert.equal(method, "otools_copy_text"); return copy.promise; });
  const row = transferRow(t, record({ sessionId: "text-history", files: [message()] }));
  assert.equal(elements(row.current()).find((element) => element.props.className === "msg-bubble")?.props.children, "  第一行\n第二行  ");
  click(button(row.current(), "复制文本"));
  await row.flush();
  assert.doesNotMatch(text(row.current()), /已复制/);
  copy.resolve(true);
  await row.flush();
  assert.match(text(row.current()), /已复制/);
  assert.deepEqual(calls, [{ method: "otools_copy_text", payload: { text: "  第一行\n第二行  " } }]);
  assert.equal(elements(row.current()).some((element) => element.type === "button" && text(element).includes("打开所在文件夹")), false);
});

test("pending send images use a history query for preview and full-resolution copy, never a raw source URL", async (t) => {
  const hostCopy = deferred<boolean>();
  const { calls } = boundaries(t, async (method) => {
    if (method === "prepare_image_copy") return { resourceId: "copy-ui", path: "D:\\fixture\\copy.png", width: 2400, height: 1600 };
    if (method === "otools_copy_image") return hostCopy.promise;
    if (method === "release_image_copy") return {};
    throw new Error(`unexpected ${method}`);
  });
  const row = transferRow(t, record({ sessionId: "pending-send", files: [{ ...image(), preview: "https://peer/private-image" }], sources: { a: "D:\\fixture\\source.png" } }));
  const preview = elements(row.current()).find((element) => element.type === FileImagePreview);
  assert.deepEqual(preview?.props.query, { sessionId: "pending-send", fileId: "a" });
  assert.equal(elements(row.current()).some((element) => element.type === "img"), false);
  assert.equal(elements(row.current()).some((element) => element.type === "button" && text(element).includes("打开所在文件夹")), false);
  click(button(row.current(), "复制图片"));
  await row.flush();
  assert.doesNotMatch(text(row.current()), /已复制/);
  assert.equal(calls.some((call) => call.method === "release_image_copy"), false);
  hostCopy.resolve(true);
  await row.flush();
  assert.match(text(row.current()), /已复制/);
  assert.deepEqual(calls, [
    { method: "prepare_image_copy", payload: { sessionId: "pending-send", fileId: "a" } },
    { method: "otools_copy_image", payload: { image: "D:\\fixture\\copy.png" } },
    { method: "release_image_copy", payload: { resourceId: "copy-ui" } },
  ]);
});

test("history image copy rejection releases the native resource and exposes the actual error", async (t) => {
  const { calls } = boundaries(t, async (method) => {
    if (method === "prepare_image_copy") return { resourceId: "copy-failed", path: "D:\\fixture\\copy.png", width: 12, height: 8 };
    if (method === "otools_copy_image") throw new Error("clipboard denied");
    if (method === "release_image_copy") return {};
    throw new Error(`unexpected ${method}`);
  });
  const row = transferRow(t, record({ sessionId: "copy-failed", files: [image()], sources: { a: "D:\\fixture\\a.png" } }));
  click(button(row.current(), "复制图片"));
  await row.flush();
  assert.match(text(elements(row.current()).find((element) => element.props.role === "alert")), /clipboard denied/);
  assert.doesNotMatch(text(row.current()), /已复制/);
  assert.equal(calls.at(-1)?.method, "release_image_copy");
});

for (const status of ["Failed", "Cancelled"] as const) {
  test(`completed files in a ${status} receive session remain revealable through the exact history reference`, async (t) => {
    const opened = deferred<unknown>();
    const { calls } = boundaries(t, async (method) => {
      if (method === "resolve_transfer_file") return { path: "D:\\fixture\\actual-unique.pdf" };
      if (method === "otools_shell_show_item_in_folder") return opened.promise;
      throw new Error(`unexpected ${method}`);
    });
    const row = transferRow(t, record({ sessionId: `completed-${status}`, direction: "Receive", status, files: [documentFile()], destinations: { doc: "D:\\fixture\\recorded.pdf" } }));
    assert.match(text(row.current()), /D:\\fixture\\recorded\.pdf/);
    click(button(row.current(), "打开所在文件夹"));
    await row.flush();
    assert.doesNotMatch(text(row.current()), /已打开/);
    opened.resolve(null);
    await row.flush();
    assert.match(text(row.current()), /已打开/);
    assert.deepEqual(calls, [
      { method: "resolve_transfer_file", payload: { sessionId: `completed-${status}`, fileId: "doc" } },
      { method: "otools_shell_show_item_in_folder", payload: { path: "D:\\fixture\\actual-unique.pdf" } },
    ]);
  });
}

test("ordinary sending files can reveal their source while pending, without any execute-file action", async (t) => {
  const { calls } = boundaries(t, async (method) => {
    if (method === "resolve_transfer_file") return { path: "D:\\fixture\\source.pdf" };
    if (method === "otools_shell_show_item_in_folder") return null;
    throw new Error(`must not execute file: ${method}`);
  });
  const row = transferRow(t, record({ sessionId: "source-folder", sources: { doc: "D:\\fixture\\source.pdf" } }));
  click(button(row.current(), "打开所在文件夹"));
  await row.flush();
  assert.match(text(row.current()), /已打开/);
  assert.deepEqual(calls.map((call) => call.method), ["resolve_transfer_file", "otools_shell_show_item_in_folder"]);
});

test("missing old paths and uncompleted receive entries remain explicitly unavailable even when a session is Done", (t) => {
  for (const value of [
    record({ status: "Done" }),
    record({ direction: "Receive", status: "Done", destinations: {}, sources: { doc: "D:\\fixture\\not-received.pdf" } }),
    record({ direction: "Receive", status: "Failed", destinations: { other: "D:\\fixture\\other.pdf" } }),
  ]) {
    const row = transferRow(t, value);
    assert.equal(button(row.current(), "打开所在文件夹").props.disabled, true);
    assert.match(text(row.current()), /不可用|没有.*路径|未.*保存/);
  }
  const row = transferRow(t, record({ status: "Done", files: [image()], sources: {} }));
  assert.equal(button(row.current(), "复制图片").props.disabled, true);
  const preview = elements(row.current()).find((element) => element.type === FileImagePreview);
  assert.equal(preview?.props.query, null);
});

test("folder lookup failure is visible and never reports a successful reveal", async (t) => {
  boundaries(t, async () => { throw new Error("file moved"); });
  const row = transferRow(t, record({ sources: { doc: "D:\\fixture\\old.pdf" } }));
  click(button(row.current(), "打开所在文件夹"));
  await row.flush();
  assert.match(text(elements(row.current()).find((element) => element.props.role === "alert")), /file moved/);
  assert.doesNotMatch(text(row.current()), /已打开/);
});

test("folder host false result stays visible as a failure and never claims a successful reveal", async (t) => {
  boundaries(t, async (method) => {
    if (method === "resolve_transfer_file") return { path: "D:\\fixture\\known.pdf" };
    if (method === "otools_shell_show_item_in_folder") return false;
    throw new Error(`unexpected ${method}`);
  });
  const row = transferRow(t, record({ sessionId: "false-folder", sources: { doc: "D:\\fixture\\known.pdf" } }));
  click(button(row.current(), "打开所在文件夹"));
  await row.flush();
  assert.ok(elements(row.current()).some((element) => element.props.role === "alert"), "host failure must be reported in the real file row");
  assert.doesNotMatch(text(row.current()), /已打开/);
});

// The new component begins as a null-rendering compile stub so RED is a UI assertion, not module absence.
test("image preview without a consented local resource shows the pending explanation without native IO", async (t) => {
  const { calls } = boundaries(t);
  const preview = mountHook(() => FileImagePreview({ file: { ...image(), preview: "https://peer/private" }, query: null, pending: true }));
  t.after(() => preview.unmount());
  await preview.flush();
  assert.match(text(preview.current()), /接受后显示预览/);
  assert.equal(elements(preview.current()).some((element) => element.type === "img"), false);
  assert.deepEqual(calls, []);
});

test("image preview renders an accessible loading state then only the native PNG data URL", async (t) => {
  const result = deferred<unknown>();
  const { calls } = boundaries(t, async (method) => { assert.equal(method, "file_preview"); return result.promise; });
  const preview = mountHook(() => FileImagePreview({ file: { ...image(), preview: "https://peer/private" }, query: { sessionId: "preview-ready", fileId: "a" } }));
  t.after(() => preview.unmount());
  assert.match(text(preview.current()), /加载/);
  assert.equal(elements(preview.current()).some((element) => element.props.role === "status"), true);
  result.resolve({ status: "ready", dataUrl: PNG, width: 2400, height: 1600, version: "v1" });
  await preview.flush();
  const img = elements(preview.current()).find((element) => element.type === "img");
  assert.equal(img?.props.src, PNG);
  assert.match(String(img?.props.alt), /a\.png/);
  assert.match(text(preview.current()), /2400.*1600/);
  assert.deepEqual(calls, [{ method: "file_preview", payload: { sessionId: "preview-ready", fileId: "a" } }]);
  (img?.props.onError as () => void)();
  assert.equal(elements(preview.current()).some((element) => element.type === "img"), false);
  assert.match(text(preview.current()), /预览.*不可用|无法.*预览/);
});

test("unavailable and unsafe image results render bounded explanatory placeholders rather than external images", async (t) => {
  boundaries(t, async (_method, payload) => payload.sessionId === "unsafe-preview"
    ? { status: "ready", dataUrl: "https://peer/unsafe", width: 3, height: 2, version: "bad" }
    : { status: "unavailable", reason: "unsupported" });
  for (const sessionId of ["unsupported-preview", "unsafe-preview"]) {
    const preview = mountHook(() => FileImagePreview({ file: image(), query: { sessionId, fileId: "a" } }));
    t.after(() => preview.unmount());
    await preview.flush();
    assert.equal(elements(preview.current()).some((element) => element.type === "img"), false);
    assert.match(text(preview.current()), /不支持|不可用/);
  }
});

const running: ServerStatus = { state: "running", port: 53317, udpPort: 53318, protocol: "https", fingerprint: "certificate", error: null, activeTransfers: 0, revision: 3 };
function settings(downloadDir: string | null = null): Settings {
  return { alias: "Desktop", deviceModel: null, deviceType: "desktop", port: 53317, downloadDir, pin: null, autoSave: false, notifyOnIncoming: true };
}
function store(): PluginStore {
  return {
    ready: true, hostError: null, server: running, settings: settings(), udpPort: 53318,
    devices: [peer], transfers: [], incoming: [], progress: {}, serviceBusy: false, serviceError: null, stopConfirmation: null, stopReturnFocus: null,
    startService: async () => {}, stopService: async () => {}, confirmStopService: async () => {}, cancelStopService: () => {},
    refreshServer: async () => {}, refreshDevices: async () => {}, refreshTransfers: async () => {}, refreshSettings: async () => {}, dismissIncoming: () => {},
  };
}

test("Devices shows the returned outgoing session's real TransferCard while pending and keeps navigation explicit", async (t) => {
  const outgoing = record({ sessionId: "just-sent", files: [image()], sources: { a: "D:\\fixture\\a.png" } });
  const shared = store();
  shared.transfers = [record({ sessionId: "unrelated" })];
  shared.refreshTransfers = async () => { shared.transfers = [outgoing, ...shared.transfers]; };
  const { calls } = boundaries(t, async (method) => {
    if (method === "server_status") return running;
    if (method === "send_files") return { sessionId: "just-sent" };
    throw new Error(`unexpected ${method}`);
  }, async () => picked("D:\\fixture\\a.png"));
  let navigations = 0;
  const page = mountHook(() => DevicesPage({ store: shared, onGoToTransfers: () => { navigations++; } }));
  t.after(() => page.unmount());
  const device = elements(page.current()).find((element) => element.type === DeviceCard);
  assert.ok(device);
  (device.props.onSelect as () => void)();
  click(button(page.current(), "发送文件"));
  await page.flush();
  const card = elements(page.current()).find((element) => element.type === TransferCard);
  assert.equal((card?.props.record as TransferRecord | undefined)?.sessionId, "just-sent");
  assert.deepEqual((card?.props.record as TransferRecord).sources, { a: "D:\\fixture\\a.png" });
  assert.deepEqual(calls, [
    { method: "server_status", payload: {} },
    { method: "send_files", payload: { ip: "192.168.1.2", port: 54445, protocol: "https", files: [{ path: "D:\\fixture\\a.png" }] } },
  ]);
  assert.equal(navigations, 0);
  click(button(page.current(), "查看全部传输"));
  assert.equal(navigations, 1);
});

function directoryInput(node: ReactNode) {
  const label = elements(node).find((element) => element.type === "label" && text(element).includes("下载目录"));
  const input = elements(label).find((element) => element.type === "input" && element.props.type === "text");
  assert.ok(input);
  return input;
}

test("Settings presents the exact default and blank save restores that directory rather than the old plugin-data fallback", async (t) => {
  const { calls } = boundaries(t, async (method, payload) => { assert.equal(method, "settings_set"); return payload.settings; });
  const shared = store();
  const page = mountHook(() => SettingsPage({ store: shared }));
  t.after(() => page.unmount());
  assert.equal(directoryInput(page.current()).props.value, "~/Download/OToolsLocalSend");
  assert.equal(directoryInput(page.current()).props.placeholder, "~/Download/OToolsLocalSend");
  assert.match(text(page.current()), /留空.*默认/);
  (directoryInput(page.current()).props.onChange as (event: unknown) => void)({ target: { value: "   " } });
  click(button(page.current(), "保存设置"));
  await page.flush();
  assert.equal((calls[0].payload.settings as Settings).downloadDir, "~/Download/OToolsLocalSend");
  assert.equal(directoryInput(page.current()).props.value, "~/Download/OToolsLocalSend");
});

test("Settings preserves a valid custom directory when other fields are saved", async (t) => {
  const { calls } = boundaries(t, async (_method, payload) => payload.settings);
  const shared = store();
  shared.settings = settings("D:\\fixture\\custom");
  const page = mountHook(() => SettingsPage({ store: shared }));
  t.after(() => page.unmount());
  assert.equal(directoryInput(page.current()).props.value, "D:\\fixture\\custom");
  click(button(page.current(), "保存设置"));
  await page.flush();
  assert.equal((calls[0].payload.settings as Settings).downloadDir, "D:\\fixture\\custom");
});
