import { isPreviewMode } from "../api";
import { serviceControlView } from "../hooks/serviceState";
import type { PluginStore } from "../hooks/usePollEvents";

/** 无局部 busy 或确认：侧栏与设置卡只消费同一父级控制器。 */
export function ServiceControls({ store, compact = false }: { store: PluginStore; compact?: boolean }) {
  const view = serviceControlView(store);
  const error = store.serviceError ?? store.server?.error ?? null;
  const preview = isPreviewMode();
  const operate = () => {
    if (view.disabled) return;
    if (view.action === "start") void store.startService();
    if (view.action === "stop") void store.stopService();
  };
  return (
    <div className={`service-controls${compact ? " service-compact" : ""}`}>
      {preview && <span className="preview-label">预览模拟</span>}
      <div className="net-badge" role="status" title={error ?? store.hostError ?? undefined}>
        <span className={`net-dot ${view.dot}`} aria-hidden />
        <span className="net-lines">
          <span className="net-main">{view.statusLabel}</span>
          {store.hostError && <span className="net-sub">请在 OTools 宿主中打开本插件</span>}
        </span>
      </div>
      <button
        type="button"
        onClick={operate}
        disabled={view.disabled}
        aria-busy={store.serviceBusy}
        className={`btn btn-sm service-action ${view.action === "stop" ? "btn-danger" : "btn-primary"}`}
      >
        {view.label}
      </button>
      {error && <p className="service-error" role="alert">{error}</p>}
    </div>
  );
}

/** 只由 App 渲染一次；覆盖收件确认时不丢失原来的 Pending 队列。 */
export function StopServiceDialog({
  activeTransfers, busy, error, preview = false, onCancel, onConfirm,
}: {
  activeTransfers: number;
  busy: boolean;
  error: string | null;
  preview?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-back service-confirm-back" role="dialog" aria-modal="true" aria-label="停止服务确认">
      <div className="modal service-confirm">
        <h3>停止 LocalSend 服务？</h3>
        {preview && <p className="preview-label">预览模拟 · 不控制真实原生服务</p>}
        <p className="modal-sub service-confirm-copy">
          停止服务将取消 {activeTransfers} 个未完成传输（包括待确认的收件和正在收发的任务）。
          已完成文件和传输历史将保留，之后可以重新启动服务。
        </p>
        {error && <div className="banner banner-error modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-sm" autoFocus>取消</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="btn btn-sm btn-danger">
            {busy ? "停止中…" : "确认停止"}
          </button>
        </div>
      </div>
    </div>
  );
}
