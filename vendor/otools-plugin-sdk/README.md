# otools-plugin-sdk

用于把基于 Tauri 的前端代码迁移到 OTools 插件环境的兼容 SDK。

## 提供的能力

- 一个 Vite 插件，用来重写 `@tauri-apps/api/core` 和 `@tauri-apps/api/event`
- 适配 OTools 插件环境的 `invoke`、`listen` 等运行时 shim
- `window.otools`、`window.utools` 的共享 TypeScript 全局类型
- `isOtoolsPluginRuntime`、`openExternal`、`openPath` 等轻量辅助方法
- `pickFile`、`pickDirectory`、`saveFile` 等跨 runtime 的对话框辅助封装

## 安装

```bash
pnpm add otools-plugin-sdk
```

配套依赖：

```bash
pnpm add @tauri-apps/api
pnpm add @tauri-apps/plugin-dialog
```

## 用法

先配置 Vite：

```ts
import { defineConfig } from "vite";
import { otoolsTauriShimPlugin } from "otools-plugin-sdk/vite";

export default defineConfig({
  plugins: [otoolsTauriShimPlugin()],
});
```

业务代码继续使用官方 Tauri 入口：

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
```

只有在确实需要运行时分支时，再使用 SDK 暴露的辅助方法：

```ts
import {
  isOtoolsPluginRuntime,
  openExternal,
  openPath,
} from "otools-plugin-sdk";
```

文件对话框优先走 SDK 辅助层：

```ts
import { pickDirectory, pickFile, pickZipFile, saveFile } from "otools-plugin-sdk";
```

如果业务代码直接访问 `window.otools`，补上类型引用：

```ts
/// <reference types="otools-plugin-sdk" />
```

### 宿主桥透明性

当 OTools 宿主注入了符合约定的 `window.otools` 后，SDK 不需要知道当前底层到底是原生 Tauri IPC，还是 remote service WebSocket transport。

这层差异由宿主桥统一吸收，插件代码仍然可以继续围绕 `@tauri-apps/api/*` 和 `window.otools` 编写，不需要为 remote service 额外分叉。

## 发布

```bash
pnpm build
npm publish
```

## 示例

参考 [examples/minimal-vite](./examples/minimal-vite)，这是一个最小化的 Vite 示例，保留官方 Tauri import，同时通过 SDK 插件运行在 OTools 插件环境里。
