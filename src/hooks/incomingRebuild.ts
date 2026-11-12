import type { IncomingRequestEvent, TransferRecord } from "../api";

/**
 * Pending Receive 记录 → 弹窗数据源。native 的 TransferRecord 只持久化了
 * peerAlias（sender 的 DeviceInfo 仅存在于内存会话里），重建时用别名拼最小
 * sender 桩：弹窗显示发送方别名，型号/类型退化为通用图标 —— 不为此扩 native。
 */
export function recordToIncomingRequest(record: TransferRecord): IncomingRequestEvent {
  return {
    sessionId: record.sessionId,
    sender: {
      alias: record.peerAlias || "未知设备",
      version: "",
      deviceModel: null,
      deviceType: null,
      fingerprint: "",
      port: 0,
      protocol: "https",
      download: false,
    },
    files: record.files ?? [],
  };
}

/**
 * 面板重开后待确认的接收会话必须重新弹窗。只认「接收方向 + Pending」，
 * 已终结或发送方向的记录不进入队列；同 sessionId 只保留一条。
 */
export function pendingIncomingFromTransfers(records: TransferRecord[]): IncomingRequestEvent[] {
  const seen = new Set<string>();
  const queue: IncomingRequestEvent[] = [];
  for (const record of records) {
    if (record.direction !== "Receive" || record.status !== "Pending") continue;
    if (seen.has(record.sessionId)) continue;
    seen.add(record.sessionId);
    queue.push(recordToIncomingRequest(record));
  }
  return queue;
}
