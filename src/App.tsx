/**
 * 应用壳：汇澜式侧栏布局（品牌 + 导航 + 服务状态徽标）+ 主区（标题栏 +
 * 滚动视图）+ 传入请求弹窗队列。服务状态由 server-status 事件驱动
 * （Review Focus #1 —— 失败必须显式报错，绝不静默）。
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

const TABS: Array<{ id: TabId; label: string; icon: string; title: string; subtitle: string }> = [
  { id: "devices", label: "设备", icon: "📡", title: "附近设备", subtitle: "同一局域网内运行 LocalSend 的设备" },
  { id: "transfers", label: "传输", icon: "🔁", title: "传输记录", subtitle: "收发历史与实时进度" },
  { id: "settings", label: "设置", icon: "⚙️", title: "设置", subtitle: "本机身份、接收偏好与服务状态" },
];

/**
 * 服务状态徽标（侧栏底部）。五态显式：读取中 / 宿主未注入 / 服务异常 /
 * 运行中（实际端口）/ 启动中——任何失败态都不静默。
 */
function ServerStatusBadge({
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
  let dot = "net-wait";
  let main = "正在获取服务状态…";
  let sub: string | null = null;
  if (!ready) {
    // 保持默认 wait 态文案
  } else if (hostError) {
    dot = "net-off";
    main = "宿主桥未注入";
    sub = "请在 OTools 宿主中打开本插件";
  } else if (error) {
    dot = "net-off";
    main = "服务异常";
    sub = `${error} — 检查端口占用或防火墙放行 UDP/TCP 53317`;
  } else if (port > 0) {
    dot = "net-ok";
    main = `服务运行中 · 端口 ${port}`;
  } else {
    main = "服务启动中…（等待宿主 autostart）";
  }
  return (
    <div className="net-badge" title={error ?? hostError ?? undefined}>
      <span className={`net-dot ${dot}`} aria-hidden />
      <span className="net-lines">
        <span className="net-main">{main}</span>
        {sub && <span className="net-sub">{sub}</span>}
      </span>
    </div>
  );
}

export function App() {
  const store = usePollEvents();
  const [tab, setTab] = useState<TabId>("devices");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const activeRequest = store.incoming[0] ?? null;
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0];

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

  const serverBanner = store.ready && !store.hostError && store.server?.error ? (
    <div className="banner banner-error" role="alert">
      <span aria-hidden>⛔</span>
      <span>
        服务异常：{store.server.error} — 请检查端口是否被占用，或在防火墙放行 UDP/TCP 53317
      </span>
    </div>
  ) : null;

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" aria-hidden />
      <div className="ambient ambient-b" aria-hidden />

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" aria-hidden>📡</span>
          <span className="brand-text">
            <strong>LocalSend</strong>
            <span>OT 互传</span>
          </span>
        </div>

        <nav className="nav" aria-label="页面导航">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={tab === entry.id ? "nav-item nav-on" : "nav-item"}
            >
              <span className="nav-icon" aria-hidden>{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ServerStatusBadge
            ready={store.ready}
            hostError={store.hostError}
            error={store.server?.error ?? null}
            port={store.server?.port ?? 0}
          />
          <div className="side-version">协议 v2 兼容 · GPL-3.0</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{current.title}</h1>
            <p>{current.subtitle}</p>
          </div>
        </header>
        <div className="view">
          {serverBanner}
          {tab === "devices" && (
            <DevicesPage store={store} onGoToTransfers={() => setTab("transfers")} />
          )}
          {tab === "transfers" && <TransfersPage store={store} />}
          {tab === "settings" && <SettingsPage store={store} />}
        </div>
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
