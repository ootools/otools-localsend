import { useEffect, useState } from "react";
import { getSettings, type Settings } from "./api";

type TabId = "devices" | "transfers" | "settings";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "devices", label: "设备" },
  { id: "transfers", label: "传输" },
  { id: "settings", label: "设置" },
];

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 设置页预览 — Task 10 的桥接证明：settings_get 成功即 native 桥通。
 * Task 11 会重写为完整设置表单（alias/port/downloadDir/pin/... → settings_set）。
 */
function SettingsPreview() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((loaded) => {
        if (!alive) return;
        setSettings(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        // 浏览器直跑（无宿主注入）时 SDK invoke 抛错 —— 降级为占位而不是崩溃。
        setError(formatError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <p className="text-sm text-zinc-500" role="status">
        正在读取设置…
      </p>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm"
        role="alert"
      >
        <p className="font-medium text-zinc-200">宿主未注入</p>
        <p className="mt-1 text-zinc-500">
          未检测到 OTools 宿主桥接，仅作本地预览占位：{error}
        </p>
      </div>
    );
  }

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-zinc-500">别名</dt>
      <dd className="text-zinc-100">{settings?.alias}</dd>
      <dt className="text-zinc-500">端口</dt>
      <dd className="text-zinc-100">{settings?.port}</dd>
      <dt className="text-zinc-500">设备类型</dt>
      <dd className="text-zinc-100">{settings?.deviceType}</dd>
      <dt className="text-zinc-500">自动保存</dt>
      <dd className="text-zinc-100">{settings?.autoSave ? "开" : "关"}</dd>
      <dt className="text-zinc-500">接收通知</dt>
      <dd className="text-zinc-100">{settings?.notifyOnIncoming ? "开" : "关"}</dd>
    </dl>
  );
}

function TabPlaceholder({ label }: { label: string }) {
  return (
    <p className="text-sm text-zinc-500">{label}页占位 — Task 11 实现。</p>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>("settings");

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {/* 顶部状态条占位：Task 11 用 server-status 事件驱动（含端口回退与
          防火墙错误态）。 */}
      <header className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2 text-sm">
        <span className="inline-block h-2 w-2 rounded-full bg-zinc-600" />
        <span className="text-zinc-500">
          服务状态条占位（Task 11 接入 server-status）
        </span>
      </header>

      <nav className="flex gap-1 border-b border-zinc-800 bg-zinc-900 px-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={
              tab === entry.id
                ? "border-b-2 border-sky-500 px-3 py-2 text-sm font-medium text-zinc-100"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300"
            }
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-4">
        {tab === "devices" && <TabPlaceholder label="设备" />}
        {tab === "transfers" && <TabPlaceholder label="传输" />}
        {tab === "settings" && <SettingsPreview />}
      </main>
    </div>
  );
}
