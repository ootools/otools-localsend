import type { ServerStatus, StartServiceResult, StopServiceResult } from "../api";

export interface StopConfirmation {
  activeTransfers: number;
}

export interface ServiceControlState {
  server: ServerStatus | null;
  serviceBusy: boolean;
  serviceError: string | null;
  stopConfirmation: StopConfirmation | null;
}

export interface ServiceControlContext extends ServiceControlState {
  ready: boolean;
  hostError: string | null;
}

export interface ServiceControllerOptions {
  startService: () => Promise<StartServiceResult>;
  stopService: (force: boolean) => Promise<StopServiceResult>;
  serverStatus: () => Promise<ServerStatus>;
  onChange: (state: ServiceControlState) => void;
  onStatus: (status: ServerStatus) => void;
}

/** 一个控制器实例由 usePollEvents 的 ref 持有，所有入口共享同步 guard。 */
export function createServiceController(options: ServiceControllerOptions) {
  let state: ServiceControlState = {
    server: null, serviceBusy: false, serviceError: null, stopConfirmation: null,
  };
  let ready = false;
  let hostError: string | null = null;
  let busyGuard = false;
  let operationError: string | null = null;
  let operationRevision = 0;

  const update = (patch: Partial<ServiceControlState>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };

  const applyStatus = (data: unknown): boolean => {
    const status = normalizeServerStatus(data);
    if (!status) return false;
    const previous = state.server;
    if (previous && (
      status.revision < previous.revision ||
      (status.revision === previous.revision && status.state !== previous.state)
    )) return false;
    update({
      server: status,
      stopConfirmation: status.state === "running" ? state.stopConfirmation : null,
    });
    options.onStatus(status);
    return true;
  };

  const readStatus = async (): Promise<string | null> => {
    try {
      const status = await options.serverStatus();
      if (!normalizeServerStatus(status)) throw new Error("服务状态响应无效");
      applyStatus(status);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };

  const refreshStatus = async () => {
    const revision = operationRevision;
    const error = await readStatus();
    // 轮询恢复可以清掉读取错误，但不能把手动操作失败悄悄抹去。
    if (revision === operationRevision && !busyGuard) {
      update({ serviceError: operationError ?? error });
    }
  };

  const operate = async (action: "start" | "stop", force = false) => {
    if (!ready || hostError || busyGuard || !state.server) return;
    if (action === "start") {
      if (state.server.state !== "stopped" && state.server.state !== "failed") return;
      if (state.stopConfirmation) return;
    } else {
      if (state.server.state !== "running") return;
      if (force ? !state.stopConfirmation : state.stopConfirmation !== null) return;
    }
    // 在第一次 await 之前加锁；React state 尚未重渲染时也不会双击重入。
    busyGuard = true;
    operationRevision++;
    operationError = null;
    update({ serviceBusy: true, serviceError: null });
    let error: string | null = null;
    try {
      if (action === "start") {
        const result = await options.startService();
        if (result.started !== true || !normalizeServerStatus(result.status)) {
          throw new Error("启动服务响应无效");
        }
        applyStatus(result.status);
      } else {
        const result = await options.stopService(force);
        if (
          typeof result.confirmationRequired !== "boolean" ||
          !nonnegativeInteger(result.activeTransfers) ||
          !normalizeServerStatus(result.status)
        ) throw new Error("停止服务响应无效");
        const accepted = applyStatus(result.status);
        if (accepted) {
          update({
            stopConfirmation: result.confirmationRequired && state.server?.state === "running"
              ? { activeTransfers: result.activeTransfers } : null,
          });
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      // 成功、拒绝或异常都重读快照，不依赖事件是否及时/重复投递。
      const queryError = await readStatus();
      operationError = error;
      busyGuard = false;
      update({ serviceBusy: false, serviceError: operationError ?? queryError });
    }
  };

  const stop = (force = false) => operate("stop", force);
  return {
    getState: () => state,
    setAvailability: (loaded: boolean, error: string | null) => {
      ready = loaded;
      hostError = error;
    },
    applyStatus,
    refreshStatus,
    start: () => operate("start"),
    stop,
    confirmStop: () => stop(true),
    cancelStop: () => {
      if (busyGuard) return;
      update({ stopConfirmation: null });
    },
  };
}

export function serviceAllowsLiveTraffic(server: ServerStatus | null): boolean {
  return server?.state === "running";
}

/** 终态只清理瞬时展示；展开的其它字段（尤其 transfers）保持原样。 */
export function liveServiceStateForStatus<T extends {
  udpPort: number;
  devices: unknown[];
  incoming: unknown[];
  progress: Record<string, unknown>;
}>(live: T, server: ServerStatus): T {
  if (server.state === "stopped" || server.state === "failed") {
    return { ...live, udpPort: 0, devices: [], incoming: [], progress: {} };
  }
  return { ...live, udpPort: server.udpPort };
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 不兼容的旧形状或损坏的快照是未知状态，绝不猜测为 starting。 */
export function normalizeServerStatus(payload: unknown): ServerStatus | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.state !== "string" ||
    !["stopped", "starting", "running", "stopping", "failed"].includes(value.state) ||
    !nonnegativeInteger(value.port) || value.port > 65535 ||
    !nonnegativeInteger(value.udpPort) || value.udpPort > 65535 ||
    value.protocol !== "https" ||
    (value.fingerprint !== null && typeof value.fingerprint !== "string") ||
    (value.error !== null && typeof value.error !== "string") ||
    !nonnegativeInteger(value.activeTransfers) ||
    !nonnegativeInteger(value.revision)
  ) return null;
  return {
    state: value.state as ServerStatus["state"],
    port: value.port,
    udpPort: value.udpPort,
    protocol: "https",
    fingerprint: value.fingerprint as string | null,
    error: value.error as string | null,
    activeTransfers: value.activeTransfers,
    revision: value.revision,
  };
}

export function serviceControlView(context: ServiceControlContext): {
  action: "start" | "stop" | null;
  label: string;
  statusLabel: string;
  dot: "net-idle" | "net-ok" | "net-off" | "net-wait";
  disabled: boolean;
} {
  let action: "start" | "stop" | null = null;
  let label = "状态未知";
  let statusLabel = "服务状态未知";
  let dot: "net-idle" | "net-ok" | "net-off" | "net-wait" = "net-idle";
  if (!context.ready) {
    label = "读取中…";
    statusLabel = "正在获取服务状态…";
    dot = "net-wait";
  } else if (context.hostError) {
    label = "宿主未注入";
    statusLabel = "宿主桥未注入";
    dot = "net-off";
  } else {
    switch (context.server?.state) {
      case "stopped":
        action = "start";
        label = "启动服务";
        statusLabel = "服务已停止";
        break;
      case "failed":
        action = "start";
        label = "启动服务";
        statusLabel = "服务异常";
        dot = "net-off";
        break;
      case "running":
        action = "stop";
        label = "停止服务";
        statusLabel = `服务运行中 · 端口 ${context.server.port}`;
        dot = "net-ok";
        break;
      case "starting":
        label = "启动中…";
        statusLabel = "服务启动中…";
        dot = "net-wait";
        break;
      case "stopping":
        label = "停止中…";
        statusLabel = "服务停止中…";
        dot = "net-wait";
        break;
    }
  }
  return {
    action, label, statusLabel, dot,
    disabled: action === null || context.serviceBusy || context.stopConfirmation !== null,
  };
}
