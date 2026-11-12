/**
 * 传输记录卡片：方向（收/发）+ 对端别名 + 状态芯片 + 逐文件进度条；
 * 接收完成记录展示落盘路径（destinations 线上可能缺席，归一化 ?? {}）。
 */

import { formatBytes, formatTimestamp, transferStatusLabel } from "../format";
import type { FileEntry, TransferRecord } from "../api";

interface TransferCardProps {
  record: TransferRecord;
  /** sessionId → fileId → percent；仅传输中的会话有意义。 */
  progress?: Record<string, number>;
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

export function TransferCard({ record, progress }: TransferCardProps) {
  const destinations = record.destinations ?? {};
  const showProgress = record.status === "Transferring";
  const showDestinations = record.direction === "Receive" && record.status === "Done";
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

      <ul className="xfer-files">
        {record.files.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            percent={showProgress ? filePercent(record, progress?.[file.id]) : undefined}
            destination={showDestinations ? destinations[file.id] : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({
  file,
  percent,
  destination,
}: {
  file: FileEntry;
  /** 有值 = 渲染进度条；undefined = 非传输态。 */
  percent?: number;
  destination?: string;
}) {
  return (
    <li className="xfer-file">
      <div className="xfer-file-row">
        <span className="name" title={file.fileName}>
          {file.fileName || file.id}
        </span>
        <span className="size">{formatBytes(file.size ?? 0)}</span>
      </div>
      {typeof percent === "number" && (
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {destination && (
        <p className="xfer-dest" title={destination}>
          {destination}
        </p>
      )}
    </li>
  );
}
