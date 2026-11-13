import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import React from "react";

/** A small hook lifecycle driver; production hooks and their native boundary stay real. */
export function mountHook<T>(hook: () => T, commit?: (value: T) => void) {
  type Cell = { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void };
  const cells: Cell[] = [];
  let index = 0;
  let dirty = true;
  let value!: T;
  const effects: Array<() => void> = [];
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } };
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => (
    !!a && !!b && a.length === b.length && a.every((item, position) => Object.is(item, b[position]))
  );
  const dispatcher = {
    useState(initial: unknown) {
      const position = index++;
      if (!cells[position]) cells[position] = { value: typeof initial === "function" ? initial() : initial };
      const set = (next: unknown) => {
        const previous = cells[position].value;
        const result = typeof next === "function" ? next(previous) : next;
        if (!Object.is(previous, result)) { cells[position].value = result; dirty = true; }
      };
      return [cells[position].value, set];
    },
    useRef(initial: unknown) {
      const position = index++;
      if (!cells[position]) cells[position] = { value: { current: initial } };
      return cells[position].value;
    },
    useCallback(callback: unknown, dependencies: readonly unknown[]) {
      const position = index++;
      if (!cells[position] || !same(cells[position].dependencies, dependencies)) {
        cells[position] = { value: callback, dependencies };
      }
      return cells[position].value;
    },
    useMemo(factory: () => unknown, dependencies: readonly unknown[]) {
      const position = index++;
      if (!cells[position] || !same(cells[position].dependencies, dependencies)) {
        cells[position] = { value: factory(), dependencies };
      }
      return cells[position].value;
    },
    useEffect(effect: () => (() => void) | void, dependencies?: readonly unknown[]) {
      const position = index++;
      if (cells[position] && same(cells[position].dependencies, dependencies)) return;
      const previous = cells[position];
      cells[position] = { dependencies };
      effects.push(() => {
        previous?.cleanup?.();
        cells[position].cleanup = effect() || undefined;
      });
    },
  };
  const render = () => {
    index = 0;
    dirty = false;
    const previous = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    try { value = hook(); } finally { internals.ReactCurrentDispatcher.current = previous; }
    commit?.(value);
    for (const effect of effects.splice(0)) effect();
  };
  render();
  return {
    current: () => { if (dirty) render(); return value; },
    rerender: () => { render(); return value; },
    flush: async () => {
      for (let turn = 0; turn < 8; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (dirty) render();
      }
      return value;
    },
    unmount: () => { for (const cell of cells) cell?.cleanup?.(); },
  };
}

/** Node tests exercise actual TSX components without adding a DOM/test dependency. */
export function registerFrontendTestModules(testModules: Record<string, string> = {}) {
  const mapped = new Map(Object.entries(testModules).map(([specifier, source]) => [specifier, `data:text/javascript,${encodeURIComponent(source)}`]));
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (mapped.has(specifier)) return { url: mapped.get(specifier)!, shortCircuit: true };
      if (specifier.startsWith("otools-plugin-sdk/")) {
        return {
          url: new URL(`../../vendor/otools-plugin-sdk/src/${specifier.slice("otools-plugin-sdk/".length)}.ts`, import.meta.url).href,
          shortCircuit: true,
        };
      }
      if (specifier.startsWith(".") && context.parentURL) {
        const url = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(url))) {
          for (const extension of [".ts", ".tsx"]) {
            const resolved = new URL(`${url.href}${extension}`);
            if (existsSync(fileURLToPath(resolved))) return { url: resolved.href, shortCircuit: true };
          }
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.endsWith(".tsx") || (url.includes("/vendor/otools-plugin-sdk/") && url.endsWith(".ts"))) {
        return {
          format: "module", shortCircuit: true,
          source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
            fileName: fileURLToPath(url),
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
          }).outputText,
        };
      }
      return nextLoad(url, context);
    },
  });
}
