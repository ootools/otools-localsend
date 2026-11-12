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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="传输请求"
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        <p className="text-sm font-medium text-zinc-100">
          {sender?.alias || "未知设备"} 请求传输
        </p>
        <p className="mt-0.5 text-xs text-zinc-500">
          {deviceTypeEmoji(sender?.deviceType)}
          {sender?.deviceModel ? ` ${sender.deviceModel} · ` : ""}
          {textMode ? "文本消息" : `${request.files.length} 个文件`}
        </p>

        {textMode && textEntry ? (
          <div className="mt-3 rounded-lg rounded-tl-sm border border-zinc-700 bg-zinc-800 p-3">
            <p className="select-text whitespace-pre-wrap break-words text-sm text-zinc-100">
              {textEntry.preview}
            </p>
          </div>
        ) : (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-zinc-500">
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
                className="text-sky-400 hover:text-sky-300"
                disabled={busy}
              >
                {allSelected ? "全不选" : "全选"}
              </button>
            </div>
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {request.files.map((file) => (
                <li key={file.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                    <input
                      type="checkbox"
                      checked={selected.has(file.id)}
                      onChange={() => toggle(file.id)}
                      disabled={busy}
                      className="h-3.5 w-3.5 accent-sky-600"
                    />
                    <span className="min-w-0 flex-1 truncate" title={file.fileName}>
                      {file.fileName || file.id}
                    </span>
                    <span className="shrink-0 text-zinc-500">{formatBytes(file.size ?? 0)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDecline}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
          >
            拒绝
          </button>
          {!textMode && (
            <button
              type="button"
              onClick={() => onAcceptSelected(selectedIds)}
              disabled={busy || selectedIds.length === 0}
              className="rounded-md border border-sky-700 px-3 py-1.5 text-xs font-medium text-sky-300 hover:border-sky-500 disabled:opacity-50"
            >
              接受所选{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}
            </button>
          )}
          <button
            type="button"
            onClick={onAcceptAll}
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "处理中…" : "全部接受"}
          </button>
        </div>
      </div>
    </div>
  );
}
