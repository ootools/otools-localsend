/**
 * 设备页：发现列表 + 刷新（discover_now）+ 选中设备发送文件/文本。
 *
 * 线上注意：发送目标端口必须用对端 DeviceInfo.port（它 announce 的 HTTPS
 * 端口，端口回退后可能 ≠ 53317），而不是本机 udpPort / serverStatus.port。
 */

import { useMemo, useRef, useState } from "react";
import { pickFromHostTree } from "otools-plugin-sdk/host-file-tree";
import { discoverNow, isPreviewMode, sendFiles, sendText, serverStatus } from "../api";
import { DeviceCard } from "../components/DeviceCard";
import { formatError } from "../format";
import type { PluginStore } from "../hooks/usePollEvents";

interface DevicesPageProps {
  store: PluginStore;
  onGoToTransfers: () => void;
}

type Busy = "file" | "text" | "refresh" | null;

export function DevicesPage({ store, onGoToTransfers }: DevicesPageProps) {
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  const serviceAvailable = store.ready && !store.hostError && !store.serviceBusy && !store.stopConfirmation && store.server?.state === "running";

  const selected = useMemo(
    () => store.devices.find((d) => d.info.fingerprint === selectedFingerprint) ?? null,
    [store.devices, selectedFingerprint],
  );

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      await discoverNow();
      await store.refreshDevices();
      // 对端回复 register 需要一点时间，稍后再补一轮。
      window.setTimeout(() => void store.refreshDevices(), 2000);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(null);
    }
  };

  const sendFilesFlow = async () => {
    if (!selected || busy || !serviceAvailable) return;
    const revision = store.server!.revision;
    setBusy("file");
    setError(null);
    try {
      let paths: string[] | null = null;
      if (isPreviewMode()) {
        // 预览模式：仿真宿主文件树的选择结果。
        paths = ["D:\\Photos\\IMG_0042.jpg", "D:\\Docs\\季度报表.xlsx"];
      } else {
        // 文件选择走宿主自绘文件树（SDK pickFromHostTree）：面板内渲染、
        // 选出的是宿主侧路径，桌面/远程访问行为一致；原生对话框不再依赖。
        const picked = await pickFromHostTree({
          title: "选择要发送的文件",
          directory: false,
          multiple: true,
        });
        if (picked.kind !== "picked" || picked.paths.length === 0) return; // 用户取消
        paths = picked.paths;
      }
      const status = await serverStatus();
      const current = storeRef.current;
      if (!current.ready || current.hostError || current.serviceBusy || current.stopConfirmation ||
        current.server?.state !== "running" || current.server.revision !== revision ||
        status.state !== "running" || status.revision !== revision) {
        setError("服务状态已变化，请在服务运行后重新选择文件");
        return;
      }
      await sendFiles(selected.ip, selected.info.port, paths, pin.trim() || undefined);
      await store.refreshTransfers();
      onGoToTransfers();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(null);
    }
  };

  const sendTextFlow = async () => {
    if (!selected || busy || !serviceAvailable) return;
    const body = text.trim();
    if (!body) {
      setError("文本内容不能为空");
      return;
    }
    setBusy("text");
    setError(null);
    try {
      await sendText(selected.ip, selected.info.port, body, pin.trim() || undefined);
      setText("");
      await store.refreshTransfers();
      onGoToTransfers();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(null);
    }
  };

  if (store.hostError) {
    return (
      <div className="banner banner-warn" role="alert">
        <span aria-hidden>🔌</span>
        <span>
          <b>宿主未注入</b> — 未检测到 OTools 宿主桥接，仅作本地预览占位：{store.hostError}
        </span>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar-actions" style={{ padding: "0 0 12px", justifyContent: "space-between" }}>
        <span className="send-target">
          共 <b>{store.devices.length}</b> 台设备
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy !== null}
          className="btn btn-sm"
        >
          {busy === "refresh" ? "搜索中…" : "↻ 刷新发现"}
        </button>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          <span aria-hidden>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {store.devices.length === 0 ? (
        <div className="empty">
          <p>未发现附近的 LocalSend 设备</p>
          <ul>
            <li>· 确认与对方设备在同一局域网网段</li>
            <li>· 检查防火墙是否放行 UDP/TCP 53317</li>
            <li>· 对方 LocalSend 需保持开启可见</li>
          </ul>
        </div>
      ) : (
        <div className="dev-list">
          {store.devices.map((entry) => (
            <DeviceCard
              key={entry.info.fingerprint}
              entry={entry}
              selected={entry.info.fingerprint === selectedFingerprint}
              onSelect={() => setSelectedFingerprint(entry.info.fingerprint)}
            />
          ))}
        </div>
      )}

      {selected && (
        <div className="card send-card">
          <p className="send-target">
            发送给 <b>{selected.info.alias}</b>
            <small>
              {selected.ip}:{selected.info.port}
            </small>
          </p>

          <div className="send-row">
            <button
              type="button"
              onClick={() => void sendFilesFlow()}
              disabled={busy !== null || !serviceAvailable}
              className="btn btn-primary btn-sm"
            >
              {busy === "file" ? "发送中…" : "📎 发送文件"}
            </button>
            <button
              type="button"
              onClick={() => void sendTextFlow()}
              disabled={busy !== null || !serviceAvailable}
              className="btn btn-sm"
            >
              {busy === "text" ? "发送中…" : "💬 发送文本"}
            </button>
            <input
              type="text"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="对方 PIN（可选）"
              className="field send-pin"
            />
          </div>

          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入要发送的文本…"
            rows={3}
            className="field"
          />
        </div>
      )}
    </div>
  );
}
