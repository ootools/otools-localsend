/**
 * 设备页：发现列表 + 刷新（discover_now）+ 选中设备发送文件/文本。
 *
 * 线上注意：发送目标端口必须用对端 DeviceInfo.port（它 announce 的 HTTPS
 * 端口，端口回退后可能 ≠ 53317），而不是本机 udpPort / serverStatus.port。
 */

import { useMemo, useState } from "react";
import { pickFiles } from "otools-plugin-sdk/dialog";
import { discoverNow, sendFiles, sendText } from "../api";
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
    if (!selected || busy) return;
    setBusy("file");
    setError(null);
    try {
      const paths = await pickFiles({ title: "选择要发送的文件" });
      if (!paths || paths.length === 0) return; // 用户取消
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
    if (!selected || busy) return;
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
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm" role="alert">
        <p className="font-medium text-zinc-200">宿主未注入</p>
        <p className="mt-1 text-zinc-500">
          未检测到 OTools 宿主桥接，仅作本地预览占位：{store.hostError}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">
          附近设备（{store.devices.length}）
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy !== null}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
        >
          {busy === "refresh" ? "搜索中…" : "刷新发现"}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300" role="alert">
          {error}
        </p>
      )}

      {store.devices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
          <p>未发现设备</p>
          <ul className="mt-3 space-y-1 text-xs text-zinc-600">
            <li>· 确认与对方设备在同一局域网网段</li>
            <li>· 检查防火墙是否放行 UDP/TCP 53317</li>
            <li>· 对方 LocalSend 需保持开启可见</li>
          </ul>
        </div>
      ) : (
        <div className="grid gap-2">
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
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-sm text-zinc-300">
            发送给 <span className="font-medium text-zinc-100">{selected.info.alias}</span>
            <span className="ml-2 text-xs text-zinc-500">
              {selected.ip}:{selected.info.port}
            </span>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void sendFilesFlow()}
              disabled={busy !== null}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy === "file" ? "发送中…" : "发送文件"}
            </button>
            <button
              type="button"
              onClick={() => void sendTextFlow()}
              disabled={busy !== null}
              className="rounded-md border border-sky-700 px-3 py-1.5 text-xs font-medium text-sky-300 hover:border-sky-500 disabled:opacity-50"
            >
              {busy === "text" ? "发送中…" : "发送文本"}
            </button>
            <input
              type="text"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="对方 PIN（可选）"
              className="w-36 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
            />
          </div>

          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入要发送的文本…"
            rows={3}
            className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
          />
        </div>
      )}
    </div>
  );
}
