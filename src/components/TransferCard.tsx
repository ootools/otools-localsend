/**
 * 传输记录卡片：方向（收/发）+ 对端别名 + 状态芯片 + 逐文件进度条；
 * 接收完成记录展示落盘路径（destinations 线上可能缺席，归一化 ?? {}）。
 */

import { useEffect, useRef, useState } from "react";
import { cancelSession, type FileEntry, type TransferRecord } from "../api";
import { copyImageContent, copyTextContent, isImageFile, openTransferFolder, textContent } from "../fileContent";
import { FileImagePreview } from "./FileImagePreview";
import { formatBytes, formatError, formatTimestamp, transferStatusLabel } from "../format";

interface TransferCardProps {
  record: TransferRecord;
  /** sessionId → fileId → percent；仅传输中的会话有意义。 */
  progress?: Record<string, number>;
  onRefresh?: () => void | Promise<void>;
}

const STATUS_CHIPS: Record<string, string> = {
  Pending: "chip chip-pending",
  Transferring: "chip chip-transferring",
  Done: "chip chip-done",
  Cancelled: "chip chip-cancelled",
  Failed: "chip chip-failed",
};

function filePercent(record: TransferRecord, percent?: number): number {
  if (typeof percent === "number") return Math.min(100, Math.max(0, percent));
  if (record.status === "Done") return 100;
  return 0;
}

export function TransferCard({ record, progress, onRefresh }: TransferCardProps) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancellable = record.status === "Pending" || record.status === "Transferring";
  const cancel = async () => {
    if (!cancellable || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelSession(record.sessionId);
      await onRefresh?.();
    } catch (cause) {
      setCancelError(formatError(cause));
    } finally {
      setCancelling(false);
    }
  };
  const phase = record.status === "Pending"
    ? (record.stage === "preparing" ? "正在准备文件…" : record.direction === "Send" ? "等待对方确认" : "等待接收确认")
    : record.status === "Transferring" ? "正在传输文件…" : null;
  const showProgress = record.status === "Transferring";
  const totalSize = record.files.reduce((sum, file) => sum + (file.size ?? 0), 0);

  return (
    <div className="card">
      <div className="xfer-head">
        <span
          aria-label={record.direction === "Send" ? "发送" : "接收"}
          className={`tile ${record.direction === "Send" ? "tile-out" : "tile-in"}`}
          aria-hidden
        >
          {record.direction === "Send" ? "↑" : "↓"}
        </span>
        <span className="xfer-peer">
          <b>{record.peerAlias || "未知设备"}</b>
        </span>
        <span className="xfer-time">{formatTimestamp(record.createdAt)}</span>
        <span className={STATUS_CHIPS[record.status] ?? STATUS_CHIPS.Cancelled}>
          {transferStatusLabel(record.status)}
        </span>
      </div>

      <p className="xfer-meta">
        {record.files.length} 个文件 · {formatBytes(totalSize)}
      </p>
      {phase && <p className="xfer-meta" role="status">{phase}</p>}
      {(record.error || cancelError) && (
        <div className="banner banner-error" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
          {cancelError ?? record.error}
        </div>
      )}
      {cancellable && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm btn-danger" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? "取消中…" : "取消传输"}
          </button>
        </div>
      )}

      <ul className="xfer-files">
        {record.files.map((file) => (
          <FileRow
            key={`${record.sessionId}:${file.id}`}
            file={file}
            record={record}
            percent={showProgress ? filePercent(record, progress?.[file.id]) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({
  file,
  record,
  percent,
}: {
  file: FileEntry;
  record: TransferRecord;
  /** 有值 = 渲染进度条；undefined = 非传输态。 */
  percent?: number;
}) {
  const body = textContent(file);
  const image = body === null && isImageFile(file);
  const paths = record.direction === "Send" ? record.sources : record.destinations;
  const resourcePath = paths?.[file.id];
  const available = typeof resourcePath === "string" && resourcePath.trim() !== "";
  // Maps are only an availability hint. Native resolves and validates the exact historical file.
  const query = available ? { sessionId: record.sessionId, fileId: file.id } : null;
  const version = JSON.stringify([resourcePath ?? "", file.size, file.metadata?.modified ?? null, file.metadata?.accessed ?? null]);
  const identity = JSON.stringify([record.sessionId, file.id, version, body]);
  const [actionBusy, setActionBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ identity: string; error?: string; success?: string } | null>(null);
  const lifecycle = useRef({ alive: true, identity });
  lifecycle.current.identity = identity;
  const actionRef = useRef<object | null>(null);
  useEffect(() => {
    lifecycle.current.alive = true;
    return () => { lifecycle.current.alive = false; actionRef.current = null; };
  }, []);

  const runAction = async () => {
    if (!lifecycle.current.alive || actionRef.current || (body === null && !query)) return;
    const operation = {};
    actionRef.current = operation;
    setActionBusy(true);
    setFeedback(null);
    try {
      if (body !== null) await copyTextContent(body);
      else if (image && query) await copyImageContent(query);
      else await openTransferFolder(record.sessionId, file.id);
      if (lifecycle.current.alive && lifecycle.current.identity === identity && actionRef.current === operation) {
        setFeedback({ identity, success: body !== null ? "已复制文本" : image ? "已复制图片" : "已打开所在文件夹" });
      }
    } catch (cause) {
      if (lifecycle.current.alive && lifecycle.current.identity === identity && actionRef.current === operation) {
        setFeedback({ identity, error: formatError(cause) });
      }
    } finally {
      if (lifecycle.current.alive && actionRef.current === operation) {
        actionRef.current = null;
        setActionBusy(false);
      }
    }
  };
  const currentFeedback = feedback?.identity === identity ? feedback : null;

  return (
    <li className="xfer-file">
      <div className="xfer-file-row">
        <span className="name" title={file.fileName}>{file.fileName || file.id}</span>
        <span className="size">{formatBytes(file.size ?? 0)}</span>
      </div>
      {typeof percent === "number" && (
        <div className="progress" role="progressbar" aria-label={`${file.fileName || file.id} 的传输进度`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {body !== null ? <div className="msg-bubble">{body}</div> : image ? (
        <FileImagePreview file={file} query={query} version={version} pending={record.direction === "Receive" && record.status === "Pending"} />
      ) : null}
      {available && <p className="xfer-dest" title={resourcePath}>{resourcePath}</p>}
      <div className="content-actions">
        <button type="button" className="btn btn-sm" disabled={actionBusy || (body === null && !available)} onClick={() => void runAction()}>
          {actionBusy ? (body !== null || image ? "复制中…" : "打开中…") : body !== null ? "复制文本" : image ? "复制图片" : "打开所在文件夹"}
        </button>
      </div>
      {body === null && !available && <p className="content-note">本机文件不可用：没有已保存的文件路径，旧记录无法定位。</p>}
      {currentFeedback?.error && <p className="content-error" role="alert">{currentFeedback.error}</p>}
      {currentFeedback?.success && <p className="content-success" role="status">{currentFeedback.success}</p>}
    </li>
  );
}
