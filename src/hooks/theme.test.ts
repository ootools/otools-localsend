import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { registerFrontendTestModules } from "./frontendTestModules.ts";
import { initializeTheme } from "../theme.ts";

/** Node has event targets but no document; keep the browser boundary small and observable. */
function themeBrowser(options: { snapshot?: unknown; classes?: string[]; embedded?: boolean; delayedRoot?: boolean; osDark?: boolean } = {}) {
  const classes = new Set(options.classes ?? []);
  const properties = new Map<string, string>([
    ["--accent", "#4a7dff"], ["--accent-deep", "#2b5be0"], ["--accent-ink", "#1d3a8f"],
  ]);
  const root = {
    classList: {
      contains: (name: string) => classes.has(name),
      add: (...names: string[]) => { for (const name of names) classes.add(name); },
      remove: (...names: string[]) => { for (const name of names) classes.delete(name); },
      toggle: (name: string, force?: boolean) => {
        const present = force ?? !classes.has(name);
        if (present) classes.add(name); else classes.delete(name);
        return present;
      },
    },
    style: {
      colorScheme: "",
      fontFamily: "Segoe UI",
      getPropertyValue: (name: string) => properties.get(name) ?? "",
      setProperty: (name: string, value: string) => { properties.set(name, value); },
    },
    dataset: { hostRole: "plugin" } as Record<string, string>,
  };
  const appRoot = {};
  const doc = Object.assign(new EventTarget(), {
    documentElement: options.delayedRoot ? null : root,
    readyState: options.delayedRoot ? "loading" : "complete",
    getElementById: (id: string) => id === "root" ? appRoot : null,
  });
  const win = Object.assign(new EventTarget(), {
    __OTOOLS_THEME__: options.snapshot,
    parent: null as unknown,
    matchMedia: () => ({ matches: options.osDark ?? false }),
  });
  const parent = options.embedded ? new EventTarget() : win;
  win.parent = parent;
  return {
    win, doc, root, appRoot, parent,
    hostEvent: (detail: unknown, target: EventTarget = win) => target.dispatchEvent(new CustomEvent("otools-theme-changed", { detail })),
    message: (data: unknown, source: unknown = parent, origin = "https://different-host.example") => {
      const event = new Event("message");
      Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: origin } });
      win.dispatchEvent(event);
    },
    ready: () => {
      doc.documentElement = root;
      doc.readyState = "interactive";
      doc.dispatchEvent(new Event("DOMContentLoaded"));
    },
  };
}

function assertTheme(root: ReturnType<typeof themeBrowser>["root"], expected: "light" | "dark") {
  assert.equal(root.style.colorScheme, expected, "native controls must use the resolved theme");
  assert.equal(root.classList.contains("light"), expected === "light");
  assert.equal(root.classList.contains("dark"), expected === "dark");
}

test("startup is bright before React mounts when there is no host, even on a dark OS", async (t) => {
  const browser = themeBrowser({ osDark: true });
  const globals: Record<string, unknown> = {
    window: browser.win,
    document: browser.doc,
    __themeTestCreateRoot: (container: unknown) => {
      assert.equal(container, browser.appRoot);
      assertTheme(browser.root, "light");
      return { render() {} };
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  // Rendering and CSS loading are external to initialization; execute the actual bootstrap.
  const modules = registerFrontendTestModules({
    "./App": "export function App() { return null; }",
    "react-dom/client": "export default { createRoot(container) { return globalThis.__themeTestCreateRoot(container); } };",
    "virtual:uno.css": "export {};",
    "./styles.css": "export {};",
  });
  t.after(() => modules.deregister());
  await import("../main.tsx");
});

function startTheme(t: TestContext, browser: ReturnType<typeof themeBrowser>) {
  const dispose = initializeTheme(browser.win as unknown as Window, browser.doc as unknown as Document);
  t.after(dispose);
  return dispose;
}

test("initial host snapshots win over root classes and resolvedTheme wins over explicit mode", (t) => {
  for (const fixture of [
    { mode: "system", resolved: "dark", accent: "violet", classes: ["light"], expected: "dark" },
    { mode: "dark", resolved: "light", accent: "emerald", classes: ["dark"], expected: "light" },
    { mode: "light", resolved: "dark", accent: "amber", classes: [], expected: "dark" },
    { mode: "light", resolved: "light", accent: "pink", classes: ["dark"], expected: "light" },
  ] as const) {
    const browser = themeBrowser({
      snapshot: { themeMode: fixture.mode, themeAccent: fixture.accent, resolvedTheme: fixture.resolved },
      classes: [...fixture.classes],
    });
    startTheme(t, browser);
    assertTheme(browser.root, fixture.expected);
    assert.equal(browser.root.dataset.themeMode, fixture.mode);
    assert.equal(browser.root.dataset.themeAccent, fixture.accent);
  }
});

test("initial host classes are respected when no valid snapshot is available", (t) => {
  for (const fixture of [
    { classes: ["dark"], expected: "dark" },
    { classes: ["light"], expected: "light" },
    { classes: ["light", "dark"], expected: "dark" },
    { classes: [], expected: "light" },
  ] as const) {
    const browser = themeBrowser({ classes: [...fixture.classes], snapshot: { themeMode: "invalid" }, osDark: true });
    startTheme(t, browser);
    assertTheme(browser.root, fixture.expected);
  }
});

test("explicit host mode supplies a missing resolution but unresolved system does not become OS dark", (t) => {
  const dark = themeBrowser({ snapshot: { themeMode: "dark", themeAccent: "classic" } });
  startTheme(t, dark);
  assertTheme(dark.root, "dark");
  const light = themeBrowser({ classes: ["dark"], snapshot: { themeMode: "light", themeAccent: "classic" } });
  startTheme(t, light);
  assertTheme(light.root, "light");
  const unresolved = themeBrowser({ snapshot: { themeMode: "system", themeAccent: "classic" }, osDark: true });
  startTheme(t, unresolved);
  assertTheme(unresolved.root, "light");
});

test("malformed snapshots are ignored rather than overriding a host class", (t) => {
  for (const snapshot of [
    null, "dark", 1, [],
    { themeMode: "auto", themeAccent: "classic", resolvedTheme: "light" },
    { themeMode: "light", themeAccent: "blue", resolvedTheme: "light" },
    { themeMode: "light", themeAccent: "classic", resolvedTheme: "system" },
    { themeMode: "light", themeAccent: "classic", resolvedTheme: null },
    { themeAccent: "classic", resolvedTheme: "light" },
    { themeMode: "light", resolvedTheme: "light" },
  ]) {
    const browser = themeBrowser({ snapshot, classes: ["dark"] });
    startTheme(t, browser);
    assertTheme(browser.root, "dark");
    assert.deepEqual(browser.root.dataset, { hostRole: "plugin" });
  }
});

test("applying a host theme preserves blue tokens, unrelated classes, styles, attributes and the host global", (t) => {
  const snapshot = { themeMode: "system", themeAccent: "violet", resolvedTheme: "dark" };
  const browser = themeBrowser({ snapshot, classes: ["light", "host-plugin", "accent-violet"] });
  startTheme(t, browser);
  assertTheme(browser.root, "dark");
  assert.equal(browser.root.classList.contains("host-plugin"), true);
  assert.equal(browser.root.classList.contains("accent-violet"), true);
  assert.equal(browser.root.dataset.hostRole, "plugin");
  assert.equal(browser.root.style.fontFamily, "Segoe UI");
  assert.equal(browser.root.style.getPropertyValue("--accent"), "#4a7dff");
  assert.equal(browser.root.style.getPropertyValue("--accent-deep"), "#2b5be0");
  assert.equal(browser.root.style.getPropertyValue("--accent-ink"), "#1d3a8f");
  assert.equal(browser.win.__OTOOLS_THEME__, snapshot);
  assert.deepEqual(snapshot, { themeMode: "system", themeAccent: "violet", resolvedTheme: "dark" });
});

test("class-only initialization does not replace existing host theme metadata", (t) => {
  const browser = themeBrowser({ classes: ["dark", "host-plugin"] });
  Object.assign(browser.root.dataset, { themeMode: "system", themeAccent: "emerald" });
  startTheme(t, browser);
  assertTheme(browser.root, "dark");
  assert.deepEqual(browser.root.dataset, { hostRole: "plugin", themeMode: "system", themeAccent: "emerald" });
});

test("native window events read detail directly and switch light to dark to light without changing the snapshot", (t) => {
  const snapshot = { themeMode: "light", themeAccent: "classic", resolvedTheme: "light" };
  const browser = themeBrowser({ snapshot });
  startTheme(t, browser);
  assertTheme(browser.root, "light");
  browser.hostEvent({ themeMode: "system", themeAccent: "amber", resolvedTheme: "dark" });
  assertTheme(browser.root, "dark");
  assert.equal(browser.root.dataset.themeMode, "system");
  assert.equal(browser.root.dataset.themeAccent, "amber");
  browser.hostEvent({ themeMode: "light", themeAccent: "emerald", resolvedTheme: "light" });
  assertTheme(browser.root, "light");
  assert.equal(browser.root.dataset.themeAccent, "emerald");
  assert.equal(browser.win.__OTOOLS_THEME__, snapshot);
  assert.deepEqual(snapshot, { themeMode: "light", themeAccent: "classic", resolvedTheme: "light" });
});

test("native theme updates subscribe only to window and do not accept payload wrappers or event aliases", (t) => {
  const browser = themeBrowser();
  startTheme(t, browser);
  browser.hostEvent({ themeMode: "dark", themeAccent: "pink", resolvedTheme: "dark" });
  assertTheme(browser.root, "dark");
  const light = { themeMode: "light", themeAccent: "classic", resolvedTheme: "light" };
  browser.hostEvent(light, browser.doc);
  browser.hostEvent({ payload: light });
  browser.win.dispatchEvent(new CustomEvent("ottools-theme-changed", { detail: light }));
  browser.win.dispatchEvent(new CustomEvent("otools:theme-sync", { detail: light }));
  assertTheme(browser.root, "dark");
  assert.equal(browser.root.dataset.themeAccent, "pink");
});

test("native events reject malformed enums and unresolved system while allowing explicit mode fallback", (t) => {
  const browser = themeBrowser({ osDark: true });
  startTheme(t, browser);
  browser.hostEvent({ themeMode: "dark", themeAccent: "classic" });
  assertTheme(browser.root, "dark");
  for (const detail of [
    null, "light", [],
    { themeMode: "auto", themeAccent: "classic", resolvedTheme: "light" },
    { themeMode: "light", themeAccent: "blue", resolvedTheme: "light" },
    { themeMode: "light", themeAccent: "classic", resolvedTheme: "system" },
    { themeMode: "light", themeAccent: "classic", resolvedTheme: null },
    { themeMode: "system", themeAccent: "classic" },
  ]) {
    browser.hostEvent(detail);
    assertTheme(browser.root, "dark");
  }
  browser.hostEvent({ themeMode: "light", themeAccent: "classic" });
  assertTheme(browser.root, "light");
});

test("iframe sync accepts the direct cross-origin parent and updates both directions", (t) => {
  const browser = themeBrowser({ embedded: true });
  startTheme(t, browser);
  browser.message({ type: "otools:theme-sync", themeMode: "system", themeAccent: "violet", resolvedTheme: "dark" });
  assertTheme(browser.root, "dark");
  assert.equal(browser.root.dataset.themeMode, "system");
  assert.equal(browser.root.dataset.themeAccent, "violet");
  browser.message({ type: "otools:theme-sync", themeMode: "light", themeAccent: "pink", resolvedTheme: "light" });
  assertTheme(browser.root, "light");
  assert.equal(browser.root.dataset.themeAccent, "pink");
});

test("iframe sync ignores sibling, self, popup and absent sources even if their origin looks trusted", (t) => {
  const browser = themeBrowser({ embedded: true });
  startTheme(t, browser);
  browser.message({ type: "otools:theme-sync", themeMode: "dark", themeAccent: "amber", resolvedTheme: "dark" });
  assertTheme(browser.root, "dark");
  const light = { type: "otools:theme-sync", themeMode: "light", themeAccent: "classic", resolvedTheme: "light" };
  for (const source of [browser.win, new EventTarget(), new EventTarget(), null]) {
    browser.message(light, source, "https://trusted-host.example");
    assertTheme(browser.root, "dark");
    assert.equal(browser.root.dataset.themeAccent, "amber");
  }
});

test("a top-level window does not treat itself as an iframe parent", (t) => {
  const browser = themeBrowser();
  startTheme(t, browser);
  browser.hostEvent({ themeMode: "dark", themeAccent: "classic", resolvedTheme: "dark" });
  assertTheme(browser.root, "dark");
  browser.message({ type: "otools:theme-sync", themeMode: "light", themeAccent: "classic", resolvedTheme: "light" });
  assertTheme(browser.root, "dark");
});

test("iframe sync requires its exact type and valid theme enums, not a nested payload", (t) => {
  const browser = themeBrowser({ embedded: true });
  startTheme(t, browser);
  browser.message({ type: "otools:theme-sync", themeMode: "dark", themeAccent: "emerald", resolvedTheme: "dark" });
  assertTheme(browser.root, "dark");
  for (const data of [
    null, "light", [], 1,
    { type: "other", themeMode: "light", themeAccent: "classic", resolvedTheme: "light" },
    { themeMode: "light", themeAccent: "classic", resolvedTheme: "light" },
    { type: "otools:theme-sync", themeMode: "auto", themeAccent: "classic", resolvedTheme: "light" },
    { type: "otools:theme-sync", themeMode: "light", themeAccent: "blue", resolvedTheme: "light" },
    { type: "otools:theme-sync", themeMode: "light", themeAccent: "classic", resolvedTheme: "system" },
    { type: "otools:theme-sync", themeMode: "light", themeAccent: "classic", resolvedTheme: null },
    { type: "otools:theme-sync", themeMode: "system", themeAccent: "classic" },
    { type: "otools:theme-sync", payload: { themeMode: "light", themeAccent: "classic", resolvedTheme: "light" } },
  ]) {
    browser.message(data);
    assertTheme(browser.root, "dark");
    assert.equal(browser.root.dataset.themeAccent, "emerald");
  }
  browser.message({ type: "otools:theme-sync", themeMode: "light", themeAccent: "classic" });
  assertTheme(browser.root, "light");
});

test("an early native snapshot is applied safely after documentElement becomes available", (t) => {
  const browser = themeBrowser({ delayedRoot: true, snapshot: { themeMode: "system", themeAccent: "violet", resolvedTheme: "dark" } });
  startTheme(t, browser);
  assert.equal(browser.doc.documentElement, null);
  browser.ready();
  assertTheme(browser.root, "dark");
  assert.equal(browser.root.dataset.themeMode, "system");
  assert.equal(browser.root.dataset.themeAccent, "violet");
});

test("DOM readiness reads late host classes or snapshot without adding an OS-dark fallback", (t) => {
  const classes = themeBrowser({ delayedRoot: true });
  startTheme(t, classes);
  classes.root.classList.add("dark", "host-plugin");
  classes.ready();
  assertTheme(classes.root, "dark");
  assert.equal(classes.root.classList.contains("host-plugin"), true);
  const snapshot = themeBrowser({ delayedRoot: true });
  startTheme(t, snapshot);
  snapshot.win.__OTOOLS_THEME__ = { themeMode: "system", themeAccent: "amber", resolvedTheme: "dark" };
  snapshot.ready();
  assertTheme(snapshot.root, "dark");
  const noHost = themeBrowser({ delayedRoot: true, osDark: true });
  startTheme(t, noHost);
  noHost.ready();
  assertTheme(noHost.root, "light");
});

test("events received before DOM readiness win over an older snapshot", (t) => {
  for (const signal of ["native", "iframe"] as const) {
    const browser = themeBrowser({ delayedRoot: true, embedded: true, snapshot: { themeMode: "dark", themeAccent: "classic", resolvedTheme: "dark" } });
    startTheme(t, browser);
    const light = { themeMode: "light", themeAccent: "emerald", resolvedTheme: "light" };
    if (signal === "native") browser.hostEvent(light);
    else browser.message({ type: "otools:theme-sync", ...light });
    browser.ready();
    assertTheme(browser.root, "light");
    assert.equal(browser.root.dataset.themeAccent, "emerald");
    browser.hostEvent({ themeMode: "dark", themeAccent: "pink", resolvedTheme: "dark" });
    assertTheme(browser.root, "dark");
    browser.doc.dispatchEvent(new Event("DOMContentLoaded"));
    assertTheme(browser.root, "dark");
    assert.equal(browser.root.dataset.themeAccent, "pink");
  }
});

test("cleanup removes native and iframe listeners so subsequent host signals cannot change the root", (t) => {
  const browser = themeBrowser({ embedded: true });
  const dispose = startTheme(t, browser);
  browser.hostEvent({ themeMode: "dark", themeAccent: "amber", resolvedTheme: "dark" });
  assertTheme(browser.root, "dark");
  dispose();
  dispose();
  browser.hostEvent({ themeMode: "light", themeAccent: "classic", resolvedTheme: "light" });
  browser.message({ type: "otools:theme-sync", themeMode: "light", themeAccent: "classic", resolvedTheme: "light" });
  assertTheme(browser.root, "dark");
  assert.equal(browser.root.dataset.themeAccent, "amber");
});

test("cleanup before root readiness also prevents a deferred snapshot write", (t) => {
  const browser = themeBrowser({ delayedRoot: true, snapshot: { themeMode: "dark", themeAccent: "classic", resolvedTheme: "dark" } });
  startTheme(t, browser)();
  browser.ready();
  assert.equal(browser.root.style.colorScheme, "");
  assert.equal(browser.root.classList.contains("dark"), false);
  assert.deepEqual(browser.root.dataset, { hostRole: "plugin" });
});

type CssDeclaration = { type: "decl"; prop: string; value: string };
type CssRule = { selector: string; nodes: Array<CssDeclaration | { type: string }> };
const require = createRequire(import.meta.url);
// Reuse Vite's installed parser rather than adding a DOM or stylesheet dependency.
const postcss = createRequire(require.resolve("vite"))("postcss") as {
  parse(css: string): { walkRules(visitor: (rule: CssRule) => void): void };
};
const stylesheet = postcss.parse(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));

/** Evaluate only this stylesheet's simple theme selectors; browser rendering stays with the coordinator. */
function stylesheetDeclarations(classes: readonly string[], elementClass?: string, hover = false) {
  const declarations: Record<string, string> = {};
  const matches = (selector: string) => {
    const [rootSelector, childSelector, ...rest] = selector.split(/\s+/);
    if (rest.length) return false;
    const rootMatches = rootSelector === ":root" || rootSelector === "html"
      || (rootSelector === "html.light" && classes.includes("light"))
      || (rootSelector === "html.dark" && classes.includes("dark"))
      || (rootSelector === "html:not(.dark)" && !classes.includes("dark"));
    if (elementClass === undefined) return childSelector === undefined && rootMatches;
    const child = childSelector ?? rootSelector;
    if (childSelector && !rootMatches) return false;
    return child === `.${elementClass}` || (hover && child === `.${elementClass}:hover`);
  };
  stylesheet.walkRules((rule) => {
    if (!rule.selector.split(",").some((selector) => matches(selector.trim()))) return;
    for (const node of rule.nodes) if (node.type === "decl") {
      const declaration = node as CssDeclaration;
      declarations[declaration.prop] = declaration.value;
    }
  });
  return declarations;
}

test("the production stylesheet defaults to bright tokens without classes and applies dark only explicitly", () => {
  const light = stylesheetDeclarations([]);
  assert.equal(light["color-scheme"], "light");
  assert.equal(light["--bg"], "#eef2f9");
  assert.equal(light["--panel"], "#ffffff");
  assert.equal(light["--text"], "#1d2735");
  assert.equal(light["--input-bg"], "#fbfcfe");
  assert.deepEqual(stylesheetDeclarations(["light"]), light);
  const dark = stylesheetDeclarations(["dark"]);
  assert.equal(dark["color-scheme"], "dark");
  assert.equal(dark["--bg"], "#10141d");
  assert.equal(dark["--panel"], "#171c28");
  assert.equal(dark["--text"], "#e6ebf5");
  assert.equal(dark["--input-bg"], "#121826");
  assert.deepEqual(stylesheetDeclarations(["light", "dark"]), dark);
});

test("implicit bright mode retains light status and link contrast without changing blue brand tokens", () => {
  for (const fixture of [
    { className: "service-error", light: "#a3362d", dark: "#e0857c" },
    { className: "banner-error", light: "#a3362d", dark: "#e0857c" },
    { className: "banner-warn", light: "#a3691d", dark: "#e5b76a" },
    { className: "banner-ok", light: "#1d7a4f", dark: "#58c893" },
    { className: "chip-pending", light: "#a3691d", dark: "#e5b76a" },
    { className: "chip-transferring", light: "#2b5be0", dark: "#6fa2ff" },
    { className: "chip-done", light: "#1d7a4f", dark: "#58c893" },
    { className: "chip-failed", light: "#a3362d", dark: "#e0857c" },
    { className: "link-chip", light: "var(--accent-ink)", dark: "var(--accent)" },
  ]) {
    assert.equal(stylesheetDeclarations([], fixture.className).color, fixture.light, fixture.className);
    assert.equal(stylesheetDeclarations(["light"], fixture.className).color, fixture.light, fixture.className);
    assert.equal(stylesheetDeclarations(["dark"], fixture.className).color, fixture.dark, fixture.className);
  }
  for (const classes of [[], ["light"], ["dark"]]) {
    const theme = stylesheetDeclarations(classes);
    assert.equal(theme["--accent"], "#4a7dff");
    assert.equal(theme["--accent-deep"], "#2b5be0");
    assert.equal(theme["--accent-ink"], "#1d3a8f");
    assert.equal(stylesheetDeclarations(classes, "net-ok").background, "#2bb673");
    assert.equal(stylesheetDeclarations(classes, "net-off").background, "#d4544a");
    assert.equal(stylesheetDeclarations(classes, "net-wait").background, "#e0a23c");
  }
  assert.equal(stylesheetDeclarations([], "link-chip", true).background, "color-mix(in srgb, var(--accent) 18%, transparent)");
  assert.equal(stylesheetDeclarations(["dark"], "link-chip", true).background, "color-mix(in srgb, var(--accent) 20%, transparent)");
});
