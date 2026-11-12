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

const STATUS_STYLES: Record<string, string> = {
  Pending: "border-amber-800 bg-amber-950/60 text-amber-300",
  Transferring: "border-sky-800 bg-sky-950/60 text-sky-300",
  Done: "border-emerald-800 bg-emerald-950/60 text-emerald-300",
  Cancelled: "border-zinc-700 bg-zinc-900 text-zinc-400",
  Failed: "border-red-900 bg-red-950/60 text-red-300",
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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center gap-2">
        <span
          aria-label={record.direction === "Send" ? "发送" : "接收"}
          className={
            record.direction === "Send"
              ? "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-sky-950 text-xs text-sky-300"
              : "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-emerald-950 text-xs text-emerald-300"
          }
        >
          {record.direction === "Send" ? "↑" : "↓"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
          {record.peerAlias || "未知设备"}
        </span>
        <span className="shrink-0 text-xs text-zinc-500">{formatTimestamp(record.createdAt)}</span>
        <span
          className={
            "shrink-0 rounded border px-1.5 py-0.5 text-xs " +
            (STATUS_STYLES[record.status] ?? STATUS_STYLES.Cancelled)
          }
        >
          {transferStatusLabel(record.status)}
        </span>
      </div>

      <p className="mt-1 text-xs text-zinc-500">
        {record.files.length} 个文件 · {formatBytes(totalSize)}
      </p>

      <ul className="mt-2 space-y-2">
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
    <li className="min-w-0">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-zinc-300" title={file.fileName}>
          {file.fileName || file.id}
        </span>
        <span className="shrink-0 text-zinc-500">{formatBytes(file.size ?? 0)}</span>
      </div>
      {typeof percent === "number" && (
        <div
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-sky-500 transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {destination && (
        <p className="mt-0.5 truncate text-[11px] text-zinc-600" title={destination}>
          {destination}
        </p>
      )}
    </li>
  );
}
