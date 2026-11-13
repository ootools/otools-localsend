/**
 * 应用壳：汇澜式侧栏布局（品牌 + 导航 + 服务状态徽标）+ 主区（标题栏 +
 * 滚动视图）+ 传入请求弹窗队列。服务快照、手动控制与单个停服确认均由
 * usePollEvents 提供共享状态；查询与挂载绝不自动启动服务。
 */

import { useState } from "react";
import { acceptSession, declineSession, isPreviewMode } from "./api";
import { IncomingDialog } from "./components/IncomingDialog";
import { ServiceControls, StopServiceDialog } from "./components/ServiceControls";
import { usePollEvents } from "./hooks/usePollEvents";
import { DevicesPage } from "./pages/Devices";
import { DownloadPage } from "./pages/Download";
import { SettingsPage } from "./pages/Settings";
import { TransfersPage } from "./pages/Transfers";
import { formatError } from "./format";

type TabId = "devices" | "transfers" | "download" | "settings";

const TABS: Array<{ id: TabId; label: string; icon: string; title: string; subtitle: string }> = [
  { id: "devices", label: "设备", icon: "📡", title: "附近设备", subtitle: "同一局域网内运行 LocalSend 的设备" },
  { id: "transfers", label: "传输", icon: "🔁", title: "传输记录", subtitle: "收发历史与实时进度" },
  { id: "download", label: "下载", icon: "📥", title: "下载客户端", subtitle: "为手机等其它设备获取官方 LocalSend 客户端" },
  { id: "settings", label: "设置", icon: "⚙️", title: "设置", subtitle: "本机身份、接收偏好与服务状态" },
];

export function App() {
  const store = usePollEvents();
  const [tab, setTab] = useState<TabId>("devices");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const activeRequest = store.incoming[0] ?? null;
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  const respondAndClose = async (respond: () => Promise<void>) => {
    if (dialogBusy || store.serviceBusy || store.stopConfirmation || store.server?.state !== "running" || !activeRequest) return;
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
          <ServiceControls store={store} compact />
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
          {isPreviewMode() && (
            <div className="banner banner-warn" role="status">预览模拟 · 启停与传输仅在页面内仿真，不控制真实原生服务。</div>
          )}
          {serverBanner}
          {tab === "devices" && (
            <DevicesPage store={store} onGoToTransfers={() => setTab("transfers")} />
          )}
          {tab === "transfers" && <TransfersPage store={store} />}
          {tab === "download" && <DownloadPage />}
          {tab === "settings" && <SettingsPage store={store} />}
        </div>
      </main>

      {activeRequest && (
        <IncomingDialog
          key={activeRequest.sessionId}
          request={activeRequest}
          busy={dialogBusy || store.serviceBusy || store.server?.state !== "running"}
          error={dialogError ?? store.serviceError}
          onAcceptAll={acceptAll}
          onAcceptSelected={acceptSelected}
          onDecline={decline}
          onStopService={() => void store.stopService()}
          serviceBusy={store.serviceBusy || store.server?.state !== "running"}
          hidden={store.stopConfirmation !== null}
        />
      )}
      {store.stopConfirmation && (
        <StopServiceDialog
          activeTransfers={store.stopConfirmation.activeTransfers}
          busy={store.serviceBusy}
          error={store.serviceError}
          preview={isPreviewMode()}
          onCancel={store.cancelStopService}
          onConfirm={() => void store.confirmStopService()}
        />
      )}
    </div>
  );
}
