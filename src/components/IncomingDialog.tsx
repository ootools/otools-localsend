/**
 * 传入请求确认弹窗（串行队列，同一时刻只渲染一个）。
 *
 * 两种形态：
 *  - 单条 text/plain 且带 preview = 官方文本消息 → 消息气泡 + 固定全选；
 *    「全部接受」→ acceptSession(id, "all")，native 对发送方回 204。
 *  - 普通文件 → 清单（大小 + 勾选，全选/全不选）→ 全部接受 / 接受所选 / 拒绝。
 * 「拒绝」只负责调 decline 并关闭（native 已按取消处理，无需额外反馈）。
 */

import { useState } from "react";
import { deviceTypeEmoji, formatBytes } from "../format";
import type { IncomingRequestEvent } from "../api";

interface IncomingDialogProps {
  request: IncomingRequestEvent;
  busy: boolean;
  error: string | null;
  onAcceptAll: () => void;
  onAcceptSelected: (fileIds: string[]) => void;
  onDecline: () => void;
}

function isTextMessage(request: IncomingRequestEvent): boolean {
  return (
    request.files.length === 1 &&
    request.files[0].fileType === "text/plain" &&
    typeof request.files[0].preview === "string" &&
    request.files[0].preview !== ""
  );
}

export function IncomingDialog({
  request,
  busy,
  error,
  onAcceptAll,
  onAcceptSelected,
  onDecline,
}: IncomingDialogProps) {
  const textMode = isTextMessage(request);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(request.files.map((file) => file.id)),
  );

  const toggle = (fileId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  };

  const selectedIds = request.files
    .filter((file) => selected.has(file.id))
    .map((file) => file.id);
  const allSelected = selectedIds.length === request.files.length;

  const sender = request.sender;
  const textEntry = textMode ? request.files[0] : null;

  return (
    <div
      className="modal-back"
      role="dialog"
      aria-modal="true"
      aria-label="传输请求"
    >
      <div className="modal">
        <h3>{sender?.alias || "未知设备"} 请求传输</h3>
        <p className="modal-sub">
          {deviceTypeEmoji(sender?.deviceType)}
          {sender?.deviceModel ? ` ${sender.deviceModel} · ` : ""}
          {textMode ? "文本消息" : `${request.files.length} 个文件`}
        </p>

        {textMode && textEntry ? (
          <div className="modal-body">
            <div className="msg-bubble">{textEntry.preview}</div>
          </div>
        ) : (
          <div className="modal-body">
            <div className="file-pick-head">
              <span>选择要接收的文件</span>
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    allSelected
                      ? new Set<string>()
                      : new Set(request.files.map((file) => file.id)),
                  )
                }
                disabled={busy}
              >
                {allSelected ? "全不选" : "全选"}
              </button>
            </div>
            <ul className="file-list">
              {request.files.map((file) => (
                <li key={file.id}>
                  <label className="file-row">
                    <input
                      type="checkbox"
                      checked={selected.has(file.id)}
                      onChange={() => toggle(file.id)}
                      disabled={busy}
                      style={{ width: 14, height: 14, flex: "none" }}
                    />
                    <span className="name" title={file.fileName}>
                      {file.fileName || file.id}
                    </span>
                    <span className="size">{formatBytes(file.size ?? 0)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="banner banner-error modal-error" role="alert">
            <span aria-hidden>⚠️</span>
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onDecline} disabled={busy} className="btn btn-sm btn-danger">
            拒绝
          </button>
          {!textMode && (
            <button
              type="button"
              onClick={() => onAcceptSelected(selectedIds)}
              disabled={busy || selectedIds.length === 0}
              className="btn btn-sm"
            >
              接受所选{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}
            </button>
          )}
          <button
            type="button"
            onClick={onAcceptAll}
            disabled={busy}
            className="btn btn-primary btn-sm"
          >
            {busy ? "处理中…" : "全部接受"}
          </button>
        </div>
      </div>
    </div>
  );
}
