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
  isPreviewMode,
  listDevices,
  listTransfers,
  onEvent,
  pollEvents,
  serverStatus,
  startService as nativeStartService,
  stopService as nativeStopService,
  type DeviceEntry,
  type IncomingRequestEvent,
  type Settings,
  type TransferRecord,
  type UnlistenFn,
} from "../api";
import { normalizeTransferStatus } from "../format";
import { pendingIncomingFromTransfers } from "./incomingRebuild";
import { devicesFromWire, upsertDeviceFromWire } from "./deviceState";
import {
  createServiceController,
  liveServiceStateForStatus,
  normalizeServerStatus,
  serviceAllowsLiveTraffic,
  type ServiceControlState,
} from "./serviceState";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "otools-plugin-sdk/tauri-plugin-notification-shim";

const POLL_INTERVAL_MS = 1000;
/** 设备表重同步：device-found 事件线上 lastSeenMs 恒为 0，靠周期刷新补真实值。 */
const DEVICE_RESYNC_MS = 15000;

/** sessionId → fileId → percent（transfer-progress 聚合）。 */
export type ProgressMap = Record<string, Record<string, number>>;

/** 模块级一次性标记：通知权限只请求一次，被拒后静默降级。 */
let notificationPermissionRequested = false;

async function notifyIncomingRequest(senderAlias: string): Promise<void> {
  if (isPreviewMode()) return;
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
  const [service, setService] = useState<ServiceControlState>({
    server: null, serviceBusy: false, serviceError: null, stopConfirmation: null,
  });
  const [live, setLive] = useState<{
    udpPort: number;
    devices: DeviceEntry[];
    incoming: IncomingRequestEvent[];
    progress: ProgressMap;
  }>({ udpPort: 0, devices: [], incoming: [], progress: {} });
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);

  const settingsRef = useRef<Settings | null>(null);
  const aliveRef = useRef(false);
  const seenIncomingRef = useRef(new Set<string>());
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const timersRef = useRef<number[]>([]);
  const lastLifecycleRef = useRef<string | null>(null);
  const controllerRef = useRef<ReturnType<typeof createServiceController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createServiceController({
      startService: nativeStartService,
      stopService: nativeStopService,
      serverStatus,
      onChange: (next) => { if (aliveRef.current) setService(next); },
      onStatus: (status) => {
        if (!aliveRef.current) return;
        setLive((current) => liveServiceStateForStatus(current, status));
        // 结果/重查询也走这里；不能只在 server-status 事件中刷新关联数据。
        if (lastLifecycleRef.current !== status.state) {
          lastLifecycleRef.current = status.state;
          if (status.state === "running") void refreshDevices();
          if (status.state === "stopped") void refreshTransfers();
        }
      },
    });
  }
  const controller = controllerRef.current;

  const startService = useCallback(() => controllerRef.current!.start(), []);
  const stopService = useCallback((force = false) => controllerRef.current!.stop(force), []);
  const confirmStopService = useCallback(() => controllerRef.current!.confirmStop(), []);
  const cancelStopService = useCallback(() => controllerRef.current!.cancelStop(), []);
  const refreshServer = useCallback(() => controllerRef.current!.refreshStatus(), []);

  const setDevices = useCallback((update: (list: DeviceEntry[]) => DeviceEntry[]) => {
    setLive((current) => ({ ...current, devices: update(current.devices) }));
  }, []);
  const setProgress = useCallback((update: (map: ProgressMap) => ProgressMap) => {
    setLive((current) => ({ ...current, progress: update(current.progress) }));
  }, []);
  const setIncoming = useCallback((update: (queue: IncomingRequestEvent[]) => IncomingRequestEvent[]) => {
    setLive((current) => ({ ...current, incoming: update(current.incoming) }));
  }, []);

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
    const before = controllerRef.current!.getState().server;
    if (!serviceAllowsLiveTraffic(before)) return;
    try {
      const { devices: list } = await listDevices();
      if (!aliveRef.current) return;
      const current = controllerRef.current!.getState().server;
      // 停服/重启之间返回的旧设备快照不得复活上一代的设备和 UDP 端口。
      if (!serviceAllowsLiveTraffic(current) || before?.revision !== current?.revision) return;
      setLive((liveState) => ({
        ...liveState, udpPort: current!.udpPort, devices: devicesFromWire(list, Date.now()),
      }));
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
  }, [setIncoming]);

  // --- 幂等事件应用 --------------------------------------------------------

  const upsertDevice = useCallback((entry: DeviceEntry) => {
    if (!serviceAllowsLiveTraffic(controllerRef.current!.getState().server)) return;
    if (!entry || typeof entry.ip !== "string" || !entry.info?.fingerprint) return;
    setDevices((list) => upsertDeviceFromWire(list, entry, Date.now()));
  }, [setDevices]);

  const removeDevice = useCallback((fingerprint: string) => {
    if (!fingerprint) return;
    setDevices((list) =>
      list.filter((item) => item.info.fingerprint !== fingerprint),
    );
  }, [setDevices]);

  const applyProgress = useCallback((sessionId: string, fileId: string, percent: number) => {
    if (!serviceAllowsLiveTraffic(controllerRef.current!.getState().server)) return;
    if (!sessionId || !fileId || typeof percent !== "number") return;
    setProgress((map) => {
      const fileMap = map[sessionId] ?? {};
      if (fileMap[fileId] === percent) return map;
      return { ...map, [sessionId]: { ...fileMap, [fileId]: percent } };
    });
  }, [setProgress]);

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
  }, [setIncoming, setProgress]);

  const applyIncomingRequest = useCallback((request: IncomingRequestEvent) => {
    if (!serviceAllowsLiveTraffic(controllerRef.current!.getState().server)) return;
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
  }, [setIncoming]);

  const applyServerStatus = useCallback((data: unknown) => {
    controllerRef.current!.applyStatus(data);
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
    controller.setAvailability(false, null);

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
          // 异步 starting/stopping 和未知态即使漏事件也能收敛；这里只查询，绝不启动。
          const current = controller.getState();
          if (!current.serviceBusy && (!current.server || ["starting", "stopping"].includes(current.server.state))) {
            await controller.refreshStatus();
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
        setLive((current) => ({
          ...current, udpPort: devicesResult.value.udpPort ?? 0,
          devices: devicesFromWire(devicesResult.value.devices, Date.now()),
        }));
      }
      if (transfersResult.status === "fulfilled") {
        const records = sortByNewestTransfers(transfersResult.value);
        setTransfers(records);
        // 待确认的 Receive 会话在面板重开后必须重新弹窗（Task 11 审查交接）：
        // native 在 prepare-upload 时已入队 Pending 记录，会话与 token 都还在
        // 内存里，session_accept 直接可用。按 sessionId 入 seen 集（粘性去重
        // 与事件线一致，双通道重复投递不会重开幽灵弹窗）。
        const pending = pendingIncomingFromTransfers(records).filter(
          (request) => !seenIncomingRef.current.has(request.sessionId),
        );
        for (const request of pending) seenIncomingRef.current.add(request.sessionId);
        if (pending.length) setIncoming((queue) => [...queue, ...pending]);
      }
      if (statusResult.status === "fulfilled") {
        applyServerStatus(statusResult.value);
        if (!normalizeServerStatus(statusResult.value)) void controller.refreshStatus();
      } else {
        // 其它面可用但状态读取失败：server 仍是 null，显示未知并可被轮询恢复。
        void controller.refreshStatus();
      }
      if (settingsResult.status === "fulfilled") {
        settingsRef.current = settingsResult.value;
        setSettings(settingsResult.value);
      }

      // 三个核心面全部失败 = 宿主桥未注入（浏览器直跑）→ 显式降级态。
      const missingHost = devicesResult.status === "rejected" &&
        transfersResult.status === "rejected" && statusResult.status === "rejected"
        ? asErrorText(devicesResult.reason) || "宿主桥不可用" : null;
      setHostError(missingHost);
      controller.setAvailability(true, missingHost);
      setReady(true);
      // 重建完成之后才允许实时事件进入（Review Focus #3）。
      startLive();
    }

    return () => {
      cancelled = true;
      aliveRef.current = false;
      controller.setAvailability(false, null);
      for (const timer of timersRef.current) window.clearInterval(timer);
      timersRef.current = [];
      for (const unlisten of unlistenersRef.current) void unlisten();
      unlistenersRef.current = [];
    };
  }, [applyServerStatus, controller, handleEvent, refreshDevices, setIncoming]);

  return {
    ready,
    hostError,
    settings,
    ...service,
    ...live,
    transfers,
    startService,
    stopService,
    confirmStopService,
    cancelStopService,
    refreshServer,
    refreshDevices,
    refreshTransfers,
    refreshSettings,
    dismissIncoming,
  };
}

export type PluginStore = ReturnType<typeof usePollEvents>;
