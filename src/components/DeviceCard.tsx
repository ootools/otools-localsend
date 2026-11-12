/**
 * 设备卡片：类型图标方块 / 别名 / 型号 / IP:端口 / 最近可见时间。
 * key 由父级按 fingerprint 提供；点击整卡选中用于发送（选中态描边）。
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
      className={selected ? "dev-card dev-on" : "dev-card"}
    >
      <span className="dev-row">
        <span className="tile" aria-hidden>{deviceTypeEmoji(info.deviceType)}</span>
        <span className="dev-name">
          <b>{info.alias || "未知设备"}</b>
          <small>
            {deviceTypeLabel(info.deviceType)}
            {info.deviceModel ? ` · ${info.deviceModel}` : ""}
          </small>
        </span>
        <span className="dev-seen" title="最近可见">{formatRelativeTime(lastSeenMs)}</span>
      </span>
      <span className="dev-row" style={{ marginTop: 6 }}>
        <span className="dev-name">
          <small style={{ fontFamily: "var(--mono)" }}>
            {ip}
            {info.port ? `:${info.port}` : ""}
          </small>
        </span>
      </span>
    </button>
  );
}
