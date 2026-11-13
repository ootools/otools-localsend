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

/**
 * 发现注册表条目。线上 lastSeenMs 为"距今经过毫秒"（elapsed，
 * discovery.rs:128 `last_seen.elapsed()`；device-found 事件恒为 0），
 * 存储层（usePollEvents）在摄取点归一化为 unix 毫秒后再排序/展示。
 */
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
  /**
   * 已收文件的最终落盘绝对路径，按 fileId 索引；发送方向的记录为空。
   * 线上注意：native 在 destinations 为空时整个字段缺席（Task 10 审查交接），
   * 因此声明为可选，消费端一律 `record.destinations ?? {}` 归一化。
   */
  destinations?: Record<string, string>;
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

/** 服务生命周期（与 native 的状态及事件使用同一小写枚举）。 */
export type ServiceState = "stopped" | "starting" | "running" | "stopping" | "failed";

/** 完整服务快照；revision 在同一插件进程的普通重启之间不会归零。 */
export interface ServerStatus {
  state: ServiceState;
  port: number;
  udpPort: number;
  protocol: "https";
  fingerprint: string | null;
  error: string | null;
  activeTransfers: number;
  revision: number;
}

export interface StartServiceResult {
  started: true;
  status: ServerStatus;
}

export interface StopServiceResult {
  confirmationRequired: boolean;
  activeTransfers: number;
  status: ServerStatus;
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

/** server-status 事件始终与 server_status 查询返回同一完整快照。 */
export type ServerStatusEvent = ServerStatus;

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
  if (PREVIEW_MODE) {
    const listener = (payload: unknown) => handler(payload as T);
    const listeners = previewListeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener);
    previewListeners.set(event, listeners);
    return () => { listeners.delete(listener); };
  }
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
 * 预览模式（?preview=1）：无宿主时返回仿真数据，用于纯浏览器里的 UI 迭代
 * （设备卡/传输卡/弹窗在降级态下不可见）。宿主内该参数不存在，零影响。
 */
const PREVIEW_MODE =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("preview");

/** 供 UI 层在预览模式下仿真宿主交互（如文件选择）。 */
export function isPreviewMode(): boolean {
  return PREVIEW_MODE;
}

const previewFingerprint = "a".repeat(64);
const previewDevice = (
  alias: string,
  model: string,
  type: string,
  ip: string,
  seen: number,
): DeviceEntry => ({
  info: {
    alias,
    version: "2.2",
    deviceModel: model,
    deviceType: type,
    fingerprint: `${alias}-${ip}`,
    port: 53317,
    protocol: "https",
    download: false,
  },
  ip,
  lastSeenMs: seen,
});

const previewIncoming: IncomingRequestEvent = {
  sessionId: "preview-incoming",
  sender: {
    alias: "小米 14",
    version: "2.2",
    deviceModel: "Xiaomi 14",
    deviceType: "mobile",
    fingerprint: "preview-sender",
    port: 53317,
    protocol: "https",
    download: false,
  },
  files: [
    { id: "p1", fileName: "旅游照片合集.zip", size: 1_284_337_664, fileType: "application/zip", sha256: null, preview: null, metadata: null },
    { id: "p2", fileName: "会议纪要.docx", size: 38_912, fileType: "application/msword", sha256: null, preview: null, metadata: null },
    { id: "p3", fileName: "设计稿-终版.pdf", size: 9_420_288, fileType: "application/pdf", sha256: null, preview: null, metadata: null },
  ],
};

/** 可变预览存储只存在于当前页面；绝不打开真实网络服务或写宿主设置。 */
const previewListeners = new Map<string, Set<(payload: unknown) => void>>();
let previewSettings: Settings = {
  alias: "My-PC", deviceModel: "Windows 11 Pro", deviceType: "desktop",
  port: 53317, downloadDir: "D:\\Downloads", pin: null,
  autoSave: false, notifyOnIncoming: true,
};
const previewKnownDevices = [
  previewDevice("iPhone 15 Pro", "iOS 18", "mobile", "192.168.31.20", 3_000),
  previewDevice("MacBook Pro", "macOS 15", "desktop", "192.168.31.33", 41_000),
  previewDevice("客厅 N100", "Debian", "headless", "192.168.31.7", 5_400_000),
];
let previewDevices = [...previewKnownDevices];
let previewTransfers: TransferRecord[] = [
  {
    sessionId: previewIncoming.sessionId, direction: "Receive", peerAlias: previewIncoming.sender.alias,
    status: "Pending", createdAt: Date.now(), files: previewIncoming.files,
  },
  {
    sessionId: "t1", direction: "Receive", peerAlias: "iPhone 15 Pro",
    status: "Transferring", createdAt: Date.now() - 30_000,
    files: [
      { id: "f1", fileName: " vacation.zip", size: 1_284_337_664, fileType: "application/zip", sha256: null, preview: null, metadata: null },
      { id: "f2", fileName: "IMG_0042.HEIC", size: 4_800_512, fileType: "image/heic", sha256: null, preview: null, metadata: null },
    ],
  },
  {
    sessionId: "t2", direction: "Send", peerAlias: "MacBook Pro",
    status: "Done", createdAt: Date.now() - 3_600_000,
    files: [
      { id: "f3", fileName: "季度报表.xlsx", size: 238_912, fileType: "application/vnd.ms-excel", sha256: null, preview: null, metadata: null },
    ],
  },
  {
    sessionId: "t3", direction: "Receive", peerAlias: "小米 14",
    status: "Done", createdAt: Date.now() - 86_400_000,
    files: [
      { id: "f4", fileName: "message.txt", size: 24, fileType: "text/plain", sha256: null, preview: "晚上一起吃饭？", metadata: null },
    ],
    destinations: { f4: "D:\\Downloads\\message.txt" },
  },
];
let previewServer: ServerStatus = {
  state: "running", port: 53318, udpPort: 53318, protocol: "https",
  fingerprint: previewFingerprint, error: null, activeTransfers: 2, revision: 1,
};
let previewEvents: QueuedEvent[] = [{ event: EVENTS.incomingRequest, data: previewIncoming }];
let previewSequence = 0;

function previewActiveCount(): number {
  return previewTransfers.filter((record) => record.status === "Pending" || record.status === "Transferring").length;
}

function previewStatusSnapshot(): ServerStatus {
  return { ...previewServer, activeTransfers: previewActiveCount() };
}

function emitPreview(event: string, data: unknown): void {
  previewEvents.push({ event, data });
  for (const handler of previewListeners.get(event) ?? []) {
    try { handler(data); } catch { /* 一条仿真事件不阻止其余订阅者。 */ }
  }
}

function changePreviewStatus(patch: Partial<ServerStatus>): ServerStatus {
  previewServer = { ...previewServer, ...patch, revision: previewServer.revision + 1 };
  const status = previewStatusSnapshot();
  emitPreview(EVENTS.serverStatus, status);
  return status;
}

function cancelPreviewSession(sessionId: string): void {
  const record = previewTransfers.find((item) => item.sessionId === sessionId);
  if (!record || (record.status !== "Pending" && record.status !== "Transferring")) return;
  record.status = "Cancelled";
  previewEvents = previewEvents.filter((queued) => (
    queued.event !== EVENTS.incomingRequest && queued.event !== EVENTS.transferProgress
  ) || (queued.data as { sessionId?: string }).sessionId !== sessionId);
  emitPreview(EVENTS.transferDone, { sessionId, status: "cancelled" });
}

function requirePreviewRunning(): void {
  if (previewServer.state !== "running") throw new Error("预览模拟：服务未运行");
}

function previewInvoke(method: string, payload: Record<string, unknown> = {}): unknown {
  switch (method) {
    case "settings_get": return { ...previewSettings };
    case "settings_set": {
      previewSettings = { ...(payload.settings as Settings) };
      return { ...previewSettings };
    }
    case "server_status": return previewStatusSnapshot();
    case "device_list": return { devices: structuredClone(previewDevices), udpPort: previewServer.udpPort };
    case "transfer_list": return { transfers: structuredClone(previewTransfers) };
    case "poll_events": {
      const events = previewEvents;
      previewEvents = [];
      return { events };
    }
    case "start_localsend": {
      if (previewServer.state === "stopping") throw new Error("预览模拟：服务停止中 (stopping)");
      if (previewServer.state === "running" || previewServer.state === "starting") {
        return { started: true, status: previewStatusSnapshot() };
      }
      const savedPort = previewSettings.port;
      const status = changePreviewStatus({ state: "starting", port: 0, udpPort: 0, error: null });
      setTimeout(() => {
        if (previewServer.state !== "starting" || previewServer.revision !== status.revision) return;
        previewDevices = [...previewKnownDevices];
        changePreviewStatus({ state: "running", port: savedPort, udpPort: savedPort, error: null });
        for (const device of previewDevices) emitPreview(EVENTS.deviceFound, structuredClone(device));
      }, 300);
      return { started: true, status };
    }
    case "stop_localsend": {
      const activeTransfers = previewActiveCount();
      if (previewServer.state === "stopped" || previewServer.state === "stopping") {
        return { confirmationRequired: false, activeTransfers, status: previewStatusSnapshot() };
      }
      if (activeTransfers > 0 && payload.force !== true) {
        return { confirmationRequired: true, activeTransfers, status: previewStatusSnapshot() };
      }
      const status = changePreviewStatus({ state: "stopping" });
      setTimeout(() => {
        if (previewServer.state !== "stopping" || previewServer.revision !== status.revision) return;
        for (const record of previewTransfers) cancelPreviewSession(record.sessionId);
        previewDevices = [];
        changePreviewStatus({ state: "stopped", port: 0, udpPort: 0, error: null });
      }, 300);
      return { confirmationRequired: false, activeTransfers, status };
    }
    case "discover_now": {
      if (previewServer.state === "running") {
        for (const device of previewDevices) emitPreview(EVENTS.deviceFound, structuredClone(device));
      }
      return { ok: true };
    }
    case "session_accept": {
      requirePreviewRunning();
      const sessionId = String(payload.sessionId);
      const record = previewTransfers.find((item) => item.sessionId === sessionId && item.status === "Pending");
      if (!record) throw new Error("预览模拟：会话已不存在");
      record.status = "Transferring";
      return { accepted: record.files.map((file) => file.id) };
    }
    case "session_decline":
    case "session_cancel": {
      cancelPreviewSession(String(payload.sessionId));
      return {};
    }
    case "send_files":
    case "send_text": {
      requirePreviewRunning();
      const sessionId = `preview-send-${++previewSequence}`;
      const files: FileEntry[] = method === "send_text" ? [{
        id: "text", fileName: "message.txt", size: new TextEncoder().encode(String(payload.text)).length,
        fileType: "text/plain", sha256: null, preview: String(payload.text), metadata: null,
      }] : (payload.files as Array<{ path: string }>).map(({ path }, index) => ({
        id: `file-${index}`, fileName: path.split(/[\\/]/).pop() || path, size: 238_912,
        fileType: "application/octet-stream", sha256: null, preview: null, metadata: null,
      }));
      previewTransfers = [{
        sessionId, direction: "Send", peerAlias: previewDevices.find((device) => device.ip === payload.ip)?.info.alias ?? "预览设备",
        files, status: "Transferring", createdAt: Date.now(),
      }, ...previewTransfers];
      return { sessionId };
    }
    default: throw new Error(`预览模式未仿真该 method: ${method}`);
  }
}

/**
 * 宿主桥 invoke：桌面宿主会把 native 的 {ok, data | error} 信封解包后才交给
 * JS，但远程宿主可能原样转发 —— 这里对信封做防御性解包（ai-switch 同款）。
 */
async function callNative<T>(
  method: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  if (PREVIEW_MODE) return previewInvoke(method, payload) as T;
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

/** 使用已保存设置启动；立即返回 starting/running 快照，不保存任何表单草稿。 */
export async function startService(): Promise<StartServiceResult> {
  return callNative<StartServiceResult>("start_localsend", {});
}

/** 默认只检查活动传输；用户确认后 force=true 才取消未完成传输并停止。 */
export async function stopService(force = false): Promise<StopServiceResult> {
  return callNative<StopServiceResult>("stop_localsend", { force });
}

/** 取走事件队列里所有待处理事件（队列有界，满丢最旧）。 */
export async function pollEvents(): Promise<QueuedEvent[]> {
  const { events } = await callNative<{ events: QueuedEvent[] }>("poll_events");
  return events;
}
