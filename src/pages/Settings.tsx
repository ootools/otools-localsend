/**
 * 设置页：全字段表单 → settings_set 整体替换；下方展示生效中的服务状态
 * （实际绑定端口/协议/指纹 + UDP 发现端口）。宿主未注入时降级占位。
 */

import { useEffect, useState } from "react";
import { pickDirectory } from "otools-plugin-sdk/dialog";
import { isPreviewMode, setSettings, type Settings } from "../api";
import { ServiceControls } from "../components/ServiceControls";
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

export function SettingsPage({ store }: { store: PluginStore }) {
  const [draft, setDraft] = useState<Draft | null>(() => store.settings ? draftFrom(store.settings) : null);
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
      const dir = isPreviewMode() ? "D:\\Downloads" : await pickDirectory({ title: "选择下载目录" });
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

  const server = store.server;
  const fingerprint = server?.fingerprint ?? null;
  const fingerprintShort = fingerprint
    ? `${fingerprint.slice(0, 16)}…${fingerprint.slice(-8)}`
    : "—";

  const serviceCard = (
    <section className="card set-card">
      <h3>服务状态（生效中）</h3>
      <ServiceControls store={store} />
      <dl className="kv service-kv">
        <dt>服务端口</dt>
        <dd>{server ? (server.port > 0 ? server.port : "未绑定") : "—"}</dd>
        <dt>协议</dt>
        <dd>{server?.protocol ?? "—"}</dd>
        <dt>证书指纹</dt>
        <dd title={fingerprint ?? undefined}>{fingerprintShort}</dd>
        <dt>UDP 发现端口</dt>
        <dd>{server ? (server.udpPort > 0 ? server.udpPort : "未监听") : "—"}</dd>
      </dl>
    </section>
  );

  if (store.hostError) {
    return (
      <div className="settings">
        <div className="banner banner-warn" role="alert">
          <span><b>宿主未注入</b> — 未检测到 OTools 宿主桥接，仅作本地预览占位：{store.hostError}</span>
        </div>
        {serviceCard}
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="settings">
        <p className="xfer-meta" role="status">{store.ready ? "设置不可用" : "正在读取设置…"}</p>
        {serviceCard}
      </div>
    );
  }

  return (
    <div className="settings">
      <section className="card set-card">
        <h3>本机</h3>
        <div className="set-grid">
          <label className="field-label">
            别名
            <input
              type="text"
              value={draft.alias}
              onChange={(event) => setDraft({ ...draft, alias: event.target.value })}
              className="field"
            />
          </label>
          <div className="set-cols">
            <label className="field-label">
              设备型号（可选）
              <input
                type="text"
                value={draft.deviceModel}
                onChange={(event) => setDraft({ ...draft, deviceModel: event.target.value })}
                placeholder="如 Windows 11"
                className="field"
              />
            </label>
            <label className="field-label">
              设备类型
              <select
                value={draft.deviceType}
                onChange={(event) => setDraft({ ...draft, deviceType: event.target.value })}
                className="field"
              >
                {DEVICE_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field-label">
            端口（保存后重新启动服务生效）
            <input
              type="number"
              min={1024}
              max={65535}
              value={draft.port}
              onChange={(event) => setDraft({ ...draft, port: event.target.value })}
              className="field"
            />
          </label>
          <label className="field-label">
            下载目录（留空则保存在插件数据目录）
            <span className="send-row" style={{ flexWrap: "nowrap" }}>
              <input
                type="text"
                value={draft.downloadDir}
                onChange={(event) => setDraft({ ...draft, downloadDir: event.target.value })}
                placeholder="如 D:\\Downloads"
                className="field"
              />
              <button
                type="button"
                onClick={() => void pickDownloadDir()}
                className="btn btn-sm"
                style={{ flex: "none" }}
              >
                选择目录
              </button>
            </span>
          </label>
          <label className="field-label">
            PIN（可选，接收时校验）
            <input
              type="text"
              value={draft.pin}
              onChange={(event) => setDraft({ ...draft, pin: event.target.value })}
              placeholder="留空则不校验"
              className="field"
            />
          </label>
          <label className="set-check">
            <input
              type="checkbox"
              checked={draft.autoSave}
              onChange={(event) => setDraft({ ...draft, autoSave: event.target.checked })}
            />
            自动保存（免确认直接接收）
          </label>
          <label className="set-check">
            <input
              type="checkbox"
              checked={draft.notifyOnIncoming}
              onChange={(event) => setDraft({ ...draft, notifyOnIncoming: event.target.checked })}
            />
            面板隐藏时弹出传输请求通知
          </label>
        </div>

        {error && (
          <div className="banner banner-error" style={{ marginTop: 12, marginBottom: 0 }} role="alert">
            <span aria-hidden>⚠️</span>
            <span>{error}</span>
          </div>
        )}
        <div className="set-save">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="btn btn-primary btn-sm"
          >
            {busy ? "保存中…" : "保存设置"}
          </button>
          {saved && (
            <span className="save-ok" role="status">
              ✓ 已保存
            </span>
          )}
        </div>
      </section>

      {serviceCard}
    </div>
  );
}
