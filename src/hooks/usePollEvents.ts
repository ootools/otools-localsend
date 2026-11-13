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
  type ServerStatus,
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

function isTerminal(status: TransferRecord["status"]): boolean {
  return status === "Done" || status === "Cancelled" || status === "Failed";
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
  const readyRef = useRef(false);
  const hostErrorRef = useRef<string | null>(null);
  const seenIncomingRef = useRef(new Set<string>());
  const handledIncomingRef = useRef(new Set<string>());
  const terminalSessionsRef = useRef(new Map<string, TransferRecord["status"]>());
  const transfersRef = useRef<TransferRecord[]>([]);
  const generationRef = useRef(0);
  const lastStatusRef = useRef<ServerStatus | null>(null);
  const transfersRequestRef = useRef(0);
  const devicesRequestRef = useRef(0);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const timersRef = useRef<number[]>([]);
  const controllerRef = useRef<ReturnType<typeof createServiceController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createServiceController({
      startService: nativeStartService,
      stopService: nativeStopService,
      serverStatus,
      onChange: (next) => { if (aliveRef.current) setService(next); },
      onStatus: (status) => {
        if (!aliveRef.current) return;
        const previous = lastStatusRef.current;
        const changed = previous?.state !== status.state || previous?.revision !== status.revision;
        lastStatusRef.current = status;
        if (changed) {
          generationRef.current++;
          if (status.state === "stopped" || status.state === "failed") {
            for (const record of transfersRef.current) {
              if (record.direction === "Receive" && record.status === "Pending") handledIncomingRef.current.add(record.sessionId);
            }
          }
        }
        setLive((current) => liveServiceStateForStatus(current, status));
        // 只在有效原生快照被接受后恢复宿主可用性；所有 resync 都是被动读取。
        markNativeSuccess();
        if (changed) {
          if (status.state === "running") void refreshDevices();
          if (status.state === "running" || status.state === "stopped" || status.state === "failed") void refreshTransfers();
        }
      },
    });
  }
  const controller = controllerRef.current;
  const stopReturnFocusRef = useRef<HTMLElement | null>(null);

  const startService = useCallback(() => controllerRef.current!.start(), []);
  const stopService = useCallback((force = false) => {
    if (!force && !controllerRef.current!.getState().serviceBusy && !controllerRef.current!.getState().stopConfirmation) {
      stopReturnFocusRef.current = typeof document === "undefined" ? null : document.activeElement as HTMLElement | null;
    }
    return controllerRef.current!.stop(force);
  }, []);
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

  function markNativeSuccess() {
    if (!aliveRef.current || !readyRef.current || !hostErrorRef.current) return;
    hostErrorRef.current = null;
    setHostError(null);
    controllerRef.current!.setAvailability(true, null);
    void refreshSettings();
    void refreshTransfers();
    void refreshDevices();
  }

  const applyTransferSnapshot = useCallback((records: TransferRecord[]) => {
    const previous = new Map(transfersRef.current.map((record) => [record.sessionId, record]));
    const next = records.map((record) => {
      const old = previous.get(record.sessionId);
      const terminal = terminalSessionsRef.current.get(record.sessionId);
      if (isTerminal(record.status) && !terminal) terminalSessionsRef.current.set(record.sessionId, record.status);
      if (terminal && record.status !== terminal) {
        return old ?? { ...record, status: terminal };
      }
      if (old && isTerminal(old.status)) {
        return { ...record, status: old.status, destinations: { ...old.destinations, ...record.destinations } };
      }
      return record;
    });
    // 原生列表不能因晚到的快照丢掉已观察到的终态记录及成功路径。
    for (const old of previous.values()) {
      if (isTerminal(old.status) && !next.some((record) => record.sessionId === old.sessionId)) next.push(old);
    }
    const sorted = sortByNewestTransfers(next);
    transfersRef.current = sorted;
    setTransfers(sorted);
    const pending = pendingIncomingFromTransfers(sorted).filter((request) => (
      !terminalSessionsRef.current.has(request.sessionId) && !handledIncomingRef.current.has(request.sessionId)
    ));
    const pendingIds = new Set(pending.map((request) => request.sessionId));
    const lifecycle = controllerRef.current!.getState().server?.state;
    const retainPending = lifecycle !== "stopped" && lifecycle !== "failed";
    setLive((current) => {
      const queue = current.incoming.filter((request) => (
        !terminalSessionsRef.current.has(request.sessionId) &&
        !handledIncomingRef.current.has(request.sessionId) &&
        (!previous.has(request.sessionId) || pendingIds.has(request.sessionId))
      ));
      if (retainPending) {
        for (const request of pending) {
          seenIncomingRef.current.add(request.sessionId);
          if (!queue.some((item) => item.sessionId === request.sessionId)) queue.push(request);
        }
      }
      const progress = Object.fromEntries(Object.entries(current.progress).filter(([id]) => !terminalSessionsRef.current.has(id)));
      return { ...current, incoming: retainPending ? queue : [], progress };
    });
  }, []);

  const refreshTransfers = useCallback(async () => {
    const request = ++transfersRequestRef.current;
    const generation = generationRef.current;
    try {
      const records = await listTransfers();
      if (!aliveRef.current || request !== transfersRequestRef.current || generation !== generationRef.current) return;
      applyTransferSnapshot(records);
      markNativeSuccess();
    } catch {
      // 降级：保留现有列表。
    }
  }, [applyTransferSnapshot]);

  const refreshDevices = useCallback(async () => {
    const request = ++devicesRequestRef.current;
    const generation = generationRef.current;
    const before = controllerRef.current!.getState().server;
    if (!serviceAllowsLiveTraffic(before)) return;
    try {
      const { devices: list } = await listDevices();
      if (!aliveRef.current || request !== devicesRequestRef.current || generation !== generationRef.current) return;
      const current = controllerRef.current!.getState().server;
      if (!serviceAllowsLiveTraffic(current) || before?.revision !== current?.revision) return;
      setLive((liveState) => ({
        ...liveState, udpPort: current!.udpPort, devices: devicesFromWire(list, Date.now()),
      }));
      markNativeSuccess();
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
    handledIncomingRef.current.add(sessionId);
    seenIncomingRef.current.add(sessionId);
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
    if (!sessionId || !fileId || typeof percent !== "number" || terminalSessionsRef.current.has(sessionId)) return;
    setProgress((map) => {
      const fileMap = map[sessionId] ?? {};
      if (fileMap[fileId] === percent) return map;
      return { ...map, [sessionId]: { ...fileMap, [fileId]: percent } };
    });
  }, [setProgress]);

  const applyTransferDone = useCallback((sessionId: string, status: string) => {
    const normalized = normalizeTransferStatus(status) as TransferRecord["status"];
    if (!isTerminal(normalized)) return;
    const terminal = terminalSessionsRef.current.get(sessionId) ?? normalized;
    terminalSessionsRef.current.set(sessionId, terminal);
    handledIncomingRef.current.add(sessionId);
    const records = transfersRef.current.map((record) => record.sessionId === sessionId ? { ...record, status: terminal } : record);
    transfersRef.current = records;
    setTransfers(records);
    setProgress((map) => {
      if (!(sessionId in map)) return map;
      const next = { ...map };
      delete next[sessionId];
      return next;
    });
    setIncoming((queue) => queue.filter((item) => item.sessionId !== sessionId));
  }, [setIncoming, setProgress]);

  const applyIncomingRequest = useCallback((request: IncomingRequestEvent) => {
    if (!serviceAllowsLiveTraffic(controllerRef.current!.getState().server)) return;
    if (!request?.sessionId || !Array.isArray(request.files)) return;
    if (seenIncomingRef.current.has(request.sessionId) || handledIncomingRef.current.has(request.sessionId) || terminalSessionsRef.current.has(request.sessionId)) return;
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
    (name: string, data: unknown, generation = generationRef.current) => {
      if (name !== EVENTS.serverStatus && name !== EVENTS.transferDone && generation !== generationRef.current) return;
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
    readyRef.current = false;
    generationRef.current++;
    let cancelled = false;
    controller.setAvailability(false, null);

    const startLive = () => {
      if (cancelled || !aliveRef.current) return;

      const drain = async () => {
        if (cancelled || !aliveRef.current) return;
        const generation = generationRef.current;
        // 事件与状态是独立通道：poll_events 失败或挂起不阻断状态恢复。
        const recoverStatus = async () => {
          const current = controller.getState();
          if (!current.serviceBusy && (hostErrorRef.current || !current.server || ["starting", "stopping"].includes(current.server.state))) {
            await controller.refreshStatus();
          }
        };
        const consume = async () => {
          try {
            const events = await pollEvents();
            if (cancelled || !aliveRef.current) return;
            // 一批里先处理完整快照和终态；较新生命周期让同批旧 live 负载失效。
            for (const queued of events) {
              if (queued.event === EVENTS.serverStatus || queued.event === EVENTS.transferDone) {
                handleEvent(queued.event, queued.data, generation);
              }
            }
            for (const queued of events) {
              if (queued.event !== EVENTS.serverStatus && queued.event !== EVENTS.transferDone) {
                handleEvent(queued.event, queued.data, generation);
              }
            }
          } catch {
            // 事件通道降级，不影响独立的 server_status 查询。
          }
        };
        await Promise.all([consume(), recoverStatus()]);
      };

      const subscribe = async () => {
        for (const name of Object.values(EVENTS)) {
          if (cancelled || !aliveRef.current) return;
          try {
            const unlisten = await onEvent<unknown>(name, (payload) => {
              if (cancelled || !aliveRef.current) return;
              const generation = generationRef.current;
              handleEvent(name, payload, generation);
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
      const generation = generationRef.current;
      const transfersRequest = ++transfersRequestRef.current;
      const devicesRequest = ++devicesRequestRef.current;
      const [devicesResult, transfersResult, statusResult, settingsResult] =
        await Promise.allSettled([
          listDevices(),
          listTransfers(),
          serverStatus(),
          getSettings(),
        ]);
      if (cancelled || !aliveRef.current) return;

      if (devicesResult.status === "fulfilled" && devicesRequest === devicesRequestRef.current && generation === generationRef.current) {
        setLive((current) => ({
          ...current, udpPort: devicesResult.value.udpPort ?? 0,
          devices: devicesFromWire(devicesResult.value.devices, Date.now()),
        }));
      }
      if (transfersResult.status === "fulfilled" && transfersRequest === transfersRequestRef.current && generation === generationRef.current) {
        applyTransferSnapshot(transfersResult.value);
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
      hostErrorRef.current = missingHost;
      setHostError(missingHost);
      readyRef.current = true;
      controller.setAvailability(true, missingHost);
      setReady(true);
      // 重建完成之后才允许实时事件进入（Review Focus #3）。
      startLive();
    }

    return () => {
      cancelled = true;
      aliveRef.current = false;
      readyRef.current = false;
      generationRef.current++;
      controller.setAvailability(false, null);
      for (const timer of timersRef.current) window.clearInterval(timer);
      timersRef.current = [];
      for (const unlisten of unlistenersRef.current) void unlisten();
      unlistenersRef.current = [];
    };
  }, [applyServerStatus, applyTransferSnapshot, controller, handleEvent, refreshDevices]);

  return {
    ready,
    hostError,
    settings,
    ...service,
    stopReturnFocus: stopReturnFocusRef.current,
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
