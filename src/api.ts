/**
 * OTools 宿主桥 — 后续所有页面（Task 11+）唯一的 native 访问入口。
 *
 * 导入路径 `@tauri-apps/api/core` / `@tauri-apps/api/event` 在 vite 构建期由
 * otoolsTauriShimPlugin 重写到 vendor/otools-plugin-sdk 的 shim；类型检查则用
 * devDependencies 里的 @tauri-apps/api 声明（ai-switch 同款模式）。
 *
 * 浏览器直跑（pnpm dev / preview，无宿主注入）时 SDK invoke 会抛
 * "Tauri runtime is unavailable" —— 调用方必须捕获并降级为「宿主未注入」占位。
 *
 * 线上形状镜像 native/src/models.rs（serde rename_all = camelCase）：
 *   - DeviceInfo / FileEntry / Metadata / TransferRecord（camelCase 字段）
 *   - Direction / TransferStatus 枚举序列化为 PascalCase："Send"/"Receive"、
 *     "Pending"/"Transferring"/"Done"/"Cancelled"/"Failed"
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// 类型（镜像 native JSON）
// ---------------------------------------------------------------------------

/** v2 协议文件时间戳（ISO 8601 字符串，可空）。 */
export interface Metadata {
  modified: string | null;
  accessed: string | null;
}

/** LocalSend v2 文件条目。 */
export interface FileEntry {
  id: string;
  fileName: string;
  size: number;
  fileType: string;
  sha256: string | null;
  preview: string | null;
  metadata: Metadata | null;
}

/** v2 设备公告/注册 DTO（announce 帧 + register 请求体）。 */
export interface DeviceInfo {
  alias: string;
  version: string;
  deviceModel: string | null;
  deviceType: string | null;
  fingerprint: string;
  port: number;
  protocol: string;
  download: boolean;
}

/** 发现注册表条目（lastSeenMs = 最近一次公告帧的 unix 毫秒）。 */
export interface DeviceEntry {
  info: DeviceInfo;
  ip: string;
  lastSeenMs: number;
}

export type TransferDirection = "Send" | "Receive";

export type TransferStatus =
  | "Pending"
  | "Transferring"
  | "Done"
  | "Cancelled"
  | "Failed";

/** 传输历史（transfers.json）；createdAt 为 unix 毫秒。 */
export interface TransferRecord {
  sessionId: string;
  direction: TransferDirection;
  peerAlias: string;
  files: FileEntry[];
  status: TransferStatus;
  createdAt: number;
  /** 已收文件的最终落盘绝对路径，按 fileId 索引；发送方向的记录为空。 */
  destinations: Record<string, string>;
}

/** 本机设置（settings.json）。 */
export interface Settings {
  alias: string;
  deviceModel: string | null;
  deviceType: string;
  port: number;
  downloadDir: string | null;
  pin: string | null;
  autoSave: boolean;
  notifyOnIncoming: boolean;
}

/** `server_status` invoke 返回（未启动时 port=0）。 */
export interface ServerStatus {
  port: number;
  protocol: string;
  fingerprint: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// 事件名常量与负载
// ---------------------------------------------------------------------------

export const EVENTS = {
  deviceFound: "device-found",
  deviceLost: "device-lost",
  incomingRequest: "incoming-request",
  transferProgress: "transfer-progress",
  transferDone: "transfer-done",
  serverStatus: "server-status",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** device-lost 负载（按 fingerprint 移除设备）。 */
export interface DeviceLostEvent {
  fingerprint: string;
}

/** incoming-request 负载（Pending 会话确认弹窗数据源）。 */
export interface IncomingRequestEvent {
  sessionId: string;
  sender: DeviceInfo;
  files: FileEntry[];
}

/** transfer-progress 负载（native 侧已按 250ms / ≥1% 节流聚合）。 */
export interface TransferProgressEvent {
  sessionId: string;
  fileId: string;
  percent: number;
}

/**
 * transfer-done 负载。
 *
 * 注意：事件线上的 status 是小写 "done" | "cancelled" | "failed"，而
 * transfer_list 里 TransferRecord.status 是 PascalCase（"Done" 等，与 native
 * 枚举序列化一致）。Task 11 里两者不要混用。
 */
export interface TransferDoneEvent {
  sessionId: string;
  status: "done" | "cancelled" | "failed";
}

/**
 * server-status 负载，两种互斥形状：
 *  - 绑定成功：{ port, protocol, fingerprint }
 *  - 绑定失败（端口被占/防火墙/TLS）：{ error }
 */
export interface ServerStatusEvent {
  port?: number;
  protocol?: string;
  fingerprint?: string;
  error?: string;
}

/** poll_events 返回的排队事件（native→前端事件队列逐条 drain）。 */
export interface QueuedEvent {
  event: string;
  data: unknown;
}

export type UnlistenFn = () => void | Promise<void>;

/** 订阅 native→前端事件；返回解绑函数。 */
export async function onEvent<T>(
  event: EventName,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (message) => {
    handler(message.payload);
  });
  return () => {
    void unlisten();
  };
}

// ---------------------------------------------------------------------------
// invoke 封装
// ---------------------------------------------------------------------------

/**
 * 宿主桥 invoke：桌面宿主会把 native 的 {ok, data | error} 信封解包后才交给
 * JS，但远程宿主可能原样转发 —— 这里对信封做防御性解包（ai-switch 同款）。
 */
async function callNative<T>(
  method: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const result = await invoke<T>(method, payload ?? {});
  if (result && typeof result === "object" && "ok" in result) {
    const envelope = result as { ok: boolean; data?: T; error?: unknown };
    if (envelope.ok === true && "data" in envelope) {
      return envelope.data as T;
    }
    if (envelope.ok === false && "error" in envelope) {
      const error = envelope.error;
      throw new Error(
        typeof error === "string" ? error : JSON.stringify(error),
      );
    }
  }
  return result;
}

export async function getSettings(): Promise<Settings> {
  return callNative<Settings>("settings_get");
}

/** 保存设置并返回落盘后的完整设置（native 会同步刷新 announce 载荷）。 */
export async function setSettings(settings: Settings): Promise<Settings> {
  return callNative<Settings>("settings_set", { settings });
}

/** 已发现设备表 + 实际监听的 UDP 端口（未启动时 devices=[]、udpPort=0）。 */
export async function listDevices(): Promise<{
  devices: DeviceEntry[];
  udpPort: number;
}> {
  return callNative<{ devices: DeviceEntry[]; udpPort: number }>("device_list");
}

/** 立即向组播发一轮 announce（未启动时为 no-op，仍返回 ok）。 */
export async function discoverNow(): Promise<void> {
  await callNative<{ ok: boolean }>("discover_now");
}

/**
 * 发送文件（native 立即返回 sessionId，任务后台跑）。
 * 线上：{ ip, port, files: [{path}], pin? }。
 */
export async function sendFiles(
  ip: string,
  port: number,
  paths: string[],
  pin?: string,
): Promise<{ sessionId: string }> {
  const payload: Record<string, unknown> = {
    ip,
    port,
    files: paths.map((path) => ({ path })),
  };
  if (pin) {
    payload.pin = pin;
  }
  return callNative<{ sessionId: string }>("send_files", payload);
}

/** 发送文本（native 转成虚拟 message.txt 条目走同一发送管线）。 */
export async function sendText(
  ip: string,
  port: number,
  text: string,
  pin?: string,
): Promise<{ sessionId: string }> {
  const payload: Record<string, unknown> = { ip, port, text };
  if (pin) {
    payload.pin = pin;
  }
  return callNative<{ sessionId: string }>("send_text", payload);
}

/**
 * 接收会话接受。fileIds 传 "all"（或不传）表示全部接受；传数组表示只接受
 * 勾选文件（native 会跳过未知 id）。
 */
export async function acceptSession(
  sessionId: string,
  fileIds: string[] | "all" = "all",
): Promise<void> {
  const payload: Record<string, unknown> = { sessionId };
  if (fileIds !== "all") {
    payload.fileIds = fileIds;
  }
  await callNative<{ accepted: string[] }>("session_accept", payload);
}

export async function declineSession(sessionId: string): Promise<void> {
  await callNative<Record<string, never>>("session_decline", { sessionId });
}

/** 取消会话（发送方向：中断上传并通知对端；接收方向：丢弃临时目录）。 */
export async function cancelSession(sessionId: string): Promise<void> {
  await callNative<Record<string, never>>("session_cancel", { sessionId });
}

/** 完整传输历史（面板重开用它重建，而不是等事件回放）。 */
export async function listTransfers(): Promise<TransferRecord[]> {
  const { transfers } = await callNative<{ transfers: TransferRecord[] }>(
    "transfer_list",
  );
  return transfers;
}

export async function serverStatus(): Promise<ServerStatus> {
  return callNative<ServerStatus>("server_status");
}

/** 取走事件队列里所有待处理事件（队列有界，满丢最旧）。 */
export async function pollEvents(): Promise<QueuedEvent[]> {
  const { events } = await callNative<{ events: QueuedEvent[] }>("poll_events");
  return events;
}
