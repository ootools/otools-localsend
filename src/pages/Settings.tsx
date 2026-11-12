/**
 * 设置页：全字段表单 → settings_set 整体替换；下方展示生效中的服务状态
 * （实际绑定端口/协议/指纹 + UDP 发现端口）。宿主未注入时降级占位。
 */

import { useEffect, useState } from "react";
import { pickDirectory } from "otools-plugin-sdk/dialog";
import { setSettings, type Settings } from "../api";
import { formatError } from "../format";
import type { PluginStore } from "../hooks/usePollEvents";

interface Draft {
  alias: string;
  deviceModel: string;
  deviceType: string;
  port: string;
  downloadDir: string;
  pin: string;
  autoSave: boolean;
  notifyOnIncoming: boolean;
}

function draftFrom(settings: Settings): Draft {
  return {
    alias: settings.alias ?? "",
    deviceModel: settings.deviceModel ?? "",
    deviceType: settings.deviceType || "desktop",
    port: String(settings.port ?? 53317),
    downloadDir: settings.downloadDir ?? "",
    pin: settings.pin ?? "",
    autoSave: Boolean(settings.autoSave),
    notifyOnIncoming: Boolean(settings.notifyOnIncoming),
  };
}

const DEVICE_TYPES: Array<{ value: string; label: string }> = [
  { value: "desktop", label: "电脑" },
  { value: "mobile", label: "手机" },
  { value: "headless", label: "无头设备" },
];

const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none";

export function SettingsPage({ store }: { store: PluginStore }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (store.settings && draft === null) {
      setDraft(draftFrom(store.settings));
    }
  }, [store.settings, draft]);

  const pickDownloadDir = async () => {
    try {
      const dir = await pickDirectory({ title: "选择下载目录" });
      if (dir && draft) {
        setDraft({ ...draft, downloadDir: dir });
      }
    } catch {
      // 对话框不可用（无宿主）：静默。
    }
  };

  const save = async () => {
    if (!draft || busy) return;
    const port = Number.parseInt(draft.port, 10);
    if (!draft.alias.trim()) {
      setError("别名不能为空");
      return;
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError("端口需为 1024–65535 的整数");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next: Settings = {
        alias: draft.alias.trim(),
        deviceModel: draft.deviceModel.trim() || null,
        deviceType: draft.deviceType,
        port,
        downloadDir: draft.downloadDir.trim() || null,
        pin: draft.pin.trim() || null,
        autoSave: draft.autoSave,
        notifyOnIncoming: draft.notifyOnIncoming,
      };
      await setSettings(next);
      await store.refreshSettings();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(false);
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

  if (!draft) {
    return (
      <p className="text-sm text-zinc-500" role="status">
        {store.ready ? "设置不可用" : "正在读取设置…"}
      </p>
    );
  }

  const server = store.server;
  const fingerprint = server?.fingerprint ?? null;
  const fingerprintShort = fingerprint
    ? `${fingerprint.slice(0, 16)}…${fingerprint.slice(-8)}`
    : "—";

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-medium text-zinc-300">本机</h2>
        <div className="mt-3 grid gap-3">
          <label className="grid gap-1 text-xs text-zinc-500">
            别名
            <input
              type="text"
              value={draft.alias}
              onChange={(event) => setDraft({ ...draft, alias: event.target.value })}
              className={inputClass}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs text-zinc-500">
              设备型号（可选）
              <input
                type="text"
                value={draft.deviceModel}
                onChange={(event) => setDraft({ ...draft, deviceModel: event.target.value })}
                placeholder="如 Windows 11"
                className={inputClass}
              />
            </label>
            <label className="grid gap-1 text-xs text-zinc-500">
              设备类型
              <select
                value={draft.deviceType}
                onChange={(event) => setDraft({ ...draft, deviceType: event.target.value })}
                className={inputClass}
              >
                {DEVICE_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="grid gap-1 text-xs text-zinc-500">
            端口（重启宿主后生效）
            <input
              type="number"
              min={1024}
              max={65535}
              value={draft.port}
              onChange={(event) => setDraft({ ...draft, port: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className="grid gap-1 text-xs text-zinc-500">
            下载目录（留空则保存在插件数据目录）
            <span className="flex gap-2">
              <input
                type="text"
                value={draft.downloadDir}
                onChange={(event) => setDraft({ ...draft, downloadDir: event.target.value })}
                placeholder="如 D:\\Downloads"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => void pickDownloadDir()}
                className="shrink-0 rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
              >
                选择目录
              </button>
            </span>
          </label>
          <label className="grid gap-1 text-xs text-zinc-500">
            PIN（可选，接收时校验）
            <input
              type="text"
              value={draft.pin}
              onChange={(event) => setDraft({ ...draft, pin: event.target.value })}
              placeholder="留空则不校验"
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={draft.autoSave}
              onChange={(event) => setDraft({ ...draft, autoSave: event.target.checked })}
              className="h-3.5 w-3.5 accent-sky-600"
            />
            自动保存（免确认直接接收）
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={draft.notifyOnIncoming}
              onChange={(event) => setDraft({ ...draft, notifyOnIncoming: event.target.checked })}
              className="h-3.5 w-3.5 accent-sky-600"
            />
            面板隐藏时弹出传输请求通知
          </label>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300" role="alert">
            {error}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存设置"}
          </button>
          {saved && (
            <span className="text-xs text-emerald-400" role="status">
              已保存
            </span>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-medium text-zinc-300">服务状态（生效中）</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-zinc-500">服务端口</dt>
          <dd className="text-zinc-100">
            {server ? (server.port > 0 ? server.port : "未绑定") : "—"}
            {server?.error ? (
              <span className="ml-2 text-red-400">异常</span>
            ) : null}
          </dd>
          <dt className="text-zinc-500">协议</dt>
          <dd className="text-zinc-100">{server?.protocol ?? "—"}</dd>
          <dt className="text-zinc-500">证书指纹</dt>
          <dd className="break-all text-zinc-100" title={fingerprint ?? undefined}>
            {fingerprintShort}
          </dd>
          <dt className="text-zinc-500">UDP 发现端口</dt>
          <dd className="text-zinc-100">{store.udpPort > 0 ? store.udpPort : "未监听"}</dd>
        </dl>
      </section>
    </div>
  );
}
