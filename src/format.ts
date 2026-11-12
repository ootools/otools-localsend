/** 展示辅助：字节数、相对时间、设备类型图标、传输状态文案。 */

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** 相对时间（terse）：刚刚 / n 秒前 / n 分钟前 / n 小时前 / n 天前。 */
export function formatRelativeTime(unixMs: number, now = Date.now()): string {
  if (!Number.isFinite(unixMs) || unixMs <= 0) return "—";
  const seconds = Math.max(0, Math.floor((now - unixMs) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** HH:mm（当天）或 MM-DD HH:mm。 */
export function formatTimestamp(unixMs: number): string {
  if (!Number.isFinite(unixMs) || unixMs <= 0) return "—";
  const date = new Date(unixMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = new Date().toDateString() === date.toDateString();
  if (sameDay) return clock;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

export type DeviceTypeIcon = "mobile" | "desktop" | "other";

export function deviceTypeOf(type: string | null | undefined): DeviceTypeIcon {
  const value = (type ?? "").toLowerCase();
  if (value === "mobile") return "mobile";
  if (value === "desktop" || value === "headless" || value === "server") {
    return "desktop";
  }
  return "other";
}

const DEVICE_TYPE_EMOJI: Record<DeviceTypeIcon, string> = {
  mobile: "📱",
  desktop: "💻",
  other: "🖧",
};

export function deviceTypeEmoji(type: string | null | undefined): string {
  return DEVICE_TYPE_EMOJI[deviceTypeOf(type)];
}

const DEVICE_TYPE_LABEL: Record<DeviceTypeIcon, string> = {
  mobile: "手机",
  desktop: "电脑",
  other: "设备",
};

export function deviceTypeLabel(type: string | null | undefined): string {
  return DEVICE_TYPE_LABEL[deviceTypeOf(type)];
}

/** TransferRecord.status（PascalCase）→ 中文状态文案。 */
export function transferStatusLabel(status: string): string {
  switch (status) {
    case "Pending":
      return "待确认";
    case "Transferring":
      return "传输中";
    case "Done":
      return "已完成";
    case "Cancelled":
      return "已取消";
    case "Failed":
      return "已失败";
    default:
      return status;
  }
}

/** transfer-done 事件的小写 status → 记录的 PascalCase。 */
export function normalizeTransferStatus(status: string): string {
  switch (status) {
    case "done":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}
