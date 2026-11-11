import react from "@vitejs/plugin-react";
import UnoCSS from "unocss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { otoolsTauriShimPlugin } from "./vendor/otools-plugin-sdk/src/vite";

export default defineConfig({
  base: "./",
  define: { __OTOOLS_PLUGIN_UUID__: JSON.stringify("otools-localsend") },
  // The official plugin aliases to SDK package subpaths. Resolve those to the
  // pinned source copy so this build does not require a prebuilt SDK package.
  plugins: [
    otoolsTauriShimPlugin(),
    {
      name: "otools-vendored-source",
      enforce: "pre",
      resolveId(id) {
        if (id.startsWith("otools-plugin-sdk/")) {
          return fileURLToPath(new URL(`./vendor/otools-plugin-sdk/src/${id.slice("otools-plugin-sdk/".length)}.ts`, import.meta.url));
        }
      },
    },
    UnoCSS(),
    react(),
  ],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 6497, strictPort: true },
  build: { target: "es2020", outDir: "dist" },
});
