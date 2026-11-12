/** 传输页：transfer_list 重建 + transfer-progress/done 实时更新。 */

import { TransferCard } from "../components/TransferCard";
import type { PluginStore } from "../hooks/usePollEvents";

export function TransfersPage({ store }: { store: PluginStore }) {
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

  if (store.transfers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
        暂无传输记录
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {store.transfers.map((record) => (
        <TransferCard
          key={record.sessionId}
          record={record}
          progress={store.progress[record.sessionId]}
        />
      ))}
    </div>
  );
}
