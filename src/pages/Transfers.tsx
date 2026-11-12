/** 传输页：transfer_list 重建 + transfer-progress/done 实时更新。 */

import { TransferCard } from "../components/TransferCard";
import type { PluginStore } from "../hooks/usePollEvents";

export function TransfersPage({ store }: { store: PluginStore }) {
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

  if (store.transfers.length === 0) {
    return <div className="empty">暂无传输记录</div>;
  }

  return (
    <div className="xfer-list">
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
