/**
 * 应用壳：顶部服务状态条（server-status 事件驱动，Review Focus #1 ——
 * 失败必须显式报错，绝不静默）+ 设备/传输/设置三页 + 传入请求弹窗队列。
 */

import { useState } from "react";
import { acceptSession, declineSession } from "./api";
import { IncomingDialog } from "./components/IncomingDialog";
import { usePollEvents } from "./hooks/usePollEvents";
import { DevicesPage } from "./pages/Devices";
import { SettingsPage } from "./pages/Settings";
import { TransfersPage } from "./pages/Transfers";
import { formatError } from "./format";

type TabId = "devices" | "transfers" | "settings";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "devices", label: "设备" },
  { id: "transfers", label: "传输" },
  { id: "settings", label: "设置" },
];

function ServerStatusBar({
  ready,
  hostError,
  error,
  port,
}: {
  ready: boolean;
  hostError: string | null;
  error: string | null;
  port: number;
}) {
  if (!ready) {
    return (
      <span className="inline-flex items-center gap-2 text-zinc-500">
        <span className="inline-block h-2 w-2 rounded-full bg-zinc-600" />
        正在获取服务状态…
      </span>
    );
  }
  // 宿主桥未注入（浏览器直跑）：显式降级态，绝不静默。
  if (hostError) {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-red-400" title={hostError}>
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />
        <span className="truncate">宿主桥未注入 — 请在 OTools 宿主中打开本插件</span>
      </span>
    );
  }
  if (error) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-2 text-red-400"
        title={error}
      >
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />
        <span className="truncate">
          服务异常：{error} — 请检查端口是否被占用，或在防火墙放行 UDP/TCP 53317
        </span>
      </span>
    );
  }
  if (port > 0) {
    return (
      <span className="inline-flex items-center gap-2 text-emerald-400">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
        服务运行中 · 端口 {port}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-amber-400">
      <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
      服务启动中…（等待宿主 autostart）
    </span>
  );
}

export function App() {
  const store = usePollEvents();
  const [tab, setTab] = useState<TabId>("devices");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const activeRequest = store.incoming[0] ?? null;

  const respondAndClose = async (respond: () => Promise<void>) => {
    if (dialogBusy || !activeRequest) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await respond();
    } catch (cause) {
      setDialogError(formatError(cause));
      return; // 失败留在弹窗内展示错误
    } finally {
      setDialogBusy(false);
    }
    store.dismissIncoming(activeRequest.sessionId);
    await store.refreshTransfers();
  };

  const acceptAll = () => {
    if (!activeRequest) return;
    const sessionId = activeRequest.sessionId;
    void respondAndClose(() => acceptSession(sessionId, "all"));
  };

  const acceptSelected = (fileIds: string[]) => {
    if (!activeRequest) return;
    const sessionId = activeRequest.sessionId;
    void respondAndClose(() => acceptSession(sessionId, fileIds));
  };

  const decline = () => {
    if (!activeRequest) return;
    const sessionId = activeRequest.sessionId;
    // 拒绝只负责 decline 并关闭；会话可能已被 native 过期清理，报错无意义。
    void respondAndClose(async () => {
      try {
        await declineSession(sessionId);
      } catch {
        // 会话已不存在 —— 仍然关闭。
      }
    });
  };

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2 text-sm">
        <ServerStatusBar
          ready={store.ready}
          hostError={store.hostError}
          error={store.server?.error ?? null}
          port={store.server?.port ?? 0}
        />
      </header>

      <nav className="flex gap-1 border-b border-zinc-800 bg-zinc-900 px-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={
              tab === entry.id
                ? "border-b-2 border-sky-500 px-3 py-2 text-sm font-medium text-zinc-100"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300"
            }
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-4">
        {tab === "devices" && (
          <DevicesPage store={store} onGoToTransfers={() => setTab("transfers")} />
        )}
        {tab === "transfers" && <TransfersPage store={store} />}
        {tab === "settings" && <SettingsPage store={store} />}
      </main>

      {activeRequest && (
        <IncomingDialog
          key={activeRequest.sessionId}
          request={activeRequest}
          busy={dialogBusy}
          error={dialogError}
          onAcceptAll={acceptAll}
          onAcceptSelected={acceptSelected}
          onDecline={decline}
        />
      )}
    </div>
  );
}
