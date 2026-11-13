import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactNode } from "react";
import { mountHook, registerFrontendTestModules } from "./frontendTestModules.ts";

registerFrontendTestModules();
const { StopServiceDialog } = await import("../components/ServiceControls.tsx");

/** Minimal document boundary with real listener/active-element semantics for keyboard probes. */
function focusDocument() {
  let active: FocusNode | null = null;
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  class FocusNode {
    disabled = false;
    hidden = false;
    isConnected = true;
    parent: FocusNode | null = null;
    children: FocusNode[] = [];
    readonly name: string;
    readonly button: boolean;
    constructor(name: string, button = false) { this.name = name; this.button = button; }
    focus() { active = this; dispatch("focusin", { target: this }); }
    contains(target: unknown): boolean { return target === this || this.children.some((child) => child.contains(target)); }
    closest(selector: string): FocusNode | null {
      if (selector === "[hidden]" && this.hidden) return this;
      return this.parent?.closest(selector) ?? null;
    }
    querySelectorAll() { return this.children.filter((child) => child.button && !child.disabled && !child.hidden); }
    getAttribute(name: string) { return name === "aria-disabled" ? "false" : null; }
  }
  const dispatch = (name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event); };
  const owner = {
    get activeElement() { return active; },
    addEventListener(name: string, listener: (event: unknown) => void) {
      const list = listeners.get(name) ?? new Set(); list.add(listener); listeners.set(name, list);
    },
    removeEventListener(name: string, listener: (event: unknown) => void) { listeners.get(name)?.delete(listener); },
  };
  const root = new FocusNode("dialog");
  const cancel = new FocusNode("cancel", true);
  const confirm = new FocusNode("confirm", true);
  const initiating = new FocusNode("initiating", true);
  const background = new FocusNode("background", true);
  root.children = [cancel, confirm];
  cancel.parent = root; confirm.parent = root;
  Object.assign(root, { ownerDocument: owner });
  const key = (key: string, shiftKey = false) => {
    let prevented = false;
    const event = { key, shiftKey, target: active, preventDefault() { prevented = true; }, stopPropagation() {} };
    dispatch("keydown", event);
    // Emulate default browser tab order; a trap has to prevent reaching background.
    if (key === "Tab" && !prevented) active = background;
    return prevented;
  };
  return { owner, root, cancel, confirm, initiating, background, key, active: () => active, FocusNode };
}

function wireRef(node: ReactNode, root: unknown) {
  if (!isValidElement<Record<string, unknown>>(node)) return;
  const ref = (node as unknown as { ref?: unknown }).ref;
  if (typeof ref === "function") ref(root);
  else if (ref && typeof ref === "object") (ref as { current: unknown }).current = root;
}

function keyboardDialog(busy = false) {
  const dom = focusDocument();
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.owner });
  dom.initiating.focus();
  let cancellations = 0;
  let isBusy = busy;
  const hook = mountHook(() => StopServiceDialog({
    activeTransfers: 2, busy: isBusy, error: null,
    onCancel: () => { cancellations++; }, onConfirm: () => {},
  }), (node) => {
    dom.cancel.disabled = isBusy;
    dom.confirm.disabled = isBusy;
    wireRef(node, dom.root);
  });
  return {
    ...dom,
    hook,
    cancellations: () => cancellations,
    setBusy: (next: boolean) => { isBusy = next; hook.rerender(); },
    close: () => {
      hook.unmount();
      if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

test("review 7: focus enters confirmation and Tab/Shift-Tab remain contained rather than reaching background", () => {
  const dialog = keyboardDialog();
  try {
    assert.equal(dialog.active(), dialog.cancel);
    dialog.confirm.focus();
    dialog.key("Tab");
    assert.equal(dialog.active(), dialog.cancel);
    dialog.key("Tab", true);
    assert.equal(dialog.active(), dialog.confirm);
    dialog.background.focus();
    assert.equal(dialog.root.contains(dialog.active()), true, "focus leaving the active modal must be redirected");
  } finally { dialog.close(); }
});

test("review 7: Escape cancels only when idle and busy updates do not release keyboard containment", () => {
  const dialog = keyboardDialog();
  try {
    dialog.key("Escape");
    assert.equal(dialog.cancellations(), 1);
    dialog.setBusy(true);
    dialog.key("Escape");
    assert.equal(dialog.cancellations(), 1);
    dialog.key("Tab");
    assert.equal(dialog.root.contains(dialog.active()), true);
    dialog.setBusy(false);
    dialog.key("Escape");
    assert.equal(dialog.cancellations(), 2);
  } finally { dialog.close(); }
});

test("review 7: closing confirmation restores the initiating button and removes its focus listeners", () => {
  const dialog = keyboardDialog();
  dialog.confirm.focus();
  dialog.close();
  assert.equal(dialog.active(), dialog.initiating);
  dialog.background.focus();
  assert.equal(dialog.active(), dialog.background);
  dialog.key("Escape");
  assert.equal(dialog.cancellations(), 0);
});
