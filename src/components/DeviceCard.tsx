/**
 * 设备卡片：别名 / 型号 / 类型图标 / IP:端口 / 最近可见时间。
 * key 由父级按 fingerprint 提供；点击整卡选中用于发送。
 */

import { deviceTypeEmoji, deviceTypeLabel, formatRelativeTime } from "../format";
import type { DeviceEntry } from "../api";

interface DeviceCardProps {
  entry: DeviceEntry;
  selected: boolean;
  onSelect: () => void;
}

export function DeviceCard({ entry, selected, onSelect }: DeviceCardProps) {
  const { info, ip, lastSeenMs } = entry;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        selected
          ? "w-full rounded-lg border border-sky-500 bg-zinc-900 p-3 text-left transition-colors"
          : "w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-left transition-colors hover:border-zinc-700"
      }
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-lg">
          {deviceTypeEmoji(info.deviceType)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
          {info.alias || "未知设备"}
        </span>
        <span className="shrink-0 text-xs text-zinc-500">
          {deviceTypeLabel(info.deviceType)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-zinc-500">
        <span className="truncate">
          {ip}
          {info.port ? `:${info.port}` : ""}
          {info.deviceModel ? ` · ${info.deviceModel}` : ""}
        </span>
        <span className="shrink-0" title="最近可见">
          {formatRelativeTime(lastSeenMs)}
        </span>
      </div>
    </button>
  );
}
