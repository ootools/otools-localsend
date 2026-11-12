/**
 * 面板状态源：先重建、后消费（Review Focus #3 —— 永不依赖事件回放）。
 *
 * 挂载时先用 listTransfers / listDevices / serverStatus / getSettings 重建
 * 全量状态，随后才启动实时消费：onEvent（宿主 listen shim）逐事件订阅 +
 * pollEvents 定时兜底 drain。两条通道可能重复投递同一事件，所有 handler
 * 必须幂等（incoming-request 按 sessionId 去重）。宿主未注入（浏览器直跑）
 * 时重建失败 → 降级 hostError 态，页面各自渲染占位，绝不崩溃。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EVENTS,
  getSettings,
  listDevices,
  listTransfers,
  onEvent,
  pollEvents,
  serverStatus,
  type DeviceEntry,
  type IncomingRequestEvent,
  type ServerStatus,
  type Settings,
  type TransferRecord,
  type UnlistenFn,
} from "../api";
import { normalizeTransferStatus } from "../format";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "otools-plugin-sdk/tauri-plugin-notification-shim";

const POLL_INTERVAL_MS = 1000;
/** 设备表重同步：device-found 事件线上 lastSeenMs 恒为 0，靠周期刷新补真实值。 */
const DEVICE_RESYNC_MS = 15000;

/**
 * native 线上 lastSeenMs 是"距今经过毫秒"（elapsed，device-found 事件恒为 0，
 * discovery.rs:128），不是 unix 毫秒 —— 摄取点统一归一化为 unix 存储。
 */
const seenAtUnixMs = (elapsedMs: number): number => Date.now() - elapsedMs;

/** sessionId → fileId → percent（transfer-progress 聚合）。 */
export type ProgressMap = Record<string, Record<string, number>>;

/** 模块级一次性标记：通知权限只请求一次，被拒后静默降级。 */
let notificationPermissionRequested = false;

async function notifyIncomingRequest(senderAlias: string): Promise<void> {
  try {
    let granted = false;
    try {
      granted = await isPermissionGranted();
    } catch {
      return;
    }
    if (!granted) {
      if (notificationPermissionRequested) return;
      notificationPermissionRequested = true;
      try {
        await requestPermission();
      } catch {
        return;
      }
      try {
        granted = await isPermissionGranted();
      } catch {
        return;
      }
      if (!granted) return;
    }
    await sendNotification({ title: `LocalSend：来自 ${senderAlias} 的传输请求` });
  } catch {
    // shim 不可用（无宿主/无 Notification API）—— 静默降级。
  }
}

function asErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortByNewestTransfers(records: TransferRecord[]): TransferRecord[] {
  return [...records].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function usePollEvents() {
  const [ready, setReady] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [udpPort, setUdpPort] = useState(0);
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [progress, setProgress] = useState<ProgressMap>({});
  const [incoming, setIncoming] = useState<IncomingRequestEvent[]>([]);

  const settingsRef = useRef<Settings | null>(null);
  const aliveRef = useRef(false);
  const seenIncomingRef = useRef(new Set<string>());
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const timersRef = useRef<number[]>([]);

  // --- 刷新动作 -----------------------------------------------------------

  const refreshTransfers = useCallback(async () => {
    try {
      const records = await listTransfers();
      if (!aliveRef.current) return;
      setTransfers(sortByNewestTransfers(records));
    } catch {
      // 降级：保留现有列表。
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const { devices: list, udpPort: port } = await listDevices();
      if (!aliveRef.current) return;
      setUdpPort(port ?? 0);
      // elapsed → unix 归一化后再按新近度排序。
      setDevices(
        list
          .map((entry) => ({ ...entry, lastSeenMs: seenAtUnixMs(entry.lastSeenMs ?? 0) }))
          .sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0)),
      );
    } catch {
      // 降级：保留现有列表。
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const loaded = await getSettings();
      if (!aliveRef.current) return;
      settingsRef.current = loaded;
      setSettings(loaded);
    } catch {
      // 降级：保留现有设置。
    }
  }, []);

  const dismissIncoming = useCallback((sessionId: string) => {
    // seen 集合保持粘性（不 delete）：同一 sessionId 永远不会合法地二次请求，
    // 双通道重复投递不得在用户处理后重开幽灵对话框。
    setIncoming((queue) => queue.filter((item) => item.sessionId !== sessionId));
  }, []);

  // --- 幂等事件应用 --------------------------------------------------------

  const upsertDevice = useCallback((entry: DeviceEntry) => {
    if (!entry || typeof entry.ip !== "string" || !entry.info?.fingerprint) return;
    setDevices((list) => {
      const index = list.findIndex(
        (item) => item.info.fingerprint === entry.info.fingerprint,
      );
      if (index === -1) return [...list, entry];
      const existing = list[index];
      // 事件线 lastSeenMs 是 elapsed（device-found 恒 0）：归一化成 unix 后
      // max 合并保留真实最近时间。
      const merged: DeviceEntry = {
        ...entry,
        lastSeenMs: Math.max(existing.lastSeenMs ?? 0, seenAtUnixMs(entry.lastSeenMs ?? 0)),
      };
      if (
        existing.ip === merged.ip &&
        existing.lastSeenMs === merged.lastSeenMs &&
        JSON.stringify(existing.info) === JSON.stringify(merged.info)
      ) {
        return list;
      }
      const next = [...list];
      next[index] = merged;
      return next;
    });
  }, []);

  const removeDevice = useCallback((fingerprint: string) => {
    if (!fingerprint) return;
    setDevices((list) =>
      list.filter((item) => item.info.fingerprint !== fingerprint),
    );
  }, []);

  const applyProgress = useCallback((sessionId: string, fileId: string, percent: number) => {
    if (!sessionId || !fileId || typeof percent !== "number") return;
    setProgress((map) => {
      const fileMap = map[sessionId] ?? {};
      if (fileMap[fileId] === percent) return map;
      return { ...map, [sessionId]: { ...fileMap, [fileId]: percent } };
    });
  }, []);

  const applyTransferDone = useCallback((sessionId: string, status: string) => {
    const normalized = normalizeTransferStatus(status);
    setTransfers((list) => {
      const index = list.findIndex((item) => item.sessionId === sessionId);
      if (index === -1 || list[index].status === normalized) return list;
      const next = [...list];
      next[index] = { ...next[index], status: normalized as TransferRecord["status"] };
      return next;
    });
    setProgress((map) => {
      if (!(sessionId in map)) return map;
      const next = { ...map };
      delete next[sessionId];
      return next;
    });
    if (normalized === "Cancelled") {
      // 会话已被 native 清理（过期/取消）—— 待确认弹窗随之失效，自动收走。
      // seen 集合保持粘性，防止双通道残留投递重开幽灵对话框。
      setIncoming((queue) => queue.filter((item) => item.sessionId !== sessionId));
    }
  }, []);

  const applyIncomingRequest = useCallback((request: IncomingRequestEvent) => {
    if (!request?.sessionId || !Array.isArray(request.files)) return;
    if (seenIncomingRef.current.has(request.sessionId)) return;
    seenIncomingRef.current.add(request.sessionId);
    setIncoming((queue) =>
      queue.some((item) => item.sessionId === request.sessionId)
        ? queue
        : [...queue, request],
    );
    // 面板隐藏时的宿主通知（notifyOnIncoming 门控；shim 缺席则静默）。
    const hidden = typeof document === "undefined" || document.hidden;
    if (hidden && settingsRef.current?.notifyOnIncoming) {
      void notifyIncomingRequest(request.sender?.alias ?? "未知设备");
    }
  }, []);

  const applyServerStatus = useCallback((data: unknown) => {
    const payload = (data ?? {}) as {
      port?: unknown;
      protocol?: unknown;
      fingerprint?: unknown;
      error?: unknown;
    };
    if (typeof payload.error === "string" && payload.error) {
      setServer({
        port: 0,
        protocol: "https",
        fingerprint: null,
        error: payload.error,
      });
      return;
    }
    if (typeof payload.port === "number" && payload.port > 0) {
      setServer({
        port: payload.port,
        protocol: typeof payload.protocol === "string" ? payload.protocol : "https",
        fingerprint: typeof payload.fingerprint === "string" ? payload.fingerprint : null,
        error: null,
      });
    }
  }, []);

  const handleEvent = useCallback(
    (name: string, data: unknown) => {
      try {
        switch (name) {
          case EVENTS.deviceFound:
            upsertDevice(data as DeviceEntry);
            break;
          case EVENTS.deviceLost: {
            const fingerprint = (data as { fingerprint?: unknown })?.fingerprint;
            if (typeof fingerprint === "string") removeDevice(fingerprint);
            break;
          }
          case EVENTS.incomingRequest:
            applyIncomingRequest(data as IncomingRequestEvent);
            break;
          case EVENTS.transferProgress: {
            const payload = (data ?? {}) as {
              sessionId?: unknown;
              fileId?: unknown;
              percent?: unknown;
            };
            if (
              typeof payload.sessionId === "string" &&
              typeof payload.fileId === "string" &&
              typeof payload.percent === "number"
            ) {
              applyProgress(payload.sessionId, payload.fileId, payload.percent);
            }
            break;
          }
          case EVENTS.transferDone: {
            const payload = (data ?? {}) as { sessionId?: unknown; status?: unknown };
            if (typeof payload.sessionId === "string" && typeof payload.status === "string") {
              applyTransferDone(payload.sessionId, payload.status);
              // 终态时 native 已把 destinations 写进记录 —— 拉一次补齐展示。
              void refreshTransfers();
            }
            break;
          }
          case EVENTS.serverStatus:
            applyServerStatus(data);
            break;
          default:
            break;
        }
      } catch {
        // 单条坏事件不影响后续消费。
      }
    },
    [
      applyIncomingRequest,
      applyProgress,
      applyServerStatus,
      applyTransferDone,
      refreshTransfers,
      removeDevice,
      upsertDevice,
    ],
  );

  // --- 重建 → 消费（严格顺序，Review Focus #3） ----------------------------

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;

    const startLive = () => {
      if (cancelled || !aliveRef.current) return;

      const drain = async () => {
        if (!aliveRef.current) return;
        try {
          const events = await pollEvents();
          if (!aliveRef.current) return;
          for (const queued of events) {
            handleEvent(queued.event, queued.data);
          }
        } catch {
          // 无宿主（浏览器直跑）或桥失效：静默，重建阶段的降级态已覆盖。
        }
      };

      const subscribe = async () => {
        for (const name of Object.values(EVENTS)) {
          if (cancelled || !aliveRef.current) return;
          try {
            const unlisten = await onEvent<unknown>(name, (payload) => {
              handleEvent(name, payload);
            });
            if (cancelled || !aliveRef.current) {
              void unlisten();
              return;
            }
            unlistenersRef.current.push(unlisten);
          } catch {
            // listen shim 不可用 —— 仅依赖 pollEvents 兜底。
          }
        }
      };

      void subscribe();
      void drain();
      timersRef.current.push(window.setInterval(drain, POLL_INTERVAL_MS));
      timersRef.current.push(
        window.setInterval(() => void refreshDevices(), DEVICE_RESYNC_MS),
      );
    };

    void rebuild();

    async function rebuild() {
      const [devicesResult, transfersResult, statusResult, settingsResult] =
        await Promise.allSettled([
          listDevices(),
          listTransfers(),
          serverStatus(),
          getSettings(),
        ]);
      if (cancelled || !aliveRef.current) return;

      if (devicesResult.status === "fulfilled") {
        setUdpPort(devicesResult.value.udpPort ?? 0);
        setDevices(
          devicesResult.value.devices
            .map((entry) => ({ ...entry, lastSeenMs: seenAtUnixMs(entry.lastSeenMs ?? 0) }))
            .sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0)),
        );
      }
      if (transfersResult.status === "fulfilled") {
        setTransfers(sortByNewestTransfers(transfersResult.value));
      }
      if (statusResult.status === "fulfilled") {
        setServer(statusResult.value);
      }
      if (settingsResult.status === "fulfilled") {
        settingsRef.current = settingsResult.value;
        setSettings(settingsResult.value);
      }

      // 三个核心面全部失败 = 宿主桥未注入（浏览器直跑）→ 显式降级态。
      if (
        devicesResult.status === "rejected" &&
        transfersResult.status === "rejected" &&
        statusResult.status === "rejected"
      ) {
        setHostError(asErrorText(devicesResult.reason) || "宿主桥不可用");
      }
      setReady(true);
      // 重建完成之后才允许实时事件进入（Review Focus #3）。
      startLive();
    }

    return () => {
      cancelled = true;
      aliveRef.current = false;
      for (const timer of timersRef.current) window.clearInterval(timer);
      timersRef.current = [];
      for (const unlisten of unlistenersRef.current) void unlisten();
      unlistenersRef.current = [];
    };
  }, [handleEvent, refreshDevices]);

  return {
    ready,
    hostError,
    settings,
    server,
    udpPort,
    devices,
    transfers,
    progress,
    incoming,
    refreshDevices,
    refreshTransfers,
    refreshSettings,
    dismissIncoming,
  };
}

export type PluginStore = ReturnType<typeof usePollEvents>;
