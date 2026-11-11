import type { Plugin } from "vite";
import { createOtoolsAliasMap } from "./aliases";

export { createOtoolsAliasMap } from "./aliases";

export function otoolsTauriShimPlugin(): Plugin {
  return {
    name: "otools-tauri-shim",
    config() {
      return {
        resolve: {
          alias: createOtoolsAliasMap(),
        },
      };
    },
  };
}
