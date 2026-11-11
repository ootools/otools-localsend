/**
 * 「打开文件」接口：宿主把 OS 双击的文件投递给插件。
 *
 * 宿主侧链路（见宿主 platform/file_open.rs）：文件路径先排进按 pluginUuid 分桶的
 * 投递队列，再对插件 webview `emit_to("otools-open-file")` 敲门。事件只做敲门，
 * 真正载荷一律通过 `otools_consume_open_files` 取走——这样无论插件 listener 与
 * 宿主投递谁先谁后，文件都不会丢：
 *
 *   - 宿主先投递、插件后启动：启动时 listen 注册完成后立即 consume 一次即可取走；
 *   - 插件先启动、宿主后投递：敲门命中已注册的 listener，再 consume 取走。
 *
 * 另有 URL 参数兜底（新开标签时宿主会把 `?otoolsOpenFile=[...]` 拼进插件 URL），
 * 与队列内容按「3 秒窗口内同路径去重」合并，避免同一路径双份回调。
 */

import { invoke, listen, type UnlistenFn } from "./runtime";

/** 宿主投递敲门事件名（与宿主 platform/file_open.rs 的 FILE_DELIVER_EVENT 对齐）。 */
export const OTOOLS_FILE_DELIVER_EVENT = "otools-open-file";

export interface OtoolsOpenFileEntry {
  path: string;
  name: string;
  ext: string;
}

const DEDUPE_WINDOW_MS = 3000;

/** 解析宿主拼进插件 URL 的 `otoolsOpenFile` 参数（JSON 数组）。 */
export function parseLaunchOpenFiles(search: string): string[] {
  if (!search) {
    return [];
  }
  try {
    const params = new URLSearchParams(search);
    const raw = params.get("otoolsOpenFile");
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function toOpenFileEntries(paths: readonly string[]): OtoolsOpenFileEntry[] {
  return paths.map((path) => {
    const normalized = String(path || "").trim();
    const segments = normalized.split(/[\\/]/);
    const name = segments[segments.length - 1] || normalized;
    const dotIndex = name.lastIndexOf(".");
    const ext = dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
    return { path: normalized, name, ext };
  });
}

/** 插件身份：与 runtime 的 readPluginUuidFromContext 同源（env 注入优先，URL 参数兜底）。 */
function readCallerPluginUuid(): string {
  if (typeof window !== "undefined") {
    try {
      const env = (window as { __OToolsEnv?: { pluginUuid?: unknown } }).__OToolsEnv;
      const fromEnv = typeof env?.pluginUuid === "string" ? env.pluginUuid.trim() : "";
      if (fromEnv) {
        return fromEnv;
      }
      const params = new URLSearchParams(window.location?.search || "");
      const fromParams = (
        params.get("plugin") ||
        params.get("pluginUuid") ||
        params.get("plugin_uuid") ||
        ""
      ).trim();
      if (fromParams) {
        return fromParams;
      }
    } catch {
      // 非浏览器环境或受限 window，交给调用方自行处理。
    }
  }
  return "";
}

/**
 * 订阅宿主投递的文件。返回 unlisten。
 *
 * @param handler 收到文件（按 path 去重窗口合并后）触发；批量投递一次回调给全量。
 */
export async function onOtoolsOpenFile(
  handler: (files: OtoolsOpenFileEntry[]) => void,
): Promise<UnlistenFn> {
  const recentPaths = new Map<string, number>();

  const deliver = (paths: readonly string[]) => {
    const now = Date.now();
    const fresh: string[] = [];
    for (const path of paths) {
      const normalized = String(path || "").trim();
      if (!normalized) {
        continue;
      }
      const seenAt = recentPaths.get(normalized);
      if (typeof seenAt === "number" && now - seenAt < DEDUPE_WINDOW_MS) {
        continue;
      }
      recentPaths.set(normalized, now);
      fresh.push(normalized);
    }
    if (recentPaths.size > 256) {
      for (const [path, seenAt] of recentPaths) {
        if (now - seenAt >= DEDUPE_WINDOW_MS) {
          recentPaths.delete(path);
        }
      }
    }
    if (fresh.length) {
      handler(toOpenFileEntries(fresh));
    }
  };

  const consume = async () => {
    const pluginUuid = readCallerPluginUuid();
    if (!pluginUuid) {
      return;
    }
    let paths: string[] = [];
    try {
      const result = await invoke<string[]>("otools_consume_open_files", { pluginUuid });
      paths = Array.isArray(result) ? result.map(String) : [];
    } catch {
      // 宿主未就绪（老版本宿主 / 浏览器直开）：静默，等下一次敲门。
      return;
    }
    deliver(paths);
  };

  // 先注册 listener 再启动 consume：保证「consume 取空后宿主才投递」的窗口内
  // 敲门一定能命中 listener，不漏件。
  const unlisten = await listen<string>(OTOOLS_FILE_DELIVER_EVENT, () => {
    void consume();
  });

  const launchPaths = parseLaunchOpenFiles(
    typeof window !== "undefined" ? window.location?.search || "" : "",
  );
  if (launchPaths.length) {
    // URL 参数先记账：随后的 consume 即便也取到同一路径也会被去重窗口滤掉。
    deliver(launchPaths);
  }
  void consume();

  return unlisten;
}
